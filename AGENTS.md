# AGENTS.md — Hermes Cloud

Managed hosting for Hermes AI agents: one dedicated, isolated container plus one volume per customer.
Product source of truth: `docs/prd.md`. **Not production-ready** (open gaps: `docs/architecture.md`,
"Known gaps and deferred security work").

Five standalone packages, no pnpm workspace; each has its own `package.json` and lockfile:

| Package | Path | What it is | Details |
| --- | --- | --- | --- |
| Backend `hermes-cloud` | repo root (`src/`, `test/`, `prisma/`) | Fastify APIs + Docker runtime manager + reconciler (TypeScript, ESM) | this file, `docs/` |
| Dashboard `@hermes-cloud/web` | `apps/web/` | Next.js 16 customer dashboard and admin panel (mock data by default) | `apps/web/README.md` |
| Docs `@hermes-cloud/docs` | `apps/docs/` | Customer docs site (Fumadocs, Next.js 16, static export under `/docs`, Indonesian) | `apps/docs/README.md` |
| Landing `@hermes-cloud/landing` | `apps/landing/` | Public landing page for `cloud.nibie.app` (static export, Cloudflare Worker, Indonesian, legal pages for payment-provider KYC) | `apps/landing/README.md` |
| E2E `@hermes-cloud/e2e` | `e2e/` | Playwright tests: T0 mock, T1 full stack, T2 production smoke | `e2e/README.md` |

Next.js 16 (`apps/web`, `apps/docs`, `apps/landing`) differs from older versions: read the guide under that
package's `node_modules/next/dist/docs/` before writing Next.js code. The `AGENTS.md` in each of those apps
is written by `next dev`; leave it as generated.

## Working rules

- Read first: this file, `docs/CURRENT_STATE.md`, then the doc index `docs/README.md`.
  Verify branch, commits and test results yourself. The repository and real tool output are the
  source of truth, never an older summary or conversation history.
- Precedence: repository and real tool output > `docs/CURRENT_STATE.md` > every other document.
  Files that `docs/README.md` lists under "Historical records" are not kept up to date.
- Do not guess. If a fact is not in the repo or in tool output, say so and ask the owner.
- Do not commit or push unless the owner asks. Keep unrelated changes out of a change set.
- Before ending a task that changes behaviour or status, update `docs/CURRENT_STATE.md`
  (and `docs/SESSION_HANDOFF.md` if you start a new handoff entry).
- Never put provider credentials, API keys, tokens or personal data in repository files.
  The GitHub repository is public.

## Commands

Package manager is pnpm (`pnpm-lock.yaml` is canonical), Node >= 22.

Backend (repo root):

```bash
pnpm install                      # also runs `prisma generate`
docker compose up -d postgres redis   # dev DB on 127.0.0.1:5433, Redis on 127.0.0.1:6380
cp .env.example .env              # then set ADMIN_TOKEN (>= 24 chars) and HERMES_MASTER_KEY (>= 32 chars)
pnpm db:migrate                   # apply prisma migrations
pnpm dev                          # operator API on 127.0.0.1:$PORT (default 3000) + 15 s reconciler loop
pnpm build                        # type-check only (tsc --noEmit); there is no emitted build
pnpm test:unit                    # no Docker or DB needed
pnpm test:integration             # needs a Linux Docker daemon + Postgres + Redis (REDIS_URL); builds the stub image on first run
pnpm test                         # both
pnpm vitest run test/unit/hardening.test.ts            # single file
pnpm vitest run test/unit/hardening.test.ts -t "name"  # single test by name
pnpm demo [--keep]                # provision -> restart -> kill -> auto-recover, via the API, stub image
pnpm tsx test/validation/runtime-manager-live.ts       # live harness against the real daemon + official image
```

Integration tests use database `hermes_test` (see `docs/setup.md` for creating it) and run files
serially (`fileParallelism: false`) because they share one Docker daemon and one database.

Dashboard (`apps/web`):

```bash
cd apps/web
pnpm install
pnpm dev                          # http://localhost:3100
pnpm typecheck && pnpm lint && pnpm test    # also: pnpm build
pnpm vitest run test/status.test.ts         # single file
```

Other packages (run inside the package folder after `pnpm install`):

```bash
# apps/docs     pnpm dev -> http://localhost:3200/docs; checks: pnpm typecheck && pnpm lint
# apps/landing  pnpm dev -> http://localhost:3300;      checks: pnpm typecheck && pnpm lint && pnpm test && pnpm build
# e2e           pnpm build:t0 before pnpm test:t0;      checks: pnpm typecheck
```

