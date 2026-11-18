# server/ — the Go backend (port in progress)

The Go port of the Hermes Cloud backend. It is built next to the Node backend (`src/`), which still runs in production, and
replaces it in one deploy at milestone M8. Design and reasons: [spec](../docs/superpowers/specs/2026-11-19-backend-go-port-design.md).
Milestone plans: `docs/superpowers/plans/2026-11-19-go-port-*.md`.

**Status: M0 (foundation).** Config, logging, database pool, migrations (goose + River), `/healthz`, `/readyz`, the
container image and CI. No product route yet: no operator, customer or admin API, no Docker runtime, no jobs. Nothing is
deployed.

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
| `migrations` | 00001–00017: verbatim copies of `prisma/migrations` (one per Prisma migration); the next version (00018): River's tables (`river.go`) |
| `testdata/golden` | Fixtures generated from the Node code; see its README |
| `TEST-MAP.md` | Every TypeScript test case and its Go counterpart or milestone |

## Commands

Go 1.27.4 (`go.mod`). On a machine without Go, run the same commands in the pinned image (`golang:1.27.4-bookworm@sha256:4fa7c968…`, the
digest is in `deploy/Dockerfile.go`) with the repository mounted and `-w /src/server`.

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
- Golden config cases: `pnpm tsx server/testdata/golden/gen/config.ts --check` from the repository root.

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
docker build -f deploy/Dockerfile.go -t hermes-cloud-backend-go .    # from the repository root
```

Distroless, non-root, one static binary (about 15 MB). The container healthcheck is `/hermes-cloud healthcheck`.
