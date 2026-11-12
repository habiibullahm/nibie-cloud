# Setup

## Prerequisites

- Node.js 22+, pnpm 10
- A **Linux Docker daemon** reachable at `/var/run/docker.sock` (Docker Engine, or Docker Desktop with Linux containers)
- PostgreSQL 16 (provided by `compose.yaml`)

## First run

```bash
pnpm install                          # also runs `prisma generate`
docker compose up -d postgres         # 127.0.0.1:5433, dev credentials only
cp .env.example .env                  # git-ignored; set ADMIN_TOKEN (>= 24 chars): openssl rand -hex 24
pnpm db:migrate                       # applies prisma/migrations to DATABASE_URL
```

Tests use a separate database:

```bash
docker exec hermes-cloud-postgres-1 psql -U hermes -d hermes -c "CREATE DATABASE hermes_test"
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
| `HERMES_RUNTIME` | `runc` (default) or `runsc` (gVisor). With `runsc`, startup fails if the Docker daemon does not list that runtime. Applies only to containers created from now on |

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
