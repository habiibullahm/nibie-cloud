# Go port M0 (foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (default) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Go backend's foundation, with everything later milestones stand on: config parity with Node, logging, the database pool, goose migrations matching the Prisma schema, River, health endpoints, the image and CI. No product behaviour is ported yet.

**Architecture:** A new Go module in `server/` next to the untouched Node backend in `src/`. Parity with Node is proven by golden fixtures that a small TypeScript dev script generates from the Node code; Go tests must reproduce them. The schema is proven identical by introspecting a Prisma-built database and a goose-built one.

**Tech Stack:** Go (latest stable at start), `pgx/v5` (+ `pgx/v5/stdlib`), `pressly/goose/v3` (Provider API), `riverqueue/river` + `riverdriver/riverpgxv5` + `riverdriver/riverdatabasesql`, `log/slog`, stdlib `net/http`, `staticcheck` (as a `go.mod` tool).

**Spec:** [docs/superpowers/specs/2026-11-19-backend-go-port-design.md](../specs/2026-11-19-backend-go-port-design.md). This plan is milestone M0 (spec section 6). M1–M9 each get their own plan after the previous one is merged.

## Global Constraints

- Work in a worktree on branch `claude/go-port-m0`, cut from `main`. The current checkout is shared, so don't use it.
- Commit, push and PR only on the owner's own words for this branch. No `Co-Authored-By` trailer and no "Generated with" line (owner's CLAUDE.md overrides the harness default).
- Module path: `github.com/habiibullahm/nibie-cloud/server`. `server/go.mod` carries both `go` and `toolchain` lines, set to the latest stable Go at the start. Base images are pinned by `@sha256:` digest.
- Dependencies: only those in the spec's library table, plus `pgx/v5/stdlib`, River's two drivers, `goose` and `staticcheck` (as a tool). Any other dependency needs a stated reason in the PR.
- `src/`, `prisma/`, `test/` and `deploy/compose.prod.yaml` are not modified in M0. The golden generator only imports `src/`.
- Env names are identical to `src/config/env.ts`. Errors name keys, never values. `REDIS_URL` is read and ignored with one warning, and it is not required in production. This is the only intended config difference.
- The process binds `127.0.0.1:$PORT` only.
- No real secret, host address or personal data goes into any file. Golden cases use obviously fake values (`test-…`, `example.test`, RFC 5737 / 3849 addresses). The repository is public.
- Integration tests carry `//go:build integration` and run with `go test -tags integration -p 1 ./...`. They need the compose Postgres (`docker compose up -d postgres`) and read `HERMES_TEST_DATABASE_URL`, defaulting to `postgresql://hermes:hermes_dev_only@127.0.0.1:5433/hermes_test`. Tests that need a fresh database create `hermes_m0_<random hex>` and drop it in `t.Cleanup`.
- Docs are written in English.

## Review Focus

1. **A production `DATABASE_URL` carrying Prisma-only parameters** (`schema`, `pgbouncer`, `connection_limit`, `pool_timeout`, `socket_timeout`, `statement_cache_size`, `sslaccept`). These must be stripped, their names (never values) logged, and the connection must still work. Pinned in Task 5.
2. **`migrate baseline` on a database that is not exactly "all 15 Prisma migrations applied"**: one missing, one rolled back, one unfinished, or a goose table that already has rows. It must refuse and change nothing. Pinned in Task 7.
3. **JavaScript-compatible parsing edge inputs**: `PORT=" 3000"`, `"0x10"`, `"1e3"`, `"3000.5"` and `""`; uppercase or default-port origins; unpadded base64 KEKs; leading-zero IPv4. Accept and refuse must match Node exactly. Pinned in Tasks 2–3.
4. **A `Config` value ending up in a log line or JSON** must never expose a secret. Pinned in Task 3.
5. **A readiness check that hangs, and SIGTERM during a request**: `/readyz` answers 503 within 3 s with names only, and the process exits cleanly with a 30 s hard cap. Pinned in Task 8.

---

### Task 1: Go module, command skeleton, CI job