Latest verified test results live in `docs/CURRENT_STATE.md`, not here.

## Deployment and host controls

- `deploy/` (Compose, Caddy, Dockerfile for one VPS): read `deploy/README.md` for the order of work and
  what was and was not verified on a real host.
- Host addresses, contact emails and all secret values stay out of the repository; `.env.example` holds
  names and placeholders only.
- Egress rules (`ops/egress/`) and XFS volume quota: `docs/runbook-egress.md`, `docs/egress-host-notes.md`,
  `docs/disk-quota-host-notes.md`.

## Architecture (the parts that span files)

- **Control plane / data plane in one modular monolith** (ADR 0001, no orchestrator). Only
  `src/modules/runtime` talks to Docker, behind the `RuntimeManager` interface (`types.ts`);
  `src/modules/instances` depends only on that interface. The Docker socket is never mounted into a
  tenant container.
- **Docker names derive from instance UUIDs only** (`hermes-<id>`, `hermes-data-<id>`,
  `hermes-net-<id>`), never customer text. This is what makes every runtime call idempotent.
- **Lifecycle** (`state-machine.ts`, `instance-service.ts`): every status change is a database
  compare-and-set plus an `InstanceEvent` in one transaction; the loser of a race gets 409.
  Provisioning is idempotent per `(tenant, Idempotency-Key)` and the key is bound to `name` + `planId`.
  It runs synchronously in-process today.
- **Leases** (`lease.ts`): each transitional status is owned by one operation with a heartbeat-renewed
  lease; the operation's writes are fenced on `operationOwner`; the stale-operation reaper in
  `reconciler.ts` only touches expired leases.
- **Reconciler** (`reconciler.ts`): recovers `ACTIVE`/`DEGRADED` instances (max 3 attempts, backoff with
  jitter, stability window), claims the instance before touching Docker, never restarts `STOPPED`.
- **Hardening baseline** (`runtime/hardening.ts`): constants for the official Hermes image contract
  (port 8642, data at `/opt/data`, s6 init that drops to uid 10000, eight re-added capabilities,
  read-only rootfs with tmpfs). The container `User` is deliberately not pinned. Details and the
  evidence behind each setting: `docs/architecture.md`, `docs/adr/0002-...`,
  `docs/milestone-2-runtime-security.md`.
- **Per-instance API key** (`runtime/api-key.ts`): `API_SERVER_KEY` = HMAC-SHA256 of `HERMES_MASTER_KEY`
  and the instance id; never stored or logged. Readiness requires an authenticated 200 on
  `/api/sessions`; a 401 marks the instance `DEGRADED` (`auth_rejected`) without a restart.
  `HERMES_MASTER_KEY` and `HERMES_RUNTIME` (`runc` default, `runsc` for gVisor, required when `NODE_ENV=production`)
  only apply to containers created afterwards.
- **Jobs** (`src/modules/jobs`, `instance-commands.ts`): with `REDIS_URL` (required in production), HTTP
  routes call `InstanceCommands`, which validates the transition (`decideOp`) and enqueues a BullMQ job (ids
  only, id `<instanceId>_<op>`); a worker runs the same `InstanceService` methods, so leases and fencing
  are unchanged. Without `REDIS_URL` the same call runs inline and `jobId` is `null`. Transient errors retry
  4 times with backoff; exhausted jobs are listed at `GET /api/v1/jobs/failed` (operator API). The
  reconciler and a sweeper for stranded `PENDING` rows run as a scheduled job under a Redis lock. Redis
  down: lifecycle actions answer 503, creating still answers 202 (the row is the intent).
- **Secrets and integrations** (`src/modules/secrets`, `src/modules/integrations`, `src/modules/net`): provider
  keys and Telegram tokens are envelope-encrypted (AES-256-GCM data key per secret, wrapped by the versioned
  `SECRETS_KEK` from env; AAD binds tenant, id and purpose) and never returned, logged or put in job payloads.
  `RuntimeConfigLoader` decrypts only when a container is created; env vars plus a seeded `model:` block
  (`key_env`, no key on disk) carry them in (ADR 0003). `Instance.configRevision` vs `appliedRevision` makes the
  next start/restart (user or reconciler) recreate the container. Nothing under `src/http` may import
  `secrets/secret-store` (test-enforced). Control-plane calls to Telegram and provider URLs use `safeFetch`
  (https, no redirects, public pinned address). Secrets are purged only after `runtime.remove` succeeds.
