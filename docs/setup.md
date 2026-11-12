# Setup

## Prerequisites

- Node.js 22+, pnpm 10
- A **Linux Docker daemon** reachable at `/var/run/docker.sock` (Docker Engine, or Docker Desktop with Linux containers)
- PostgreSQL 16 (provided by `compose.yaml`)
- For production-like runs with `HERMES_DISK_QUOTA=enforce` (the default): Docker's data root on **XFS mounted with project quotas** (see below)

## First run

```bash
pnpm install                          # also runs `prisma generate`
docker compose up -d postgres         # 127.0.0.1:5433, dev credentials only
cp .env.example .env                  # git-ignored; set ADMIN_TOKEN (>= 24 chars): openssl rand -hex 24
                                      # and HERMES_MASTER_KEY (>= 32 chars): openssl rand -hex 32
pnpm db:migrate                       # applies prisma/migrations to DATABASE_URL
```

Tests use a separate database:

```bash
docker compose exec postgres psql -U hermes -d hermes -c "CREATE DATABASE hermes_test"
DATABASE_URL=postgresql://hermes:hermes_dev_only@127.0.0.1:5433/hermes_test pnpm db:migrate
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm build` | Type-check (no emit) |
| `pnpm test:unit` | Pure logic tests (no Docker/DB) |
| `pnpm test:integration` | Real Postgres + real Docker (builds the stub image on first run) |
| `pnpm test` | Everything. Integration tests clean up the containers/volumes/networks they create |
| `pnpm demo [--keep]` | End-to-end proof run through the API using the stub image |
| `pnpm dev` | Starts the operator API on `127.0.0.1:$PORT` and the reconciler (15 s loop) |

## Configuration

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `HERMES_IMAGE` | Pinned image. Tag != `latest` in dev/test; `name@sha256:<digest>` required when `NODE_ENV=production`. Startup fails otherwise |
| `ADMIN_TOKEN` | Bearer token for the operator API (>= 24 chars). Never logged |
| `PORT` | Default 3000. The API always binds `127.0.0.1` |
| `DOCKER_SOCKET_PATH` | Default `/var/run/docker.sock` |
| `HERMES_MASTER_KEY` | Required, at least 32 characters (`openssl rand -hex 32`). Every instance's `API_SERVER_KEY` is derived from it (HMAC-SHA256 with the instance id); it is never stored or logged. Changing it makes running instances reject the new keys: the Reconciler marks them `DEGRADED` (`auth_rejected`) without restarting them, and they stay that way until their containers are recreated (see below) |
| `HERMES_DISK_QUOTA` | `enforce` (default) or `off`. `enforce` creates every tenant volume with `Plan.storageMb` as its size limit and refuses to run a volume that has none. `off` is rejected when `NODE_ENV=production` |
| `HERMES_DISK_CHECK_INTERVAL_MS` | Default `300000` (5 minutes), minimum `1000`. How often the DiskMonitor reads volume usage and records `disk.warning`, `disk.full` and `disk.ok` events |
| `HERMES_EGRESS_POLICY` | `enforce` (default) or `off`. `enforce` names every tenant bridge `hn<12 hex>`, refuses a network without that name (`network_policy_missing`) and runs the startup canary. `off` is rejected when `NODE_ENV=production` |
| `HERMES_CANARY_IMAGE` | Required when `HERMES_EGRESS_POLICY=enforce`: an image with `sh` and `nc`, pinned as `name@sha256:<64 hex>` (a tag is rejected). It is not pulled for you: `docker pull` it first |
| `HERMES_CANARY_PRIVATE_IP` | Optional IPv4 address of this host. If set, the canary also checks that a tenant cannot reach it |
| `HERMES_RUNTIME` | `runc` (default) or `runsc` (gVisor). With `runsc`, startup fails if the Docker daemon does not list that runtime. Applies only to containers created from now on |

## Disk quota host setup (XFS)

Tenant volumes are size-limited with XFS project quotas, so Docker's data root (default
`/var/lib/docker`) must live on an XFS filesystem mounted with `prjquota` (also written `pquota`).

1. Create or mount an XFS filesystem (a dedicated disk is simplest), with the `prjquota` mount option.
2. Point Docker's `data-root` at it (`/etc/docker/daemon.json`), stop Docker, move or recreate the data,
   and start Docker. Doing this on a host that already runs containers is disruptive.
3. Check: `findmnt -T /var/lib/docker -o TARGET,FSTYPE,OPTIONS` shows `xfs` and `prjquota`/`pquota`.
4. Start the control plane. With `HERMES_DISK_QUOTA=enforce` it creates and removes a small probe volume
   and exits with a message naming `HERMES_DISK_QUOTA` if Docker refuses the size option.