**Files:**
- Create: `server/go.mod` (with `tool honnef.co/go/tools/cmd/staticcheck`, added by `go get -tool`), `server/go.sum`, `server/cmd/hermes-cloud/main.go`, `server/cmd/hermes-cloud/main_test.go`
- Modify: `.github/workflows/ci.yml` (add job `backend-go`)

**Interfaces:**
- Produces: `func run(args []string, stdout, stderr io.Writer) int` in `main.go`. `main` calls `os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))`. Subcommand names: `serve` (also the default when no args are given), `migrate up|baseline|status`, `healthcheck`. Tasks 7 and 8 fill these in. Until then each prints `not implemented` and returns 1.

- [ ] **Step 1: Write the failing test.** `TestRunUnknownCommand`: `run([]string{"nope"}, …)` returns `2` and stderr contains `usage: hermes-cloud [serve|migrate up|migrate baseline|migrate status|healthcheck]`. `TestRunMigrateNeedsAction`: `run([]string{"migrate"}, …)` returns `2`.
- [ ] **Step 2:** Run `cd server && go test ./cmd/...`. Expected: FAIL (no package).
- [ ] **Step 3:** Create the module and `run`.
- [ ] **Step 4:** Run `cd server && go vet ./... && go tool staticcheck ./... && go test ./...`. Expected: PASS, no findings.
- [ ] **Step 5:** Add the CI job `backend-go` (`ubuntu-latest`, `timeout-minutes: 10`, `working-directory: server`). Steps: `actions/checkout@v4`, `actions/setup-go@v5` with `go-version-file: server/go.mod`, then `go vet ./...`, `go tool staticcheck ./...` and `go test ./...` (unit only, matching the Node job, which also skips integration).
- [ ] **Step 6: Commit** `feat(server): add Go module, command skeleton and CI job`.

### Task 2: Golden fixture generator and config cases

**Files:**
- Create: `server/testdata/golden/gen/config.ts`, `server/testdata/golden/config-cases.json`, `server/testdata/golden/config.golden.json`, `server/testdata/golden/README.md`

**Interfaces:**
- Produces: `config-cases.json`, an array of `{ "name": string, "env": { [key: string]: string } }`. Names are unique kebab-case.
- Produces: `config.golden.json`, an object keyed by case name. The value is either `{ "ok": true, "config": <normalized Config> }` or `{ "ok": false, "keys": [sorted unique keys] }`.
  - Keys come from the message `Invalid configuration: A, B`.
  - Normalization: each `Buffer` becomes its base64 string, `undefined` is dropped (as `JSON.stringify` does), object keys are sorted.
- Command: from the repo root, `pnpm tsx server/testdata/golden/gen/config.ts` writes the golden file. With `--check` it exits 1 if the file would change.

- [ ] **Step 1: Write the cases.**
  - At least one case per `it(...)` in `test/unit/config.test.ts`. Use the same inputs, named after the test: 65 tests, and a test with several assertions gets several cases.
  - One accept and one refuse case per `superRefine` rule in `src/config/env.ts`.
  - These edge cases:
    - `PORT`: `" 3000"`, `"0x10"`, `"1e3"`, `"3000.5"`, `""`, `"+80"`
    - `SUPABASE_URL`: `https://A.supabase.co`, `https://a.supabase.co:443`, `https://a.supabase.co/`, `https://a.supabase.co/x`, `http://a.supabase.co`, `https://user@a.supabase.co`
    - `DASHBOARD_ORIGIN`: with a trailing slash, with `?q`, with `#f`
    - `SECRETS_KEK` padded (44 chars) and unpadded (43 chars), and 31/33 bytes
    - `HERMES_CANARY_PRIVATE_IP=01.2.3.4`
    - `HERMES_DNS_RESOLVERS="192.0.2.1, 192.0.2.2 198.51.100.1"`
    - `ADMIN_EMAILS=" A@Example.test ,b@example.test,"`
    - `MAX_INSTANCES_PER_TENANT=""` (empty means default)
    - an `OPS_TELEGRAM_*` half pair
    - `NODE_ENV=production`, otherwise complete, without `REDIS_URL`
    - `REDIS_URL=http://x`
  - Production cases that should be accepted include `REDIS_URL=redis://127.0.0.1:6380`, so Node accepts them.
