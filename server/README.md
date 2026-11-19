# server/ — the Go backend (port in progress)

The Go port of the Hermes Cloud backend. It is built next to the Node backend (`src/`), which still runs in production, and
replaces it in one deploy at milestone M8. Design and reasons: [spec](../docs/superpowers/specs/2026-11-19-backend-go-port-design.md).
Milestone plans: `docs/superpowers/plans/2026-11-19-go-port-*.md`.

**Status: M1 (Docker runtime) on top of M0 (foundation).** Config, logging, database pool, migrations (goose + River),
`/healthz`, `/readyz` (database and docker), the container image, CI, and the tenant runtime: the Docker manager with the
Node hardening and the startup checks (OCI runtime, disk quota, egress canary, runsc DNS). No product route yet: no operator,
customer or admin API, no jobs. Nothing is deployed.

## Layout

| Path | What |
| --- | --- |
| `cmd/hermes-cloud` | The binary: `serve` (default), `migrate up\|baseline\|status`, `healthcheck` |
| `cmd/schemadump` | Dev tool: prints a schema as text (makes `testdata/golden/schema.txt`) |
| `internal/config` | Environment, with the same names and refusals as `src/config/env.ts` (golden-tested); `REDIS_URL` is ignored |
| `internal/shared/logger` | JSON logger with pino's redaction paths, `MaskIP`, request log line |
| `internal/db` | Pool from Prisma's `DATABASE_URL` (`?schema=` becomes `SET search_path`), `sqlcgen` (generated), `queries/` |
| `internal/db/migrate` | `migrate up`, `status`, `baseline` (adopts a Prisma-built database) |
| `internal/db/schemadump` | Schema as deterministic text, to compare Prisma and goose |
| `internal/jobs` | River client (job queue in Postgres) |
| `internal/http` | `/healthz`, `/readyz` |
| `internal/runtime` | The only code that talks to Docker: `Manager` and its Docker implementation, hardening, API key, image policy, volume quota, `config.yaml` model block, startup checks (golden-tested against `src/modules/runtime`) |
| `internal/shared/apperr` | Typed errors with Node's status, code and message |
| `internal/testutil/stubimage` | Test-only: builds `test/fixtures/hermes-stub`, runs commands in a container |
| `validation/runtimelive` | Live harness: the runtime manager against a real daemon and the official Hermes image |
| `migrations` | 00001–00017: verbatim copies of `prisma/migrations` (one per Prisma migration); the next version (00018): River's tables (`river.go`) |
| `testdata/golden` | Fixtures generated from the Node code; see its README |
| `TEST-MAP.md` | Every TypeScript test case and its Go counterpart or milestone |

## Commands

Go 1.27.4 (`go.mod`). On a machine without Go, run the same commands in the pinned image (`golang:1.27.4-bookworm@sha256:4fa7c968…`, the
digest is in `server/Dockerfile`) with the repository mounted and `-w /src/server`.

```bash
cd server
go vet ./... && go tool staticcheck ./... && go test ./...    # unit tests (what CI runs)

docker compose up -d postgres                                  # from the repository root
go test -tags integration -p 1 ./...                           # integration tests: Postgres on 127.0.0.1:5433
```

- Integration tests read `HERMES_TEST_DATABASE_URL` (default `postgresql://hermes:hermes_dev_only@127.0.0.1:5433/hermes_test`) and
  create and drop a fresh database `hermes_m0_<hex>` per test. `-p 1`: they share one database server.
- `HERMES_TEST_PRISMA_TEMPLATE=hermes_prisma_template` also runs the baseline test on a database Prisma itself built (how to make it:
  `testdata/golden/README.md`).
- sqlc needs cgo, so it runs from its pinned image:
  `docker run --rm -v "$PWD:/src" -w /src sqlc/sqlc:1.31.1@sha256:70f53171d27b2424e9358869975455a6e955a5aa8e58a998a270a6e34e525537 generate`
  (CI runs `diff`).
- Docker integration tests (`internal/runtime`, `cmd/hermes-cloud`) need a daemon (`DOCKER_HOST` or `/var/run/docker.sock`) and
  loopback access to published ports. In a container (Docker Desktop): `docker run --network host -v
  /var/run/docker.sock:/var/run/docker.sock ...`. They build `hermes-stub:0.2.0` from `test/fixtures/hermes-stub` when it is missing.
- Golden cases: `pnpm tsx server/testdata/golden/gen/config.ts --check` and `.../gen/runtime.ts --check` from the repository root.
- TEST-MAP: `python server/testdata/golden/gen/test-map.py --check`.
- Live harness: `go run ./validation/runtimelive` (same Docker access; pulls the official image).

## Migrations

```bash
DATABASE_URL=... hermes-cloud migrate status
DATABASE_URL=... hermes-cloud migrate up         # a new database: applies 1-18
DATABASE_URL=... hermes-cloud migrate baseline   # a Prisma-built database, once: records 1-17 as applied, then run `up`
```

`baseline` changes nothing and exits 1 unless `_prisma_migrations` lists exactly the 17 expected migrations, all finished and none rolled
back, and `goose_db_version` records no migration (goose's own version-0 row is fine, e.g. after `migrate status`). Never edit a migration that has run in production.

## Image

```bash
docker build -t hermes-cloud-backend-go server    # from the repository root
```

Distroless, non-root, one static binary (about 15 MB). The container healthcheck is `/hermes-cloud healthcheck`.
The Dockerfile lives in `server/`, not `deploy/`, on purpose: a change under `deploy/` makes
`ops/host/hermes-auto-deploy.sh` redeploy production, and the Go image must not touch production before M8.
