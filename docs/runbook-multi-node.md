# Runtime nodes

The control plane keeps Postgres, the queue and billing. Each runtime node owns its Docker daemon,
loopback Hermes gateway and XFS volumes. The control plane selects a node once and routes each operation
by the stored instance assignment. A disconnected node stops receiving placements. Its tenant data
stays on its own host until an operator performs recovery.

## Prepare a runtime VPS

1. Prepare Docker, cgroup v2, gVisor (`runsc`), XFS project quotas and the existing
   [egress rules](runbook-egress.md). Make Docker require the tenant volume mount at boot.
   Confirm a sized Docker volume really has a project quota. Docker CE 29.9.3 was used for
   staging because the Ubuntu Docker 29.1.3 build rejected the DNS file's volume subpath.
   Install `hermes-usage`,
   `hermes-volume-quota`, `hermes-tenant-backup` and `hermes-tenant-restore` on each node.
   Install `hermes-watchdog` (script and its `.service`/`.timer`) with `/etc/hermes-cloud/ops.env` (mode 600) holding
   only `OPS_TELEGRAM_BOT_TOKEN`, `OPS_TELEGRAM_CHAT_ID` and `OPS_ROLE=node`. In node mode it checks the runtime agent
   container, disk and tenant backups and skips readyz, the database dumps and the public API. Leave `OPS_HEARTBEAT_URL`
   unset there: a node's green heartbeat would hide a control-plane outage.
2. Supply and pre-pull both `HERMES_IMAGE` and the configured pinned canary image. The agent refuses
   to start unless Docker, runsc, disk quota, egress and the tenant DNS setup are ready. Pre-pulling
   `HERMES_IMAGE` avoids multi-minute pulls during a customer's first provision. Use the same backend
   image release on the controller and on the agent.
3. Bind the agent to a private IPv4 address or to loopback behind a persistent SSH tunnel. Give the
   controller a dedicated route. Keep Docker and the agent away from public listeners and tenant
   bridges. Use a CA dedicated to this runtime connection. Issue one server certificate with
   `serverAuth` and a SAN that matches the configured HTTPS origin, and one controller certificate
   with `clientAuth`. Put `ca.crt`, `tls.crt` and `tls.key` in the respective host directories.
   Keep the CA signing key offline. Store private keys with permissions readable only by the service.
   For the loopback example, run the tunnel as a persistent service on the control-plane host:
   `ssh -NT -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -L 127.0.0.1:19443:127.0.0.1:9443 <node-ssh-alias>`.
   Give its dedicated SSH identity permission to forward to the agent port only.
4. Install the agent env outside the checkout using [the example](../deploy/runtime-agent.env.example).
   Set `DOCKER_GID` to the numeric group of the host socket. Make the quota publication directory
   writable by the container's UID 1000. Keep the usage and backup metadata mounts read-only.
   Start the agent with [the agent Compose file](../deploy/compose.runtime-agent.yaml).
   Set `DESIRED_QUOTAS_FILE=/var/lib/hermes-quota-policy/desired.json` in the remote quota timer.

## Enable fleet mode

1. Back up the control-plane database and apply migrations. Use
   [the fleet manifest](../deploy/runtime-fleet.example.json) as a template. The local name and region
   must match the existing database row. Treat the budgets as allocatable capacity after host overhead.
   Set storage to fit the XFS mount and leave working space for backups. Review the measured peak use
   before raising limits. An allocated stopped instance keeps its reservation.
2. Mount the host-private manifest and controller TLS credentials with
   [the control-plane overlay](../deploy/compose.fleet.yaml). `ops/host/deploy.sh` adds the overlay by itself
   whenever `/etc/hermes-cloud/fleet/fleet.json` exists, so automatic deploys and rollbacks keep fleet mode.
   A configured remote node registers
   cordoned. Confirm `GET /api/v1/runtime-nodes` on the loopback operator API reports both nodes online.
   Inspect existing open invoices and invitations when turning the feature on. Previously created
   invoices have no node hold until replay and can still be fulfilled when capacity exists.
3. Open the new node with `POST /api/v1/runtime-nodes/<name>/schedulable` and body
   `{"schedulable":true}`. Exercise one internal instance before increasing stock. Post
   `{"schedulable":false}` to stop new placements while keeping existing operations routed correctly.
   A timed-out agent is excluded from placement even if it is enabled.
4. Keep the fleet-aware backend active until the last remote instance and its reservations have been
   evacuated. Rollback to an older backend requires all live instances to be on its local node.

## Capacity budgets