- [ ] **Step 2:** Write `config.ts`. It imports `loadConfig` from `../../../../src/config/env.js`, runs each case with the case env only (not `process.env`), normalizes the result and writes the golden file.
- [ ] **Step 3:** Run `pnpm tsx server/testdata/golden/gen/config.ts && pnpm tsx server/testdata/golden/gen/config.ts --check`. Expected: the file is written, then `--check` exits 0. Confirm by inspection that the `production-without-redis` and `redis-url-not-redis` cases are `ok: false` with `keys: ["REDIS_URL"]`.
- [ ] **Step 4:** `README.md`: how to regenerate, the rule that golden files are regenerated only when Node behaviour changes on purpose, and that the generator is deleted in M9 while the fixtures stay.
- [ ] **Step 5: Commit** `test(server): add Node-generated config golden cases`.

### Task 3: `internal/config` with Node parity

**Files:**
- Create: `server/internal/config/config.go`, `server/internal/config/jscompat.go`, `server/internal/config/config_test.go`, `server/internal/config/parity_test.go`

**Interfaces:**
- Consumes: `server/testdata/golden/config-cases.json` and `config.golden.json` (Task 2).
- Produces:
  - `func Load(env map[string]string) (Config, error)` and `func FromEnviron() (Config, error)`. `FromEnviron` reads `os.Environ()`, and when `NODE_ENV` ≠ `production` it first loads `.env` from the working directory if one is present.
  - `type InvalidError struct{ Keys []string }`, with `Error()` returning `"Invalid configuration: " + strings.Join(Keys, ", ")`. Keys are in first-issue order.
  - `type Config struct` with one field per TS `Config` field except `redisUrl`, using Go names (`NodeEnv`, `DatabaseURL`, …, `Secrets *Secrets`, `Mail *Mail`, `Billing *Billing`, `Router *Router`, `Ops Ops`).
  - `type Kek struct{ Version int; Key []byte }`.
  - `Config.RedisURLIgnored bool` (true when `REDIS_URL` was set, so `serve` logs the one warning).
  - `func (Config) LogValue() slog.Value`, which returns only non-secret facts: `nodeEnv`, `port`, `runtime`, `diskQuota`, `egressPolicy`, plus booleans for `customerApi`, `secrets`, `mail`, `billing`, `router`, `alerts`.
- Helpers in `jscompat.go` (each mirrors a JS behaviour; the golden cases pin them):
  - `jsNumber(s string) (float64, bool)` mirrors `Number(s)`: trims JS whitespace, `""` → 0, accepts `0x`/`0o`/`0b`, exponent and sign, rejects anything else.
  - `exactOrigin(raw string, httpsOnly bool) bool` mirrors `new URL(raw).origin === raw`: http/https only, no userinfo, empty path, no query or fragment, host already lowercase, port not the scheme default.
  - `kek32(s string) ([]byte, bool)`: the regex `^[A-Za-z0-9+/]+={0,2}$`, then decode without regard to padding, then exactly 32 bytes.
  - `isIPv4(s string) bool`: `netip.ParseAddr`, `Is4()`, no zone. Leading zeros are refused, as in zod.

- [ ] **Step 1: Write the failing parity test.** `TestConfigMatchesNodeGolden` runs every case from the golden file:
  - If Node says `ok: true`: `Load` succeeds, and `parityJSON(cfg)` (a helper in `parity_test.go` only, so production code can never marshal a `Config`) deep-equals the Node `config` with `redisUrl` removed.
  - If Node says `ok: false`: let `want` = Node keys minus `"REDIS_URL"`. If `want` is empty, `Load` must succeed. Otherwise the error is `*InvalidError` and its sorted `Keys` equal `want`.
