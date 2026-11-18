# Golden fixtures

Files here record what the Node backend (`src/`) does with fixed inputs. The Go tests must reproduce them exactly.
That is how the Go port proves it behaves like Node (spec: `docs/superpowers/specs/2026-11-19-backend-go-port-design.md`,
section 4).

| File | Made by | Checked by |
| --- | --- | --- |
| `config-cases.json`, `config.golden.json` | `gen/config.ts` (Node `loadConfig`) | `internal/config/parity_test.go` |
| `schema.txt` | `cmd/schemadump` against a Prisma-migrated database | `internal/db/schemadump` integration test |
| `runtime.golden.json` | `gen/runtime.ts` (Node `src/modules/runtime`: names, API key, Docker request bodies, image policy, volume quota, log demux, tar, config.yaml model block, canary and DNS seed containers) | `internal/runtime` tests |

## Rules

- Regenerate a fixture only when the Node behaviour changes on purpose, and in the same change as that behaviour.
- Every value is fake (`example.test`, RFC 5737 addresses, repeated letters). The repository is public.
- The generators under `gen/` are dev tools, not backend code. They are deleted in milestone M9, when `src/` goes away.
  The fixtures stay.

## Schema

`schema.txt` is the Prisma-built schema, dumped by `cmd/schemadump`. To regenerate it (dev Postgres from
`docker compose up -d postgres`, from the repository root):

```bash
docker compose exec -T postgres psql -U hermes -d hermes -c "DROP DATABASE IF EXISTS hermes_prisma_template" -c "CREATE DATABASE hermes_prisma_template"
DATABASE_URL=postgresql://hermes:hermes_dev_only@127.0.0.1:5433/hermes_prisma_template pnpm db:migrate
cd server && go run ./cmd/schemadump -url postgresql://hermes:hermes_dev_only@127.0.0.1:5433/hermes_prisma_template -schema public > testdata/golden/schema.txt
```

Keep `hermes_prisma_template` afterwards: `internal/db/migrate`'s baseline test copies it when
`HERMES_TEST_PRISMA_TEMPLATE=hermes_prisma_template` is set.

## Config cases

From the repository root, after `pnpm install`:

```bash
pnpm tsx server/testdata/golden/gen/config.ts           # write both files
pnpm tsx server/testdata/golden/gen/config.ts --check   # exit 1 if either file is stale
pnpm tsx server/testdata/golden/gen/runtime.ts --check  # the same for runtime.golden.json
```
