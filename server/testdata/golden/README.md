# Golden fixtures

Files here record what the Node backend (`src/`) does with fixed inputs. The Go tests must reproduce them exactly.
That is how the Go port proves it behaves like Node (spec: `docs/superpowers/specs/2026-11-19-backend-go-port-design.md`,
section 4).

| File | Made by | Checked by |
| --- | --- | --- |
| `config-cases.json`, `config.golden.json` | `gen/config.ts` (Node `loadConfig`) | `internal/config/parity_test.go` |
| `schema.txt` | `cmd/schemadump` against a Prisma-migrated database | `internal/db/schemadump` integration test |

## Rules

- Regenerate a fixture only when the Node behaviour changes on purpose, and in the same change as that behaviour.
- Every value is fake (`example.test`, RFC 5737 addresses, repeated letters). The repository is public.
- The generators under `gen/` are dev tools, not backend code. They are deleted in milestone M9, when `src/` goes away.
  The fixtures stay.

## Config cases

From the repository root, after `pnpm install`:

```bash
pnpm tsx server/testdata/golden/gen/config.ts           # write both files
pnpm tsx server/testdata/golden/gen/config.ts --check   # exit 1 if either file is stale
```