- [ ] **Step 2: Write the failing safety tests.**
  - `TestErrorsNeverEchoValues`: for every refused case, `err.Error()` contains no env value of 4 or more characters.
  - `TestLogValueHasNoSecrets`: log a fully configured `Config` with `slog` JSON. The output contains none of the case's secret values (`ADMIN_TOKEN`, `HERMES_MASTER_KEY`, KEKs, SMTP password, Duitku/SumoPod keys, webhook token/secret, router admin key, Telegram bot token, Turnstile secret).
  - `TestRedisURLIgnored`: with `REDIS_URL` set, `RedisURLIgnored` is true and nothing else changes.
- [ ] **Step 3:** Run `cd server && go test ./internal/config/`. Expected: FAIL.
- [ ] **Step 4:** Implement `Load`. Validate in the same order as `env.ts`: field checks in schema order, then the cross-field rules in `superRefine` order.
- [ ] **Step 5:** Run `cd server && go test ./internal/config/`. Expected: PASS for every case.
- [ ] **Step 6: Commit** `feat(server): config with Node parity`.

### Task 4: Logger, redaction, IP masking

**Files:**
- Create: `server/internal/shared/logger/logger.go`, `server/internal/shared/logger/ip.go`, `server/internal/shared/logger/logger_test.go`, `server/internal/shared/logger/ip_test.go`

**Interfaces:**
- Produces:
  - `func New(w io.Writer, level slog.Level) *slog.Logger`: JSON handler, `time` in RFC 3339 with milliseconds, string `level`, `msg`. Redaction runs in `ReplaceAttr`. `LOG_LEVEL` is parsed by `ParseLevel(s string) slog.Level`, defaulting to info.
  - `func MaskIP(ip string) string`: returns `""` for a non-IP.
  - `func RequestAttr(r *http.Request) slog.Attr`: group `req` with `method`, `url` (path without the query), `host`, `remoteAddress` (`MaskIP` of the address without its port).
- Redaction rule (port of `REDACT_PATHS`), with depth counted in groups:
  - value replaced by `[REDACTED]` for keys `adminToken` and `token` at depth 0;
  - keys `token`, `apiKey`, `password` and `secret` at depth 1;
  - every key inside a group named `env` at depth 0 or 1;
  - `authorization` inside `req.headers` or `headers`.

- [ ] **Step 1: Write the failing tests**, ported from `test/unit/logger.test.ts`:
  - `TestRedactsTokensKeysEnvAndAuthorization` uses the same inputs and expects `[REDACTED]` in the same places.
  - `TestMaskIP` is table-driven:
    - `203.0.113.7` → `203.0.113.0`
    - `2001:db8:1:2::5` → `2001:db8:1::`
    - `::ffff:198.51.100.9` → `198.51.100.0`
    - `fe80::1%eth0` → `fe80:0:0::`
    - `not-an-ip` → `""`
    - `""` → `""`
  - `TestRequestAttrDropsQueryAndPort`: `GET /api/v1/admin/customers?q=a@example.test` from `203.0.113.7:51234` logs `url` `/api/v1/admin/customers` and `remoteAddress` `203.0.113.0`, and the output contains neither `a@example.test` nor `51234`.
