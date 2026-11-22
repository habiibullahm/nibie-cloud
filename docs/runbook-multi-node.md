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
   [the control-plane overlay](../deploy/compose.fleet.yaml). A configured remote node registers
   cordoned. Confirm `GET /api/v1/runtime-nodes` on the loopback operator API reports both nodes online.
   Inspect existing open invoices and invitations when turning the feature on. Previously created
   invoices have no node hold until replay and can still be fulfilled when capacity exists.
3. Open the new node with `POST /api/v1/runtime-nodes/<name>/schedulable` and body
   `{"schedulable":true}`. Exercise one internal instance before increasing stock. Post
   `{"schedulable":false}` to stop new placements while keeping existing operations routed correctly.
   A timed-out agent is excluded from placement even if it is enabled.
4. Keep the fleet-aware backend active until the last remote instance and its reservations have been
   evacuated. Rollback to an older backend requires all live instances to be on its local node.

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
