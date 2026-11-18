# Hermes Cloud backend: port from TypeScript (Node) to Go

Date: 2026-11-19
Status: draft for review. Design sections 1–5 were approved in chat; this written spec is not approved yet. Nothing is implemented or committed.
Builds on: [2026-11-12-backend-design.md](2026-11-12-backend-design.md), `docs/architecture.md`, `AGENTS.md` (Architecture).

## 1. Intent

**What the owner asked:** move the backend off Node.js to a lighter compiled language so each server keeps more of its capacity for paying tenants. PHP and Node.js are ruled out. Of Go and Rust, Go was chosen.

**What was measured** (VPS, 2026-11-19, read-only, recorded in the session and not in the repo):

| Container | RAM | CPU |
| --- | --- | --- |
| backend (Node, 24 h uptime) | 113 MB, steady across two samples | 0.05% |
| Caddy | 14 MB | 0% |
| Redis | 5 MB | 0.2% |
| 2 tenant instances | 620 MB total (1 GB cap each) | below 1% |

The host has 15.5 GB of RAM, with 13.6 GB available.

**What to expect:** a Go control plane should use roughly 20–40 MB, so it saves about 80–100 MB per host, which is under a tenant slot. That figure is an estimate until M8 measures it. The owner was told that tenant overcommit is the bigger margin lever. That is out of scope here and can be done separately.

**Success means:**
1. The Go backend replaces the Node backend on the VPS.
2. The `/api/v1` contract is identical (same routes, status codes, error bodies), so the dashboard, landing, docs and e2e suites need no change.
3. Every security and correctness property listed in `AGENTS.md` (Architecture) still holds and is covered by Go tests.
4. Redis is removed from production after a clean 7-day observation period.
5. A rollback to the Node image is possible at any point before M9.

**Non-goals:** new features, schema changes, frontend changes, multi-host or orchestrator work, and the tenant overcommit work.

## 2. Structure and libraries

All Go code lives in `server/` (Go module, the Go toolchain is pinned in `go.mod` and its base image by digest). `src/` stays untouched until M9.

```
server/
  cmd/hermes-cloud/main.go      # wiring (mirrors src/main.ts); subcommands: serve (default), migrate, healthcheck
  cmd/demo/                     # port of scripts/demo.ts
  cmd/seed-sandbox-plans/       # port of scripts/seed-sandbox-plans.ts
  internal/
    config/ db/ http/ shared/
    runtime/ instances/ jobs/ billing/ secrets/ integrations/
    nibierouter/ waitlist/ beta/ admin/ auth/ ops/ net/
  migrations/                   # goose SQL, embedded in the binary
  contract/                     # route golden file and black-box contract tests
  validation/                   # ports of test/validation/*.ts live harnesses
  testdata/golden/              # fixtures generated from the Node code (section 4)
  TEST-MAP.md
```

Module names and boundaries match `src/modules/*`, so `docs/architecture.md` stays accurate. Only `internal/runtime` talks to Docker, and `internal/instances` depends on its `RuntimeManager` interface.

**Boundary rules (test-enforced, as they are now):**
- No package under `internal/http` (or `internal/admin`) may import `internal/secrets/store`. A test checks this with `go list -deps`.
- Admin and operator queries never select ciphertext or wrapped-key columns. A test scans the `sqlc` query files.

**Library mapping:**

| Node | Go |
| --- | --- |
| Fastify, `@fastify/cors`, `@fastify/formbody`, `@fastify/rate-limit` | stdlib `net/http` (Go 1.22+ patterns), own small CORS/formbody code, `golang.org/x/time/rate` |
| Prisma | `jackc/pgx/v5` + `sqlc` |
| BullMQ + ioredis | `riverqueue/river` (Postgres) |
| dockerode | `github.com/docker/docker/client` |
| jose (Supabase JWKS, ES256) | `lestrrat-go/jwx` |
| pino | `log/slog` JSON with the same redaction and email masking |
| zod | typed request structs with explicit validation functions |
| nodemailer | `wneessen/go-mail` |
| yaml | `goccy/go-yaml` |
| node:crypto (AES-256-GCM, HMAC, Svix) | stdlib `crypto/*` only |
| dotenv | none in production. A dev-only `.env` loader in `cmd/hermes-cloud` when `NODE_ENV` ≠ `production` |