- [ ] **Step 2:** Run `cd server && go test ./internal/shared/logger/`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): JSON logger with redaction and IP masking`.

### Task 5: Database connection

**Files:**
- Create: `server/internal/db/db.go`, `server/internal/db/db_test.go`, `server/internal/db/db_integration_test.go`

**Interfaces:**
- Produces:
  - `func ParseURL(databaseURL string) (*pgxpool.Config, []string, error)`. It removes the Prisma-only query parameters (`schema`, `pgbouncer`, `connection_limit`, `pool_timeout`, `socket_timeout`, `statement_cache_size`, `sslaccept`) and returns their names, sorted. `schema=X` becomes runtime param `search_path=X`; without it, `search_path` is left unset. Other parameters (e.g. `sslmode`, `connect_timeout`) pass through.
  - `func Open(ctx context.Context, databaseURL string, maxConns int32, log *slog.Logger) (*pgxpool.Pool, error)`. It logs `db: ignored Prisma parameters` with the names when there are any, and pings once.
  - `const MaxConns int32 = 10`. The API and River share one pool. River's LISTEN connection counts against it, and so does the session pooler's per-client limit.
- Errors never include the URL or password.

- [ ] **Step 1: Write the failing unit tests** in `TestParseURL` (table):
  - `…/db?schema=hermes` → `search_path` `hermes`, stripped `[schema]`
  - `…/db?schema=hermes&pgbouncer=true&connection_limit=1&sslmode=require` → `search_path` `hermes`, `sslmode` kept, stripped `[connection_limit pgbouncer schema]`
  - `…/db` → no `search_path`, nothing stripped
  - a password with `%40` stays percent-decoded correctly
  - `not a url` → error whose text does not contain the input
- [ ] **Step 2: Write the failing integration test.** `TestOpenSetsSearchPath`: create schema `m0_probe` in a fresh database. `Open` with `?schema=m0_probe&pgbouncer=true`. `SELECT current_schema()` returns `m0_probe`.
- [ ] **Step 3:** Run `cd server && go test ./internal/db/` and `go test -tags integration -p 1 ./internal/db/`. Expected: FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Run both. Expected: PASS.
- [ ] **Step 6: Commit** `feat(server): pgx pool that understands Prisma's DATABASE_URL`.

### Task 6: goose migrations 00001–00015, the schema golden and sqlc

**Files:**
- Create: `server/migrations/00001_init.sql` … `server/migrations/00015_add_beta_invite.sql` (one per `prisma/migrations/<ts>_<name>/migration.sql`, in timestamp order, named `000NN_<name>.sql`), `server/migrations/migrations.go`
- Create: `server/internal/db/schemadump/schemadump.go`, `server/internal/db/schemadump/schemadump_integration_test.go`, `server/cmd/schemadump/main.go`, `server/testdata/golden/schema.txt`
- Create: `server/sqlc.yaml`, `server/internal/db/queries/health.sql`, `server/internal/db/sqlcgen/` (generated), `server/internal/db/queries_test.go`
- Modify: `.github/workflows/ci.yml` (job `backend-go`: add a `sqlc diff` step)

**Interfaces:**
- Produces:
  - `migrations.FS embed.FS` (`//go:embed *.sql`).
  - `func migrations.NewProvider(db *sql.DB) (*goose.Provider, error)`: goose Provider over `FS` with table `goose_db_version`. Task 7 adds Go migration 16 to it.
  - `sqlc.yaml`: engine `postgresql`, schema `migrations/`, queries `internal/db/queries/`, output package `sqlcgen` in `internal/db/sqlcgen`, `sql_package: pgx/v5`. sqlc needs cgo, so it runs from its pinned image: `docker run --rm -v "$PWD:/src" -w /src sqlc/sqlc:<version>@sha256:<digest> generate` (CI: `… diff`).
  - `health.sql`: `-- name: Ping :one` / `SELECT 1::int AS ok;`. Task 8's `database` check calls `sqlcgen.New(pool).Ping(ctx)`.
  - `func schemadump.Dump(ctx context.Context, pool *pgxpool.Pool, schema string) (string, error)`: deterministic text, sorted at every level. It covers:
    - enums with their labels in order;
    - tables with `relrowsecurity`;
    - columns (name, `format_type`, not null, default);
    - constraints (`pg_get_constraintdef`);
    - indexes (`pg_get_indexdef` with the schema name removed).
    - It excludes the tables `_prisma_migrations`, `goose_db_version` and everything starting with `river_`.
  - `cmd/schemadump`: `schemadump -url <DATABASE_URL> -schema <name>` prints `Dump` to stdout.
- Each SQL file is the Prisma file's content verbatim under `-- +goose Up`, with no `Down` section. None of the 15 files contains a `$$` body, so no `StatementBegin` is needed. Check that again when copying.