- **Wallet / top-up saldo** (`src/modules/billing/wallet.ts`, behind `WALLET_ENABLED`, default off): an IDR balance per tenant
  (`Wallet`) changed only with a `WalletEntry` (unique `(kind, refId)`, balance after) in one transaction under a row lock; DB
  CHECK `>= 0`. QRIS top-ups (`WalletTopup`, `nw-` order ids, Rp 10.000 to 2.000.000, wallet cap Rp 5.000.000) are credited by
  the same SumoPod webhook when no hosting `Payment` matches the order id. Admin adjust needs aal2, a reason and an `AuditLog`
  row. Non-refundable. `POST /payments/:id/pay-with-wallet` pays an open hosting invoice (purchase, upgrade, renewal) from it under
  the same subscription row lock as the webhook (`Payment.method = WALLET`, ledger `HOSTING` keyed on the payment id); a QRIS payment
  of an invoice already paid from the wallet is put back into the wallet (`credited_to_wallet`). With `WALLET_AUTO_RENEW` (default
  off) the billing tick renews during the last day of a period when `Subscription.autoRenew` (default on, customer switch) and the
  balance allow it, once per period (order id `ar-<sub>-<periodEnd>`). Buying AI credit is planned, not built
  (`docs/superpowers/plans/2026-11-20-wallet-topup.md`).
- **Invoices** (`src/modules/billing/invoices.ts`, `GET /invoices`, `GET /invoices/:id`): one `Invoice` per paid `Payment` or paid
  `WalletTopup`, issued in the webhook transaction that marks it paid (unique source id, so never twice; issued even for
  `paid_after_end`). Number `INV/<yyyy>/<mm>/<seq>` per month in Asia/Jakarta, from `InvoiceCounter` bumped in the same
  transaction (no gaps). Rows are never changed: plan and instance names are copied at issue time. Seller "Nibie Cloud / nibie.app",
  no PPN (owner, 2026-11-20). Dashboard: list on Billing, printable page `/billing/invoices/[id]` (prints in the light theme).
- **Billing** (`src/modules/billing`, `src/http/billing-routes.ts`, `src/http/sumopod-callback.ts`): SumoPod Managed Payment (QRIS)
  is the only gateway (Duitku was removed 2026-11-19). It is configured by `SUMOPOD_API_KEY`, `SUMOPOD_WEBHOOK_TOKEN` and
  `SUMOPOD_CALLBACK_URL` plus `DASHBOARD_ORIGIN` (`SUMOPOD_ENV` `sandbox` default, `production` needs `NODE_ENV=production`; details in
  `src/config/env.ts`). Its public webhook `POST /api/v1/billing/sumopod/webhook` is checked before any database access by a
  Svix signature over the raw body (`SUMOPOD_WEBHOOK_SECRET`, `whsec_...`, 5-minute window, required in production), or by
  that token when no secret is set (`src/modules/billing/svix.ts`), and is idempotent through `PaymentEvent`'s unique key.
  One `Subscription` per instance; the instance is created after the first verified payment, except for an upgrade
  (`POST /subscriptions/upgrade`): a free instance gets a subscription that already points at it, and the first verified
  payment moves it onto the paid plan (`applyPlanChange`: router credit, `planId`, `configRevision`, restart; the volume
  quota is raised by the host timer `hermes-volume-quota`, which reads the operator route `GET /api/v1/volume-quotas`). A billing tick (inside the locked maintenance
  job) handles reminders, 3-day grace, suspension (instance stopped, start answers `subscription_suspended`), 30-day
  retention and deletion, with Indonesian emails over SumoPod SMTP. `Plan.monthlyPriceIdr` null means not for sale; prices
  are set by `scripts/seed-sandbox-plans.ts` (sandbox) or by hand, never by a migration. No real-money payment verified
  yet: see `docs/architecture.md`, "Known gaps" 9a.