The scheduler adds up the full `cpuMillis`, `memoryMb` and `storageMb` of every plan placed on a node (live
instances, open reservations, staged recovery copies) and places only while each sum stays within the node's
budget. It does not look at real load. A plan's `cpuMillis` is a per-container ceiling, so a CPU budget of
about 2x the cores is reasonable while measured load stays low. RAM and disk are the real limits: keep RAM
below the host's memory minus host overhead, and disk below the XFS mount minus backup working space.
Production uses 2x cores for CPU since 2026-11-23.

## Resize a node (bigger VPS)

1. Resize the server at the provider. For more customer disk, grow the XFS volume mount on that host first.
2. On the control plane, back up the manifest and change the node's numbers:
   `sudo cp -p /etc/hermes-cloud/fleet/fleet.json /etc/hermes-cloud/fleet/fleet.json.bak-<date>`, then edit
   `cpuMillis`, `memoryMb` or `storageMb`. Never change `name` or `region`: they must match the database row,
   or the backend refuses to start.
3. Recreate the backend with the overlay and wait for `/readyz`:
   `sudo docker compose --env-file /etc/hermes-cloud/backend.env -f deploy/compose.prod.yaml -f deploy/compose.fleet.yaml up -d --no-build --force-recreate backend`
   (from `/opt/hermes-cloud`). Only the API restarts; tenant containers keep running. If it is not ready,
   restore the backup and recreate again.
4. Raise plan stock in the admin panel if the extra room should be sold.

## Add another runtime node

Do the steps in this order. Use a new node name (`jkt-3`, …) and a new local tunnel port (`19444`, …).

1. **Host.** Prepare the VPS as in "Prepare a runtime VPS" above. Install `hermes-usage`,
   `hermes-volume-quota`, `hermes-tenant-backup`, `hermes-tenant-restore` and `hermes-watchdog` (`OPS_ROLE=node`) from the
   release the control plane runs, pre-pull `HERMES_IMAGE` and `HERMES_CANARY_IMAGE` by the same digests as the control plane.
2. **Provider access.** At the new host's provider firewall, allow TCP 22 from the control plane's public
   address. Add the new host's public address to the IP allowlist of the R2 token that restic uses.
3. **Certificate.** On the machine that holds the runtime CA key, sign a server certificate for the node:
   ```bash
   openssl ecparam -name prime256v1 -genkey -noout -out <node>-server.key
   openssl req -new -key <node>-server.key -subj "/CN=<node>" -out <node>-server.csr
   printf "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature\nbasicConstraints=CA:FALSE\n" > srv.ext
   openssl x509 -req -in <node>-server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 365 -sha256 -extfile srv.ext -out <node>-server.crt
   ```
   Install `ca.crt`, the server certificate as `tls.crt` and its key as `tls.key` in
   `/etc/hermes-cloud/agent-tls/` on the node (owner uid 1000, key mode 600). The control plane's existing client
   certificate works for every node because all agents trust the same CA: copy
   `/etc/hermes-cloud/fleet/<existing-node>/` to `/etc/hermes-cloud/fleet/<node>/` on the control plane.
4. **Agent image.** Copy the backend image the control plane runs:
   `ssh <control-plane> 'sudo docker save hermes-cloud-backend:<tag> | gzip -1' | ssh <node> 'gunzip | sudo docker load'`.
5. **Agent.** On the node, write `/etc/hermes-cloud/runtime-agent.env` from
   [the example](../deploy/runtime-agent.env.example): `HERMES_BACKEND_IMAGE=hermes-cloud-backend:<tag>`,
   `HERMES_AGENT_NAME=<node>`, `DOCKER_GID` from `stat -c %g /var/run/docker.sock`, the control plane's
   `HERMES_CANARY_IMAGE` and `HERMES_DNS_RESOLVERS`, and `HERMES_CANARY_PRIVATE_IP` set to the node's own private
   address. Create `/var/lib/hermes-quota-policy` owned by uid 1000. Copy
   [the agent Compose file](../deploy/compose.runtime-agent.yaml) to `/opt/hermes-cloud/deploy/` and run
   `sudo docker compose --env-file /etc/hermes-cloud/runtime-agent.env -f compose.runtime-agent.yaml up -d`.
   The log must end with `runtime agent ready`; otherwise it names the failed host check.
6. **Node timers.** Install the backup, verify and quota units and timers, with drop-ins
   (`/etc/systemd/system/<unit>.service.d/fleet.conf`): `hermes-tenant-backup` and `hermes-tenant-verify` get
   `RESTIC_RETENTION_MODE=fleet`, `RESTIC_BACKUP_HOST=<node>` and
   `DESIRED_QUOTAS_FILE=/var/lib/hermes-quota-policy/desired.json`; `hermes-volume-quota` gets the same
   `DESIRED_QUOTAS_FILE`. Copy `/etc/restic/r2/env` and `/etc/restic/r2/password` from the control plane (root,
   mode 600) and check `restic cat config` works from the node.