- [ ] **Step 1: Generate the golden.** Create a fresh database `hermes_m0_prisma`, run `DATABASE_URL=…/hermes_m0_prisma pnpm db:migrate` from the repo root, then `cd server && go run ./cmd/schemadump -url …/hermes_m0_prisma -schema public > testdata/golden/schema.txt`, then drop the database. Write these commands in `server/testdata/golden/README.md`.
- [ ] **Step 2: Write the failing test.** `TestGooseSchemaMatchesPrisma` (integration): on a fresh database, apply goose 00001–00015 through the Provider (Task 7 adds 00016; this test runs `UpTo(ctx, 15)`). `Dump(…, "public")` must equal `testdata/golden/schema.txt` exactly. On mismatch, print a line diff.
- [ ] **Step 3: Write the failing guard test** (spec section 3, the `@updatedAt` row). `TestUpdatesSetUpdatedAt` (unit): for every statement in `internal/db/queries/*.sql` that starts with `UPDATE "<Table>"`, where `<Table>` has an `updatedAt` column in `testdata/golden/schema.txt`, the statement's `SET` clause contains `"updatedAt"`. Include a fixture with a deliberately bad query in `testdata/queries-bad/`, so the test proves it can fail.
- [ ] **Step 4:** Run `cd server && go test -tags integration -p 1 ./internal/db/schemadump/ && go test ./internal/db/`. Expected: FAIL.
- [ ] **Step 5:** Copy the 15 migrations, write `Dump`, `NewProvider`, `sqlc.yaml` and `health.sql`, then run sqlc `generate`.
- [ ] **Step 6:** Run the step 4 commands plus sqlc `diff`. Expected: PASS, no diff.
- [ ] **Step 7: Commit** `feat(server): goose copies of the Prisma migrations, schema golden and sqlc`.

### Task 7: `migrate` subcommands, the River migration and a River smoke test

**Files:**
- Create: `server/migrations/00016_river.go`, `server/internal/db/migrate/migrate.go`, `server/internal/db/migrate/migrate_integration_test.go`, `server/internal/jobs/client.go`, `server/internal/jobs/client_integration_test.go`
- Modify: `server/cmd/hermes-cloud/main.go` (wire `migrate up|baseline|status`)

**Interfaces:**
- Consumes: `migrations.FS` (Task 6), `db.Open` (Task 5), `config.FromEnviron` (Task 3).
- Produces:
  - `const migrations.RiverMigrationTarget int`: the highest River migration version shipped by the pinned River release.
  - Go migration 16, registered in `migrations.NewProvider` (Task 6). It runs `rivermigrate` `MigrateTx` up to `RiverMigrationTarget` with `riverdatabasesql`. Its down migration migrates River down to 0.
  - `func migrate.Up(ctx, db *sql.DB, w io.Writer) error`.
  - `func migrate.Status(ctx, db *sql.DB, w io.Writer) error`.
  - `func migrate.Baseline(ctx, db *sql.DB, w io.Writer) error`. In one transaction it:
    1. requires that `_prisma_migrations` exists with exactly the 15 expected `migration_name`s, each with `finished_at` not null and `rolled_back_at` null, and no other rows;
    2. requires that `goose_db_version` is absent or empty;
    3. creates the goose table with goose's own DDL and records versions 0–15 as applied.
    If any check fails it returns an error naming the check, with no changes.
  - `func jobs.NewClient(pool *pgxpool.Pool, workers *river.Workers, pollOnly bool) (*river.Client[pgx.Tx], error)`: queue `default` with `MaxWorkers: 2`, `MaxAttempts: 5` (spec section 3). M2 adds the real workers.
- The `migrate` subcommands read `DATABASE_URL` only (not the full config), so they run inside `docker compose run` with the production env file.

- [ ] **Step 1: Write the failing tests** (integration, fresh database each):
  - `TestUpFromEmpty`: `Up` applies 1–16. `river_job` exists. `Status` lists 16 applied.
  - `TestBaselineThenUp`: build the database with `pnpm db:migrate` (Prisma; the test skips with a clear message if `pnpm` is not on PATH). `Baseline` succeeds. `Up` applies only 16. The schema `Dump` still equals the golden.
  - `TestBaselineRefuses` (table, Review Focus 2): one Prisma row deleted; one with `rolled_back_at` set; one with `finished_at` null; an extra unknown row; `goose_db_version` already holding a row. Each returns an error, and afterwards `goose_db_version` row count and `_prisma_migrations` contents are unchanged.
  - `TestBaselineTwice`: a second `Baseline` refuses (goose table not empty).
  - `TestRiverRunsJob`: with `pollOnly` false and then true, insert one job of a test kind. Its worker completes within 10 s and `river_job.state` is `completed`.