Every dependency is pinned in `go.sum`. Adding a dependency beyond this table needs a stated reason in the PR.

**Config:** the same variable names and the same production refusals as `src/config/env.ts`, for example `HERMES_DISK_QUOTA=off`, an unpinned image, a missing `HERMES_RUNTIME` or a missing Turnstile secret while the waiting list is on. `NODE_ENV` keeps its name so `/etc/hermes-cloud/backend.env` is reused unchanged. `REDIS_URL` is read and ignored with a warning, and it stops being required in production.

**Image:** `server/Dockerfile` (build context `server/`) is a multi-stage build. It stays out of `deploy/` until M8, because a
change under `deploy/` triggers the automatic production deploy. The final stage is `gcr.io/distroless/static-debian12:nonroot` pinned by digest and holds one binary (`/hermes-cloud`). `group_add: DOCKER_GID`, `cap_drop: ALL`, `no-new-privileges` and `network_mode: host` stay as in `deploy/compose.prod.yaml`.

## 3. Database and migrations

The same Supabase database and the same `hermes` schema are used, and no data is migrated. Table, column and enum names stay exactly as Prisma created them (quoted CamelCase).

- **goose replaces Prisma Migrate.** Every `prisma/migrations/*/migration.sql` file is copied verbatim as one goose migration, in order (`00001`–`00017` on 2026-11-19; a new Prisma migration on `main` gets its copy before M8), so a database built from scratch is identical. The next version (`PrismaMigrations + 1`) adds River's tables in the `hermes` schema.
- **Production baseline:** a one-time `hermes-cloud migrate baseline` writes goose version rows for the Prisma copies without running them, then `migrate up` applies River's version. Both steps are additive, so the Node backend keeps working.
- `_prisma_migrations` stays until M9 so a Node rollback still works.
- **Connection:** `DATABASE_URL` ends in Prisma's `?schema=hermes`. `internal/db` rewrites that to `search_path=hermes` for pgx, so the env file is unchanged. The production connection is Supabase's session pooler, so LISTEN/NOTIFY works.
- **Pool sizing:** explicit `MaxConns` for the API pool and River (River's listener needs one dedicated connection). If the pooler's connection limit is a problem in M0 testing, run River in poll-only mode.

**Behaviour Prisma provided implicitly, now explicit:**

| Behaviour | In Go |
| --- | --- |
| `@updatedAt` on 7 columns, set by the client | Every UPDATE in `sqlc` sets `"updatedAt" = now()`. A test scans the query files for it. |
| `@default(uuid())` on 17 columns, generated client-side (no SQL default) | `uuid.New()` (v4) before each INSERT |
| `Timestamptz(3)` | Postgres rounds to milliseconds. Lease and backoff comparisons are done in SQL or after truncation. |
| 6 transactional locks (`pg_advisory_xact_lock(hashtext(...))` in billing, instance create, router provisioning, waitlist inviter; `FOR UPDATE` in billing and Telegram) | Ported 1:1 in `pgx.Tx` with the same lock keys and order |
| Status compare-and-set + `InstanceEvent` in one transaction; the loser gets 409 | `UPDATE ... WHERE id = $1 AND status = $old`, a `RowsAffected()` check, and the event insert in the same tx |
| Redis lock around the maintenance job (reconciler, sweeper, billing tick, waitlist inviter, alerts) | River periodic jobs, which run only on River's elected leader |
| BullMQ job id `<instanceId>_<op>` for dedup | River `UniqueOpts` on (instance id, op) |
| Retries: 4 with backoff; failed jobs listed at `GET /api/v1/jobs/failed` and `/api/v1/admin/jobs/failed`, retried at `POST /api/v1/jobs/failed/:jobId/retry` | River `MaxAttempts = 5` with the same backoff. Those routes read River's discarded jobs and keep the current response shape (section 8). |
| Without `REDIS_URL`, commands run inline and `jobId` is `null` | River is always on. The response field `jobId` stays (string). Inline mode is removed; tests use River's test helpers. This is a documented, intended difference. |

**RLS:** `WaitlistEntry` and `BetaInvite` have RLS on and no policies. The same database role is used, so behaviour is unchanged.

## 4. Proving parity

The 866 TypeScript test cases call classes directly, so none of them can run against Go. Parity comes from four layers.

**Layer 1: ported tests.** Every module ships `go test` tests. Integration tests use the same local Postgres database `hermes_test`, a Linux Docker daemon and the stub image `test/fixtures/hermes-stub` (which stays LF). Integration tests run serially (`-p 1`), like `fileParallelism: false` today. `server/TEST-MAP.md` maps each TS test case to its Go test, or gives a reason it is not ported. A milestone's PR adds its rows. M7 requires all 866 to be mapped.

**Layer 2: golden fixtures generated from the Node code.** A script under `server/testdata/golden/gen/` runs the existing TS functions with fixed inputs. It only imports `src/`, never changes it, and runs with `tsx` as a dev tool, not as backend code. It writes JSON fixtures that the Go tests must reproduce byte for byte:

| Fixture | Why it matters |
| --- | --- |
| Secret envelope: Node ciphertext opens in Go, Go ciphertext opens in Node, with AAD (tenant, id, purpose) and KEK versions | Production secrets were encrypted by Node. A mismatch breaks every tenant. |
| `API_SERVER_KEY` HMAC vectors | A mismatch marks every instance `DEGRADED` (`auth_rejected`). |
| Container create spec (hardening, capabilities, tmpfs, read-only rootfs, labels, pids, memory, CPU, runtime, volume quota options, network name `hn<12 hex>`, Docker names from UUIDs) | Tenant isolation |
| Seeded config YAML (`model:` block, `key_env`) and runtime env var set (names only) | The tenant agent must read its config. |
| Duitku signatures, Svix verification (valid, expired, tampered), the SumoPod token fallback | Money |
| Indonesian email templates (subject, HTML, text), sender display name "Nibie Cloud" | Customer-facing |
| Email masking and log redaction outputs | No personal data or secrets in logs |
| Egress rules and DNS `resolv.conf` output | Host egress policy |

**Layer 3: route contract.**
- `server/contract/routes.golden.txt` is the method and path list printed by the Fastify app (`app.printRoutes`, generated by the same script).
- A Go test fails if the Go router has a route missing or extra.
- Black-box contract tests (`server/contract/`, in Go, against a running Go server with a test JWKS and fake Duitku/SumoPod/Telegram/NibieRouter/Turnstile/SMTP servers) assert status codes, error bodies and headers for the main cases: 401, 403 `mfa_required`, 404, 409, 429, 503, `beta_full`, `subscription_suspended`, and `cache-control: no-store` on admin routes. The expected values come from the current TS integration tests.

**Layer 4: end to end.**
- T0 (dashboard mock) is unaffected.
- T1 runs against the Go backend: `e2e/support/stack-prep.mjs` gets `E2E_BACKEND=go`, which migrates with `hermes-cloud migrate` and starts the Go binary, and does not start Redis. T1 already passes against Node, so a green T1 on Go is customer-level parity.
- The Go ports of `test/validation/runtime-manager-live.ts` (official image, real daemon) and `egress-checks.ts` must pass locally.

**Not provable before cutover** (not verified for Node either, `docs/architecture.md` "Known gaps"): real Duitku and NibieRouter, the XFS kernel quota and the host egress rules. These are checked by T2 and the cutover checks in section 5, and failures are rollback triggers.

## 5. Cutover and rollback

Each host step needs the owner's own words for that step (`approval-phrases`).

**Before cutover day (no customer impact):**
1. M0–M7 are merged to `main`. The production compose still builds the Node image.
2. With owner approval, run `hermes-cloud migrate baseline` and `migrate up` against production, using the Go image through `docker compose run --rm --no-deps`. Only goose's version table and River's tables are added.
3. Prepare the cutover commit:
   - `compose.prod.yaml` builds `server/Dockerfile` (context `server/`).
   - The healthcheck becomes `["CMD", "/hermes-cloud", "healthcheck"]`.
   - `deploy.sh` runs `/hermes-cloud migrate up` instead of `prisma migrate deploy`.
4. Fix `deploy.sh`: its automatic rollback after a failed `/readyz` resets `BACKEND_TAG` and recreates the backend, but does not restore the git checkout. Only the migration-failure path does that today. With a cross-language rollback, the old image would run under the new compose file and its `node`-less healthcheck. The fix also checks out `$previous_tag` before recreating, which benefits normal deploys too.

**Cutover (expected API downtime 1–3 minutes; tenant containers keep running):**
1. `deploy.sh` takes its usual database dump.
2. Stop the Node backend gracefully. The BullMQ worker's `close()` finishes active jobs within its deadline.
3. **Gate:** BullMQ has no waiting, active, delayed or prioritized jobs (the keys are listed in section 8), and no instance is in a transitional status with an unexpired lease (SQL). If either fails, wait. Do not proceed.
4. Start the Go backend: same env file, port 3000 and host network. Wait for `/readyz`.
5. Checks:
   - T2 production smoke.
   - Both tenant instances stay `ACTIVE` (health checks authenticate with `API_SERVER_KEY`).
   - Reconciler and billing tick log a successful run.
   - Provision and delete one instance on an operator test tenant (create path, hardening, quota, network, secrets), then `docker stats` for the new backend's RAM.

**Rollback triggers:**
- `/readyz` not ready within 60 s,
- any T2 failure,
- any instance turning `DEGRADED`,
- any secret decryption error in the logs,
- a payment callback rejected or erroring.

**Rollback:** `deploy.sh <pre-cutover commit>`, which with the step 4 fix restores both the compose file and the Node image. The schema is unchanged, and Node ignores the goose and River tables. Jobs enqueued in River but not yet run are lost:
- provisioning intents are recovered by Node's `PENDING` sweeper;
- start, stop and restart need the customer to click again.
Redis is still running, so BullMQ works at once.

**Observation, 7 days:** the Node image and Redis stay on the host. After 7 clean days, M9 runs as a separate owner-approved PR.

## 6. Milestones

Each milestone is one PR, merged to `main` and not deployed until M8. The Node backend is frozen for features from M0 to M8: only bug and security fixes go in. Each such fix adds a `TEST-MAP.md` row and is ported to Go in the same or the next PR.

| # | Scope | Gate |
| --- | --- | --- |
| M0 | Module, config parity, logger + redaction, pgx pool + schema rewrite, `sqlc`, goose copies of every Prisma migration plus River, `migrate`/`healthcheck` subcommands, `/healthz` `/readyz`, `server/Dockerfile`, CI job (`go vet`, `staticcheck`, `go test`), golden-fixture generator | Config tests accept and refuse the same env as `test/unit/config.test.ts`. The goose-built `hermes_test` schema diffs clean against the Prisma-built one (`pg_dump --schema-only`). River starts on a session-mode connection. |
| M1 | `internal/runtime`: Docker manager, hardening, API key, image policy, volume quota, network policy, egress canary, DNS, runtime availability, health | Create-spec and HMAC goldens match. The `runtime-manager-live` port passes. |
| M2 | `internal/instances` + `internal/jobs`: state machine, lease and fencing, service, commands, River worker, periodic maintenance, sweeper, reconciler, disk monitor; operator routes; `cmd/demo` | Concurrency (409), recovery and reaper tests pass on a real daemon. The demo runs provision → restart → kill → recover. |
| M3 | `internal/auth`, customer routes, public routes, beta gate, waitlist (Turnstile, double opt-in, rate caps, inviter), free beta | Customer, auth and waitlist tests mapped and green |
| M4 | `internal/secrets`, `internal/net` (`safeFetch`), integrations (Telegram, provider, runtime config loader, purge, logs), integration routes | **Cross-language secret envelope goldens pass in both directions.** |
| M5 | Billing (Duitku, SumoPod + Svix, service, tick, lifecycle), mailer and templates, NibieRouter client and provisioner, `cmd/seed-sandbox-plans` | Signature, email and idempotency goldens match. The `duitku-sandbox-live` and `nibierouter-live` ports run (owner-supplied sandbox credentials, never in the repo). |
| M6 | Admin routes (allowlist, `aal2`, rate limit, audit, `no-store`), beta invites, alert scanner, alerter, Telegram sink | Admin tests mapped and green, including the no-ciphertext rule |
| M7 | Route golden, contract tests, `TEST-MAP.md` complete, T1 on Go, `deploy.sh` rollback fix, cutover runbook in `deploy/README.md` | All 866 mapped. T1 green on Go. `deploy.sh --dry-run` shows the new path. |
| M8 | Production baseline migration, then cutover (section 5) | No rollback trigger. Measured backend RAM recorded in `docs/CURRENT_STATE.md`. |
| M9 | After 7 clean days: remove Redis from compose and `ops/host/hermes-watchdog.sh` (it checks `hermes-cloud-redis-1`), remove `src/`, `prisma/`, `deploy/Dockerfile`, the TS tests, Node tooling at the root and the golden generator in `server/testdata/golden/gen/` (the generated fixtures stay checked in), drop `_prisma_migrations`, update `AGENTS.md`, `docs/architecture.md`, `docs/setup.md`, `e2e/README.md`, `docs/CURRENT_STATE.md` | Owner approval |

No duration is estimated. Sizing becomes possible after M0.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Go cannot decrypt production secrets | M4 cross-language goldens. A decryption error is a rollback trigger. |
| Container isolation weakens unnoticed | M1 create-spec golden; the egress canary still runs at startup |
| Payment callback lost or doubled during cutover | Unique `PaymentEvent` key; Duitku retries callbacks; short window |
| River exhausts session-pooler connections | Explicit pool sizes; poll-only fallback; tested in M0 |
| The Node freeze delays features for a long time | Freeze covers the backend only; small milestones |
| Behaviour that tests do not cover drifts | Golden fixtures for the risky outputs; T1 as an end-to-end check; 7-day observation with rollback ready |
| Less saving than hoped | Measured at M8 and reported plainly. The port has value only if the owner accepts about 80–100 MB as the gain. |

## 8. Facts settled while writing (checked in the code)

- **Drain check keys:** the queue is `instance-ops` (`INSTANCE_QUEUE` in `src/modules/jobs/bullmq-queue.ts`) with BullMQ's default prefix (`src/main.ts` sets none). The cutover gate is:
  - `LLEN bull:instance-ops:wait` = 0 and `LLEN bull:instance-ops:active` = 0, and
  - `ZCARD bull:instance-ops:delayed` = 0 and `ZCARD bull:instance-ops:prioritized` = 0.
- **Failed jobs:** `GET /api/v1/jobs/failed` (operator) and `GET /api/v1/admin/jobs/failed` (admin) both return `{ jobs: FailedJob[] }` with `jobId`, `op`, `instanceId`, `attempts`, `reason` and `failedAt`, from BullMQ's first page of failed jobs. `POST /api/v1/jobs/failed/:jobId/retry` answers 202 `{ jobId }`, or 404 when the job is not failed. Go builds the same shape from River's discarded jobs: `jobId` = River job id as a string, `attempts` = `attempt`, `failedAt` = `finalized_at`. It keeps the same page size and the same 404 rule.
- **Existing mismatch, out of scope:** the dashboard type `AdminFailedJob` in `apps/web/src/lib/api/admin.ts` expects `id`, while the backend sends `jobId`. The port keeps `jobId` (parity). Fixing the dashboard is a separate change.