7. **Tunnel.** On the control plane, make a dedicated key (`ssh-keygen -t ed25519 -f ~/.ssh/hermes_fleet_<node>`),
   add it to the node's `~/.ssh/authorized_keys` as
   `restrict,port-forwarding,permitopen="127.0.0.1:9443",command="/usr/bin/false" <public key>`, pin the node's
   host key in a known-hosts file, and add a systemd unit `hermes-fleet-tunnel-<node>.service` like the existing
   one, forwarding `127.0.0.1:<local port>` to the node's `127.0.0.1:9443` with `Restart=always`. Enable it and
   check from the control plane:
   `curl --cacert ca.crt --cert tls.crt --key tls.key -d '{"op":"ready"}' -H 'content-type: application/json' https://127.0.0.1:<local port>/v1/runtime`
   (in `/etc/hermes-cloud/fleet/<node>/`) answers `200` with the node's name.
8. **Manifest.** Back up the database (`sudo /usr/local/sbin/hermes-db-backup`) and the manifest, add an entry
   to `remote` with the node's name, region, budgets, `"origin": "https://127.0.0.1:<local port>"` and
   `"tlsDir": "/etc/hermes-cloud/fleet/<node>"`, then recreate the backend as in "Resize a node". The node
   registers cordoned; `GET /api/v1/runtime-nodes` must show it online.
9. **Test, then open.** Open the node (`POST /api/v1/runtime-nodes/<node>/schedulable` with
   `{"schedulable":true}`), cordon the other nodes for a moment, create one internal instance through the
   operator API, uncordon the other nodes immediately after the create call returns, and check the container
   on the node (`runsc`, read-only rootfs, XFS quota, ACTIVE). Delete it and check the container, volume and
   network are gone.
10. Record the change in `docs/CURRENT_STATE.md`. Keep host addresses out of the repository.

## After each backend release

Automatic deploys update only the control plane. When a release changes the runtime or the agent protocol,
copy the new image to every node (step 4 above), set `HERMES_BACKEND_IMAGE` in
`/etc/hermes-cloud/runtime-agent.env` and recreate the agent with the same Compose command. Use the same release
on the control plane and on the agents.

## Backup and restore

Use the same encrypted Restic repository across the fleet. Set `RESTIC_RETENTION_MODE=fleet` and one
distinct `RESTIC_BACKUP_HOST` on each node's backup and verification timers. Remote timers also need
`DESIRED_QUOTAS_FILE` as above. Backups use current node assignments so an old copy on a source host
cannot supersede a recovered instance. Stale assignments stop a remote backup instead of guessing.
The control plane enables `hermes-tenant-retention.timer` to run `hermes-tenant-backup --retention`
separately, after the upload window, with
access to the loopback operator API. It uses the database's fleet-wide instance list and retains
the last snapshot for each live instance, including those on a disconnected host.

An operator can recover the **same** instance and subscription after fencing the source. Schedule
downtime and confirm the latest usable snapshot before starting.

1. Stop the source instance through the operator API. If the source is unavailable, power it off or
   isolate it from Telegram and all external traffic at the provider level before using
   `"sourceFenced":true`. Keep the fence until the old runtime is retired. This avoids two active
   processes polling the same Telegram bot.
2. Post to `/api/v1/tenants/<tenant>/instances/<instance>/recovery/prepare` with
   `{"node":"jkt-2","sourceFenced":false}` (or `true` for a fenced host). The API reserves
   capacity and prepares a stopped copy. A failed preparation can be retried with the same node.
3. On the destination, run `hermes-tenant-restore --offline <snapshot> <instance> <tenant> <instance>`
   as root. It checks the snapshot's instance tag and SQLite integrity before copying data.
4. Post `{"restoreVerified":true,"sourceFenced":false}` to the same instance's
   `/recovery/finish` path. Use the same fence semantics as above. Start the instance via the normal
   API if its subscription allows it. Verify authenticated health, session data and the intended
   integration settings. Measure RTO and snapshot age at each drill. POST
   `{"node":"<old-node>","discardSource":true}` to `/recovery/retire` once the old copy can be safely
   discarded. The old disk remains allocated until the recorded copy has been removed.
5. To abandon a staged recovery while the original stopped volume is still available, post
   `{"discardTarget":true}` to `/recovery/cancel`. That discards the staged copy and releases its
   capacity reservation.