- [ ] **Step 2:** Run `cd server && go test -tags integration -p 1 ./internal/db/migrate/ ./internal/jobs/`. Expected: FAIL.
- [ ] **Step 3:** Implement and wire the subcommands. They exit 0 on success, 1 on error (error text on stderr, no URL).
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): migrate up/baseline/status and the River migration`.

### Task 8: HTTP server, `serve` and `healthcheck`

**Files:**
- Create: `server/internal/http/server.go`, `server/internal/http/readyz.go`, `server/internal/http/readyz_test.go`, `server/internal/http/server_test.go`, `server/cmd/hermes-cloud/serve.go`, `server/cmd/hermes-cloud/healthcheck.go`, `server/cmd/hermes-cloud/serve_integration_test.go`

**Interfaces:**
- Consumes: `config.FromEnviron`, `logger.New`/`RequestAttr`, `db.Open`, `jobs.NewClient`.
- Produces:
  - `type Check struct{ Name string; Fn func(context.Context) error }`.
  - `const ReadyzTimeout = 3 * time.Second`.
  - `func Readyz(checks []Check, timeout time.Duration) http.HandlerFunc`. It runs the checks in parallel. 200 `{"status":"ok"}`, or 503 `{"status":"fail","failed":[names in the order given]}`. Always `cache-control: no-store`. Never an error message in the body.
  - `type Deps struct{ Log *slog.Logger; Checks []Check }`.
  - `func NewHandler(d Deps) http.Handler`: `GET /healthz` → 200 `{"status":"ok"}`, `GET /readyz`, and one request log line per request via `RequestAttr`.
  - `func serve(ctx context.Context, cfg config.Config, stdout io.Writer) int`:
    - logs `cfg` (its `LogValue`), and the `REDIS_URL` warning when ignored;
    - opens the pool (`db.MaxConns`) and the River client (no workers yet, started);
    - registers check `database` (`sqlcgen.New(pool).Ping`);
    - listens on `127.0.0.1:<PORT>`.
    - On SIGINT/SIGTERM: `http.Server.Shutdown`, then River `Stop`, then pool close, with a hard exit 1 after 30 s.
    - M1 adds the `docker` check and the startup assertions.
  - `func healthcheck(port int) int`: `GET http://127.0.0.1:<port>/healthz` with a 5 s timeout. 0 on 200, else 1. `PORT` is read from env (default 3000) without loading the full config.

- [ ] **Step 1: Write the failing unit tests**, ported from `test/unit/readyz.test.ts`:
  - `TestReadyzOK`: all checks pass, and the empty list also gives 200 `{"status":"ok"}`.
  - `TestReadyzFailNamesOnly`: checks `database` (error `"password=hunter2"`) and `docker` (ok) give 503 `{"status":"fail","failed":["database"]}`, and the body does not contain `hunter2`.
  - `TestReadyzTimeout`: a check that blocks gives 503 within `timeout + 500ms` (test timeout 100 ms).
  - `TestHealthz`: 200 `{"status":"ok"}`.
  - `TestRequestLogLine`: one JSON line with `req.url` and no query string.
- [ ] **Step 2: Write the failing integration test.** `TestServeLifecycle` builds the binary, then starts `serve` with a valid test env (`PORT` = a free port, `NODE_ENV=test`, `HERMES_DISK_QUOTA=off`, `HERMES_EGRESS_POLICY=off`, test DB). Then:
  - `/readyz` gives 200 within 10 s, and `healthcheck` exits 0;
  - a TCP dial to the machine's non-loopback address on that port fails;
  - SIGTERM makes the process exit 0 within 5 s (skip the signal part on Windows with a clear message).