- **Free beta waiting list** (`src/modules/waitlist`, `src/modules/instances/free-beta.ts`, `POST /api/v1/public/waitlist`): active with `FREE_BETA_SLOTS` > 0. `WaitlistEntry` (email unique lowercase, `UNCONFIRMED|WAITING|INVITED|REGISTERED`, RLS on). Double opt-in: an entry counts only after `POST /api/v1/public/waitlist/confirm` with the token from the confirmation email (hash stored, 24 hours); unconfirmed entries are never invited and are deleted when their link expires. `WaitlistInviter` (inside the maintenance tick, advisory lock) invites the oldest waiting entry by email when a slot is free, 48 hour window, no manual step; an open invitation reserves its slot (`reservedInvites`), so strangers get `beta_full`. A join needs a solved Cloudflare Turnstile captcha when `TURNSTILE_SECRET_KEY` is set (required in production while the list is on), and confirmation emails are capped at 3 per address and 100 per hour platform-wide. Read-only admin page. Details and limits: `docs/setup.md`, "Waiting list".
- **NibieRouter provisioning** (`src/modules/nibierouter`): only when `NIBIEROUTER_ADMIN_KEY` and `NIBIEROUTER_DEFAULT_MODEL` are set
  (and `SECRETS_KEK`). After a paid instance is created, `RouterProvisioner` makes one router user per tenant, one key per instance
  (attached through `ProviderService.attachNibieRouter`, then the instance restarts) and, for a plan with `includedCreditNano`, a
  one-time credit guarded by the unique `CreditGrant` row (the router has no idempotency). Free-plan instances that are `ACTIVE` with
  no provider get a key too (no credit), picked up by the billing tick's `runPending`. Rows live in `RouterProvisioning`, the
  billing tick retries them, and a failure never touches the payment. The customer picks the model of a `NIBIEROUTER`
  provider (`GET /instances/:id/models`, `PUT .../providers/model`) from the router's public model list (`model-catalog.ts`,
  10-minute cache); a free plan gets the free models only. Not verified against the real router: see
  `docs/architecture.md`, "Known gaps" 9b, and run `test/validation/nibierouter-live.ts` first.
- **Disk quota and egress** (`runtime/volume-quota.ts`, `runtime/egress-canary.ts`, `ops/egress/`):
  `HERMES_DISK_QUOTA` and `HERMES_EGRESS_POLICY` are `enforce|off` (`off` refused in production). Tenant
  volumes carry a size quota from `Plan.storageMb` and tenant bridges are named `hn<12 hex>` so one host
  iptables chain can filter them; the control plane refuses unquotaed volumes and unnamed networks
  (`volume_quota_missing`, `network_policy_missing`) and runs an egress canary at startup. Neither the XFS
  kernel quota nor the egress rules have been verified on a real host: see `docs/disk-quota-host-notes.md`
  and `docs/egress-host-notes.md`.
- **Images must be pinned:** no `latest` in any environment, `name@sha256:<digest>` when
  `NODE_ENV=production` (`runtime/image-policy.ts`). `test/fixtures/hermes-stub` is a stand-in that
  mimics the official contract; `test/fixtures/hermes-stub/*` must stay LF (`.gitattributes`).
