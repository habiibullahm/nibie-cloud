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

## Operator API (development only)

Do **not** expose this API publicly: it has a single shared bearer token and no customer auth.
It listens on loopback only; reach it through an SSH tunnel if needed.

```bash
H="Authorization: Bearer $ADMIN_TOKEN"
curl -H "$H" -H "Idempotency-Key: $(uuidgen)" -H 'content-type: application/json' \
  -d '{"name":"my agent","planId":"<plan-uuid>"}' \
  http://127.0.0.1:3000/api/v1/tenants/<tenant-uuid>/instances
# GET  /api/v1/tenants/:t/instances[/:i[/status|/events]]
# POST /api/v1/tenants/:t/instances/:i/{start,stop,restart}      DELETE /api/v1/tenants/:t/instances/:i
```

There is no endpoint to create tenants/plans/nodes yet; seed rows directly (see `scripts/demo.ts`).

## Sandboxes and CI without a Docker service

If the daemon is not running, start it in the background (`dockerd &`) and wait for
`docker info` to succeed. Docker Hub rate limits (HTTP 429) can block pulls; the stub image is
built from a digest-pinned `alpine` layer that is usually already cached.

## Using the real Hermes image

Not yet validated. Before pointing `HERMES_IMAGE` at it, check the image contract in
[architecture.md](architecture.md#image-contract), then run `pnpm test` with `HERMES_IMAGE`
overridden in a dedicated test pass.