- [ ] **Step 3:** Run `cd server && go test ./internal/http/ ./cmd/... && go test -tags integration -p 1 ./cmd/...`. Expected: FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Run the same commands. Expected: PASS.
- [ ] **Step 6: Commit** `feat(server): health endpoints, serve and healthcheck`.

### Task 9: Container image

**Files:**
- Create: `deploy/Dockerfile.go`, `deploy/Dockerfile.go.dockerignore` (moved after M0 to `server/Dockerfile` and `server/.dockerignore`, so merging does not redeploy production)

**Interfaces:**
- Produces: image entrypoint `/hermes-cloud`, default command `serve`, user `nonroot`, `EXPOSE 3000`.
- Build stage: `golang:<pinned version>@sha256:<digest>`, `CGO_ENABLED=0`, `-trimpath -ldflags="-s -w"`.
- Final stage: `gcr.io/distroless/static-debian12:nonroot@sha256:<digest>`.
- The dockerignore is an allowlist: `**`, then `!server`, minus `server/testdata/golden/gen` (dev tool only).

- [ ] **Step 1:** Write both files.
- [ ] **Step 2:** Run `docker build -f deploy/Dockerfile.go -t hermes-cloud-backend-go:m0 .`. Expected: success.
- [ ] **Step 3:** Run `docker run --rm hermes-cloud-backend-go:m0 nope; echo $?` and expect `2` plus the usage line. Run `docker image inspect hermes-cloud-backend-go:m0 --format '{{.Size}}'` and record the size for the PR description.
- [ ] **Step 4:** Run the image with `--network host`, the test env and the compose Postgres. Then `docker exec <id> /hermes-cloud healthcheck` gives exit 0, and `docker stats --no-stream` gives a RAM figure, recorded for the PR description as an idle M0 baseline (not the final number).
- [ ] **Step 5: Commit** `build(server): distroless image for the Go backend`.

### Task 10: TEST-MAP, docs and the M0 gate

**Files:**
- Create: `server/TEST-MAP.md`, `server/README.md`
- Modify: `AGENTS.md` (packages table: one row for `server/`; Commands: a Go block), `docs/CURRENT_STATE.md` (Go port: M0 done, nothing deployed, measured image size and idle RAM)

**Interfaces:**
- `TEST-MAP.md` columns: `TS file`, `TS test name`, `Go test`, `Status` (`ported`, `golden`, `not ported: <reason>`, `later: M<n>`). M0 fills every row:
  - `test/unit/config.test.ts` (all `golden`, via the case names);
  - `logger.test.ts`, `readyz.test.ts` (`ported`);
  - all other TS test files as `later: M<n>`, by the module mapping in spec section 6.

- [ ] **Step 1:** Write `TEST-MAP.md`. Check it with `grep -c "| later: M" server/TEST-MAP.md` plus the count of other rows: the total must equal the TS test count, which is `rg -c "^\s*(it|test)\(" test | awk -F: '{s+=$2} END {print s}'` (866 at spec time; use the live count).
- [ ] **Step 2:** Write `server/README.md` (prerequisites, the unit and integration commands, golden regeneration, `migrate` usage, and the M0 limits: no product routes). Update `AGENTS.md` and `docs/CURRENT_STATE.md`.
- [ ] **Step 3: M0 gate.** Run each and expect PASS or "no drift":
  - `cd server && go vet ./... && go tool staticcheck ./... && go test ./...`
  - `cd server && go test -tags integration -p 1 ./...`
  - `pnpm tsx server/testdata/golden/gen/config.ts --check`
  - `pnpm build && pnpm test:unit` (the Node backend is unchanged and still green)
- [ ] **Step 4: Commit** `docs(server): test map, README and M0 status`. Then stop and ask the owner about pushing and the PR.

---

## Not in M0 (and where it lands)

- Docker readiness check and startup assertions: M1.
- Real job workers and periodic jobs: M2.
- Validating River on Supabase's session pooler itself (only local Postgres is tested here). An owner-run harness `server/validation/river-pooler` against a non-production Supabase project is added in M2 before any worker relies on it; the final check is the M8 cutover.
- `deploy.sh`, compose and the production baseline run: M7/M8.