On a filesystem without quota support (for example ext4) Docker refuses to create a sized volume
(HTTP 400, "quota size requested but no quota support"). Use `HERMES_DISK_QUOTA=off` only for local
development and tests; it is rejected when `NODE_ENV=production`. What has and has not been checked
on a real host is in [disk-quota-host-notes.md](disk-quota-host-notes.md).

## Egress ruleset host setup

Tenant networks are filtered by one iptables chain that must be loaded on every runtime host
(`HERMES_EGRESS_POLICY=enforce` exits at startup if it is not). Steps (Debian or Ubuntu with
`iptables`; the unit assumes the repository is at `/opt/hermes-cloud`, adjust the paths otherwise):

1. `sudo install -d /etc/hermes-egress && sudo cp ops/egress/egress.conf.example /etc/hermes-egress/egress.conf`
2. Edit `RESOLVERS` (the upstream DNS servers Docker forwards to; a private resolver must be listed),
   leave `EXCEPTIONS` empty unless a single `ip:port` must stay reachable, and review `NEW_CONN_RATE`
   (a placeholder until measured).
3. Review without changing anything: `ops/egress/hermes-egress.sh apply --dry-run --config /etc/hermes-egress/egress.conf`
4. `sudo cp ops/egress/hermes-egress.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now hermes-egress.service`
   (after config changes use `systemctl reload hermes-egress.service`; the unit never removes the rules
   on stop or restart)
5. `sudo ops/egress/hermes-egress.sh status` must exit 0.
6. Pull the canary image by digest (it needs `sh` and a busybox-compatible `nc`, for example busybox;
   a build without `-z`/`-w`/`-l -p` is reported as `nc_unusable`), set `HERMES_CANARY_IMAGE` (and optionally `HERMES_CANARY_PRIVATE_IP`),
   and start the control plane.

What was and was not verified, and how to operate and debug the rules:
[egress-host-notes.md](egress-host-notes.md), [runbook-egress.md](runbook-egress.md). Existing tenant
networks created before this policy have no `hn` name and must be deleted and reprovisioned.

## Recreating an existing instance's container

A new `HERMES_MASTER_KEY` or `HERMES_RUNTIME` applies only to containers created after the change;
existing tenants keep their old key and runtime, including after a restart or crash recovery of the
same container. To move an instance, remove its container and keep the volume:
`docker rm -f hermes-<instance-id>`. The Reconciler then recreates it (same volume) with the current
key and runtime. There is no API for this yet.

## Operator API (development only)

Do **not** expose this API publicly: it has a single shared bearer token and no customer auth.
It listens on loopback only; reach it through an SSH tunnel if needed.

```bash
H="Authorization: Bearer $ADMIN_TOKEN"
curl -H "$H" -H "Idempotency-Key: $(uuidgen)" -H 'content-type: application/json' \
  -d '{"name":"my agent","planId":"<plan-uuid>"}' \
  http://127.0.0.1:3000/api/v1/tenants/<tenant-uuid>/instances
# Reusing an Idempotency-Key with a different name/planId -> 409. Unknown or malformed tenant/plan -> 404.
# Postgres unreachable -> 503 {error.code: database_unavailable}. Docker unreachable -> 503 runtime_unavailable.
# GET  /api/v1/tenants/:t/instances[/:i[/status|/events]]
# POST /api/v1/tenants/:t/instances/:i/{start,stop,restart}      DELETE /api/v1/tenants/:t/instances/:i
```

There is no endpoint to create tenants/plans/nodes yet; seed rows directly (see `scripts/demo.ts`).

## Sandboxes and CI without a Docker service

If the daemon is not running, start it in the background (`dockerd &`) and wait for
`docker info` to succeed. Docker Hub rate limits (HTTP 429) can block pulls; the stub image is
built from a digest-pinned `alpine` layer that is usually already cached. If the pull is still
rate-limited, point the build at a mirror of the same digest with
`HERMES_STUB_BASE=<mirror>/library/alpine@sha256:<same digest>` (read by `test/helpers/stub-image.ts`).

## Using the real Hermes image

The pinned official image is supported and was exercised by the live acceptance harness; see
[milestone-2-runtime-security.md](milestone-2-runtime-security.md) for what was and was not
verified. Point `HERMES_IMAGE` at `nousresearch/hermes-agent@sha256:276d44685c65c0cb2a25f190b63c65c8906f9dc76486fb1c05ae71b5826bda08`
(required form in production) and read the image contract in
[architecture.md](architecture.md#image-contract). To re-run the harness against the real image on
a Docker host: `pnpm tsx test/validation/runtime-manager-live.ts` (the runsc checks need a daemon
with gVisor installed).