- **Three API surfaces** under `/api/v1`, in separate Fastify plugins (`src/http`): the operator API
  (`operator-routes.ts`, one shared bearer `ADMIN_TOKEN`, `/tenants/:tenantId/instances...`), the
  customer API (`customer-routes.ts`, Supabase access token verified locally against the project's
  JWKS, tenant derived from the user's membership, only when `SUPABASE_URL` is set), and the admin API
  (`admin-routes.ts`, prefix `/api/v1/admin`, read-only in phase A). The process binds
  `127.0.0.1`; a public proxy must never forward `/api/v1/tenants/*`. Customer provisioning is gated by
  `BETA_ALLOWED_EMAILS` and `MAX_INSTANCES_PER_TENANT`. No endpoint creates plans or nodes; seed rows
  directly (see `scripts/demo.ts`).
- **Admin API** (`src/http/admin-routes.ts`, `src/modules/admin`): the same Supabase tokens as the
  customer API, but the email must be in `ADMIN_EMAILS` (empty = nobody, fail closed). Every route
  sets `cache-control: no-store`; the whole surface is rate-limited; each request is written to
  `AuditLog` (`AuditService`). Every route, reads included, requires `aal2` (MFA TOTP): an allowlisted admin
  at `aal1` gets `403 mfa_required` and the dashboard's `AdminMfa` screen enrols or challenges a TOTP factor through
  Supabase Auth. Beta invites (`GET/POST /beta-invites`, `POST /beta-invites/:id/revoke`, table `BetaInvite`, checked in
  `customer-routes.ts` next to `BETA_ALLOWED_EMAILS`), admin keys and plan stock (`POST /plans/:planId/stock`, column
  `Plan.stockLimit`, priced plans only; `capacity.ts` counts instances, unfulfilled paid subscriptions and unexpired invoices per plan;
  checkout answers `409 plan_sold_out` under a per-plan advisory lock and customer `/plans` marks the plan unavailable) are the only
  routes that change data so far: each needs a reason and writes its `AuditLog` row in the same transaction. The rest of phase B is not implemented yet. **Admin keys and MCP**
  (`modules/admin/api-keys.ts`, `http/admin-mcp.ts`, table `AdminApiKey`): a bearer `nca_...` key stands for its creator at `aal2`
  (SHA-256 hash stored, shown once, optional expiry, revocable, dead once the creator leaves `ADMIN_EMAILS`); `GET/POST /api-keys`
  and `POST /api-keys/:id/revoke` answer `403 session_required` to a key, so only a panel session manages keys. Key use is audited
  with `detail.via = 'key'`. `POST /api/v1/admin/mcp` is a stateless Streamable HTTP MCP server whose tools call the admin routes
  through `inject` with the caller's own header, so auth, rate limit and audit are the same code. `GET /system` also returns
  `settings` (modes, counts and names only, never a secret) for the Pengaturan page. The plugin is
  registered only when `SUPABASE_URL` is set. It must never import `secrets/secret-store` and must not
  select ciphertext or wrapped-key columns (test-enforced, like the operator/customer plugins).
- **Dashboard data layer** (`apps/web/src/lib/api`): a typed `HermesApi` with an in-browser mock
  (default, `NEXT_PUBLIC_HERMES_API_MODE=mock`), a customer-API client (`=customer`, Supabase token to
  `NEXT_PUBLIC_HERMES_API_URL`; instances, `/me`, `/plans` are real), a dev-only live client, and an
  admin client (`admin.ts`) for `/api/v1/admin/*`. Live mode goes through the dev
  bridge `apps/web/src/app/api/hermes/[...path]/route.ts` (never in a production build), which keeps `HERMES_ADMIN_TOKEN` server-side
  and forwards only the allowlisted instance endpoints in `proxy-rules.ts`. In `mock`/`live` mode everything without a
  backend endpoint (usage, files, console, backups, domain, access) is mock data labelled "Preview data"; in `customer`
  mode those pages are hidden and their calls answer empty or `501 not_available`, never sample data. Billing is a UI shell; sign-in is real only when the public Supabase variables are set (`/auth/confirm` verifies email links, `AuthGate` guards `(app)`); the app uses `basePath` `/dashboard`. Mapping details:
  `apps/web/README.md`.
- **Admin panel** (`apps/web/src/app/(app)/admin`): Indonesian UI, no mock data — in `mock`/`live`
  mode every page renders "Panel admin butuh backend" rather than sample customers (the decision is
  pure and tested in `apps/web/src/lib/admin-gate-rules.ts`). `AdminGate` asks `/admin/me`; a
  non-admin sees "Tidak berwenang" with no hint of who is an admin, and the sidebar link appears only
  after `/admin/me` answers. Pages: Ringkasan, Pelanggan (+detail), Instance (+detail), Langganan &
  pembayaran, Daftar tunggu, Undangan beta, Plan, Node, Job gagal, Audit, Pengaturan (read-only settings, admin keys, MCP URL). Guarding is server-side; hiding UI is convenience only.

## UI and design system

shadcn/ui is the exclusive component foundation for Hermes Cloud frontend work, and the root
`DESIGN.md` is the design source of truth.

- Read `DESIGN.md` before any UI change. Use shadcn/ui primitives (official registry and CLI),
  Tailwind CSS and Lucide icons. Customize the copied component source in place; do not wrap or fork it
  into a parallel system.
- Do not add Ant Design, MUI, Chakra UI, Mantine, DaisyUI or any competing component system.
- Do not invent colors, type, spacing, radii or component styles outside `DESIGN.md` tokens. If a token
  is missing, extend `DESIGN.md` as an explicit approved decision; never hard-code values.
- Update `DESIGN.md` when an approved design decision changes and validate it with the official CLI
  (`@google/design.md` lint / export) before committing UI-affecting changes.
- Status is never conveyed by color alone. Text meets WCAG AA contrast; visible focus states, keyboard
  navigation and reduced motion are required.
- Terracotta (`tertiary`) is used only for the primary button fill, the checked checkbox and the
  switch-on track. `border-strong` is only for form-control boundaries and the edges of outline and
  secondary buttons.
