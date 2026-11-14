# Production deployment on a single VPS

Files for running the backend on one Linux VPS with Docker Compose, without an
orchestrator: Redis, the backend and Caddy. First deployed and checked on 2026-11-13 with the build of
milestones A and B (`edb7d62`); see "Verified" and "Not verified" below. The operator API stays on loopback and is never forwarded publicly.

| File | What it is |
| --- | --- |
| `compose.prod.yaml` | Redis (AOF, `noeviction`, password, loopback port 6380), the backend (host network, Docker socket, no capabilities) and Caddy (host network) |
| `Dockerfile`, `Dockerfile.dockerignore` | Backend image (`node:22-bookworm-slim`, pnpm from the lockfile, runs `tsx src/main.ts` as `node`). The ignore file is an allowlist |
| `Caddyfile` | TLS (Let's Encrypt) and an allowlist of customer routes only: `/healthz`, `/api/v1/me`, `/api/v1/plans`, `/api/v1/instances[/*]` |
| `backend.env.example` | Variable names and how to generate each value. The real file lives outside the repository (`/etc/hermes-cloud/backend.env`, mode 600) |

## Order of work (host, then stack)

1. **Packages and clone.** Docker Engine with Compose, `jq`, the repository at `/opt/hermes-cloud`.
2. **Disk quota (required in production).** `NODE_ENV=production` forces `HERMES_DISK_QUOTA=enforce`, so Docker's
   volumes need XFS with project quotas. On an ext4-only VPS: create an XFS image
   (`fallocate -l 100G /srv/hermes-volumes.img && mkfs.xfs`), move `/var/lib/docker/volumes` aside, mount the
   image there with `loop,prjquota,nofail` in `/etc/fstab`, copy the old contents back, and add a Docker
   drop-in with `RequiresMountsFor=/var/lib/docker/volumes` so Docker never starts on an empty ext4 folder.
   Check with `findmnt -T /var/lib/docker/volumes` and a throwaway volume created with `--opt size=64m` that
   really stops a 100 MB write. Details: [../docs/disk-quota-host-notes.md](../docs/disk-quota-host-notes.md).
3. **Egress rules (required in production).** Install `ops/egress` (config, systemd unit, `hermes-egress.sh apply`)
   and pull a small canary image (`sh` and `nc`) pinned by digest. Details:
   [../docs/runbook-egress.md](../docs/runbook-egress.md).
4. **Images.** Pull the pinned Hermes image and the canary image first; the backend does not pull for you.
5. **Secrets.** Create `/etc/hermes-cloud/backend.env` from `backend.env.example`. Use letters and digits for
   passwords. The Supabase connection must be the **session pooler** (port 5432) when the VPS has no IPv6,
   with `?schema=hermes`.
6. **Database.** Create the `hermes` schema in Supabase, run `prisma migrate deploy` from the backend image
   (`docker compose run --rm --no-deps backend node_modules/.bin/prisma migrate deploy`), then insert one
   `RuntimeNode` and one active `Plan` (ids need `gen_random_uuid()`, there is no default). Enable row level
   security on the `hermes` tables and keep the schema out of Supabase's exposed schemas. No endpoint creates
   plans or nodes.
7. **Start.** Redis and the backend first, then Caddy once the DNS record exists. The record is DNS-only
   (grey cloud) so Caddy can obtain its own certificate; Cloudflare's free Universal SSL does not cover a
   two-level host such as `api.cloud.nibie.app`. Open only 22, 80 and 443 in the firewall.
8. **Boundary check from outside** (all 404): `/api/v1/tenants/x/instances`, `/api/v1/jobs/failed`, `/`,
   a `..` path and `/%2e%2e/...`; `/api/v1/plans` without a token is 401; a CORS preflight from any origin
   other than `DASHBOARD_ORIGIN` gets no `Access-Control-Allow-Origin`.

## Verified on 2026-11-13 (single VPS: Ubuntu 24.04, kernel 6.8, Docker 29.9, cgroup v2, `runc`)

- Image build, migrations on Supabase (session pooler), backend + Redis + Caddy up with a Let's Encrypt certificate.
- Boundary checks above, from the public internet.
- Real login with a Supabase access token, `POST /api/v1/instances` with the official Hermes image: `PENDING`,
  `PROVISIONING`, `STARTING`, `ACTIVE` in about 21 seconds, port published on `127.0.0.1` only.
- XFS project quota shown on the tenant volume (5 GiB hard limit). Egress rules rejected probes from the
  tenant bridge to `169.254.0.0/16`, `10.0.0.0/8` and `172.16.0.0/12` (counters rose) while the public
  internet stayed reachable.
- `DELETE /api/v1/instances/:id`: `DELETING` then `DELETED`; container, volume, `hermes-net-<uuid>` network and
  `hn<12 hex>` bridge were all gone.
- Reboot: the XFS mount, `hermes-egress.service`, Docker and all containers came back by themselves and
  `/healthz` answered 200.

Note that the Docker network is named `hermes-net-<uuid>`; `hn<12 hex>` is the **bridge interface** name
(`ip -br link | grep '^hn'`), which is what the egress rules match (`-i hn+`).

## gVisor (`HERMES_RUNTIME=runsc`) verified on 2026-11-14, including DNS

The pids-limit startup failure is fixed (PR #10). A first DNS fix (`HERMES_DNS_RESOLVERS` as Docker
`HostConfig.Dns`) was not enough: the tenant's own `/etc/resolv.conf` still pointed at Docker's
embedded resolver (`127.0.0.11`), unreachable from inside gVisor, even with `Dns` confirmed set. A
second fix (`HERMES_CANARY_IMAGE` seeds a dedicated Docker volume, `hermes-dns-resolv-conf`, with a
plain `resolv.conf`; every `runsc` tenant container bind-mounts that file over its own
`/etc/resolv.conf`, bypassing the embedded resolver entirely) was deployed and retested on `9d33abc`:
`/etc/resolv.conf` inside a real `runsc` tenant container read the explicit resolvers with no
`127.0.0.11`, `getent hosts` and Python `getaddrinfo` both resolved a public hostname, and `curl`
reached `https://example.com` and `https://api.telegram.org`, including after a restart and a
stop/start. The full lifecycle (create, restart, stop/start, delete) also passed: correct
`Runtime`/`PidsLimit`/memory/CPU limits, the XFS quota, `HERMES-EGRESS` rejecting the metadata
address and a private range while the public internet stayed reachable, and a clean delete (the
shared `hermes-dns-resolv-conf` volume correctly survives a tenant delete). Switching production to
`runsc` is now the owner's decision, not blocked by DNS; see
[../docs/CURRENT_STATE.md](../docs/CURRENT_STATE.md).

## Not verified, do not claim it
- `xfs_quota` project ids of deleted volumes accumulate: two emptied entries stayed listed after their volumes
  were deleted.
- Backups: a daily `pg_dump` of the database runs on the VPS (see `docs/CURRENT_STATE.md`); a restore was not
  rehearsed, there is no off-host copy, and tenant volumes are not backed up.
- Redis AOF recovery after a crash, several backend replicas, a customer reaching their agent from the internet
  (`accessUrl` is still a loopback address), the dashboard against the customer API.
- Milestone C (secrets, providers, Telegram) was deployed later on 2026-11-13 (`95228b9`, `SECRETS_KEK` set, the
  new migration applied, canary and boundary checks passed), but no credential route was exercised there.
  Milestone D (Duitku POP billing) is not built.

## Pitfalls seen during the first deploy

- Database passwords containing `@ % ! $` break the URL, shell history expansion and Compose `env_file`
  interpolation. Use letters and digits.
- Mask secrets in logs with a greedy pattern that stops at the last `@`, not the first.
- `docker compose restart` does not re-read `env_file`; use `up -d --force-recreate backend` after editing it.
