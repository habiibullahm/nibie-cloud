# Current State — Hermes Cloud

Last updated: 2026-11-17 (evening: free beta slots and landing counter merged, see the first section). Earlier entries below keep their own dates, and
several still describe branches as "not committed" or billing as "OFF" that have since merged or changed; the first section and
[HANDOFF.md](HANDOFF.md) win. Index of all docs: [README.md](README.md). New session? Start with [HANDOFF.md](HANDOFF.md) and [START_PROMPT.md](START_PROMPT.md).

## Latest status (2026-11-17, read from `origin/main` at `1584e35` and the GitHub PR list)

- **Git.** `main` contains PRs #22 to #50 (merged: #49 and #50 at 05:15 UTC). One PR is open: **#51, automatic waiting list**
  (`WaitlistEntry`, `POST /api/v1/public/waitlist`, inviter in the maintenance tick, read-only admin page). Re-checked later on 2026-11-17: its
  branch already holds a merge of `main` at `1584e35` (head `701fc66`); `main` has changed only in `docs/` since, GitHub reports it `MERGEABLE`
  / `CLEAN`, CI 5 passed and 2 skipped. Run locally on Windows against its head: backend `tsc` clean, unit tests 507 passed and 2 failed (both in
  `test/unit/egress-canary.test.ts`, which fails the same way on `main` on this workstation and is untouched by the PR), integration tests on a
  local Postgres `hermes_test` (waitlist 28, api and customer-api 31, admin and billing 101, all passed), landing typecheck, lint, 47 tests and
  build, dashboard typecheck, lint and 116 tests. It is not deployed and needs the owner's approval before merge. It also fixes two things
  seen on production: the public rate limit is keyed on `req.ip`, which is `127.0.0.1` for every visitor because Caddy and the backend both use
  host networking (one shared bucket of 60 a minute), and the landing fetches the counter three times per view.
  Status per PR: [HANDOFF.md](HANDOFF.md), section 6.
- **Free beta (PRs #46 to #50).** The unpriced plan is listed only to invited accounts (`BETA_ALLOWED_EMAILS`) unless `FREE_BETA_SLOTS` is above 0, in
  which case any signed-in user may create one free instance, first come first served; a full beta answers 409 `beta_full`. `GET
  /api/v1/public/beta-slots` returns `{ total, remaining }` for the landing counter. `PAID_CHECKOUT_OPEN=false` hides the priced plans and refuses
  checkout for everyone but invited accounts. `MAX_TOTAL_INSTANCES` (20 on the VPS) caps the whole server. The landing page has a "Daftar beta gratis"
  mode (`NEXT_PUBLIC_FREE_BETA_OPEN`, `NEXT_PUBLIC_API_URL`; rebuild needed).
  **Checked from the internet on 2026-11-17 (later the same day, from a workstation, real command output):** `GET
  https://api.cloud.nibie.app/api/v1/public/beta-slots` answers 200 `{"total":10,"remaining":10}` with `cache-control: public, max-age=15`
  and `access-control-allow-origin: https://cloud.nibie.app` for that origin, so the backend runs #49 with `FREE_BETA_SLOTS=10`.
  `POST /api/v1/public/waitlist` answers 404 (PR #51 is not deployed), operator routes 404, `/api/v1/plans` 401 without a token,
  `/healthz` 200. The landing page `https://cloud.nibie.app/` was rendered in headless Chromium at 1440 and 390 px: badge "Beta gratis ·
  sisa 10 slot", buttons "Daftar beta gratis" linking to `/dashboard/register` (200), line "Sisa 10 dari 10 slot gratis, siapa cepat dia
  dapat.", three 200 responses from `beta-slots`, no console errors, no horizontal overflow; the bundle holds `https://api.cloud.nibie.app`,
  so the Worker was built with `NEXT_PUBLIC_FREE_BETA_OPEN=true` and `NEXT_PUBLIC_API_URL`. **Not checked from outside:**
  `PAID_CHECKOUT_OPEN=false` (the plan list needs a signed-in user), the image tag on the VPS, an actual free sign-up taking a slot.
  Each landing view fetches `beta-slots` three times (one per component using the hook), harmless at 60 requests a minute per address.
  **Supabase Auth "Confirm email" is on** (reported by the owner on 2026-11-17 from the Supabase dashboard; not read by an agent). The free-slot
  path and the waiting list's reserved slot rely on it: both trust the email in the Supabase token.
  Known risks: fake accounts can take free slots; the slot check is not atomic (the total cap bounds it).
- **Billing.** SumoPod is the gateway; a sandbox payment reached `PAID` and an `ACTIVE` instance (above). Production keys were reported installed and
  the webhook reported verified; **the real Rp 25.000 payment test has not been done**, so paid checkout stays closed.
- **Also merged since the entries below were written:** operator alerts in the backend (#35, inactive until configured), deploy script with rollback (#38),
  tenant volume backup to R2 with weekly restore verification (#39), dashboard provider/Telegram/logs wiring (#40, #41, #43), operator script for
  provider and Telegram (#42), usage log and `docs/capacity.md` (#45), abandoned-invoice fix (#37).
- **Owner to-do and open engineering work:** [HANDOFF.md](HANDOFF.md), section 9.

## Automatic waiting list for the free beta (2026-11-17, branch `claude/project-thread-cs6oyk`, on top of PRs #49 and #50)

**Email confirmation added (2026-11-17, owner decision in the review of PR #51: add it before merging).** A new entry is `UNCONFIRMED` and counts for
nothing until the person opens the emailed link (`/daftar-tunggu/konfirmasi#t=<token>`, 24 hours, only the SHA-256 is stored) and clicks
"Konfirmasi", which posts to `POST /api/v1/public/waitlist/confirm`. This closes the review finding that unverified addresses could pin the public
counter at 0 and send invitations to strangers. Without SMTP the form answers `503 waitlist_unavailable`. New migrations
`20261117120000_waitlist_unconfirmed_status` and `20261117120100_waitlist_confirmation` (columns only, RLS unchanged); `prisma migrate diff`
from the migrations to `schema.prisma` reports no difference. Run on a Windows workstation (local Postgres `hermes_test`): backend `tsc`;
`test/integration/waitlist.test.ts` 39 passed (11 new); landing typecheck, lint, 52 tests, build, and the confirmation page and form driven in
headless Chromium at 1440 and 390 px against a fake API (confirm, expired link, link without a token, joining shows "cek emailmu", no horizontal
scroll); dashboard typecheck, lint, 116 tests. **Not verified:** a real confirmation email through SumoPod, Supabase's "Confirm email" setting
(the reserved slot trusts the email in the Supabase token, so that setting must be on).

When the free slots are used, the landing page shows a form (name, email, use case) instead of the access-request email. The backend keeps the
list (`WaitlistEntry`, migration `20261117050000_add_waitlist`, row level security enabled in the migration) and invites the oldest waiting
person by email whenever a slot opens, with a 48 hour window and no manual step. An open invitation reserves its slot, so a visitor cannot take
it. The admin panel has a read-only "Daftar tunggu" page. Details and limits: [setup.md](setup.md#waiting-list-automatic-beta-invitations).

Verified in a cloud sandbox: `tsc`; backend unit tests (509) and the new integration file `test/integration/waitlist.test.ts` (28 tests, local Postgres,
fake runtime and fake mailer) plus `customer-api`, `admin-api`, `billing-api`, `billing-tick` and `schema` integration tests; `apps/web` typecheck, lint and 116
tests; `apps/landing` typecheck, lint, 47 tests and a build checked in a browser against a fake API (form, validation message, success state, no horizontal
scroll at 390 px). **Not verified:** a real invitation email arriving (needs SumoPod SMTP on the VPS), the form against the production API and CORS, and
the migration on Supabase. Before it works in production: merge #49 and #50 and this change, apply the migration (then check RLS, see setup.md), set
`FREE_BETA_SLOTS=10` and the SMTP variables, recreate the backend, and rebuild the Worker with `NEXT_PUBLIC_FREE_BETA_OPEN=true` and `NEXT_PUBLIC_API_URL`.

## Dashboard: Hermes configuration wired to the backend (2026-11-17, branch `claude/project-thread-aeigzy`)

In `customer` mode `apps/web` now calls the real provider, Telegram and logs routes of `src/http/integration-routes.ts`
(`apps/web/src/lib/api/integrations.ts`) instead of the mock; the Configuration page has the Model field, the numeric
Telegram allowlist and a restart notice driven by `restartRequired`. Verified by unit tests with a fake `fetch`
(`test/integrations-api.test.ts`), `typecheck`, `lint`, `pnpm test` and `next build` in a cloud sandbox; **not yet verified
against the production backend or a real Telegram chat** (that is the next step on the instance "nibie testing"). Known limits:
the backend requires the key and the bot token on every save, and the customer API cannot switch back to NibieRouter.

## Go-live status (2026-11-17)

Everything here was checked with real command output or a real page on 2026-11-17; items marked "not done" are open.

- **Sign-up is closed.** The build variable `NEXT_PUBLIC_SIGNUP_OPEN=false` was added to the Worker `nibie-cloud-landing` and the build
  retried (green); the live page now shows "Minta akses beta" and the invite text instead of links to `/dashboard/register`. Reopen it
  only after a real payment has worked end to end (`docs/billing-go-live.md`).
- **Admin dashboard phase A is deployed.** Migration `20261115174608_add_audit_log` applied on Supabase after a fresh dump,
  `ADMIN_EMAILS` set in `/etc/hermes-cloud/backend.env`, backend and Caddy recreated (image tag `affd9d3`), startup log shows the admin API on
  with one admin email. From the internet: `/api/v1/admin/me` and `/overview` answer 401 without a token, operator routes and `/jobs/failed`
  answer 404, a CORS preflight from another origin gets no allow-origin header. **Not verified:** an admin call with a real admin token and
  the `/dashboard/admin` pages; MFA TOTP (only needed for phase B, which is not built).
- **Production plans match the landing.** `deploy/sql/2026-11-17-production-plans.sql` (run once on Supabase): `hosting` Rp 25.000 and
  `hosting-kredit` Rp 50.000 with a one-time US$2 NibieRouter credit (both 1 CPU, 1 GB RAM, 1 GB storage); `beta-starter` (2 GB RAM, 5 GB
  storage, 4 instances still on it) is no longer for sale. The landing and the database now agree.
- **Billing runs in SumoPod sandbox mode on the VPS (since 2026-11-17).** Gateway decision (owner): SumoPod first, Duitku optional. The sandbox
  variables from the owner's local `.env` were copied into `/etc/hermes-cloud/backend.env` (values never printed) with
  `SUMOPOD_ENV=sandbox`, `BILLING_GATEWAY=sumopod`, the callback URL set to the public API host, and the backend recreated: startup log shows
  billing on. From the internet, `POST /api/v1/billing/sumopod/webhook` with a `payment.test` body answers 200 with the right token and 400
  with a wrong or missing one. **Not verified:** a real invoice reaching `PAID` (the SumoPod sandbox cannot simulate payment), the receipt
  email, the NibieRouter credit after a payment. Neither gateway has KYC, so no real payment can happen and sign-up stays closed. The checkout
  fix (return the payment row that has `paymentUrl`) is in PR #34 and not on `main` until merged. Runbook: [billing-go-live.md](billing-go-live.md).
- **Sandbox payment verified end to end on the VPS (2026-11-17, owner's test account, plan `hosting`, Rp 25.000).** After the owner fixed the webhook URL in
  the SumoPod dashboard: the webhook arrived and was processed as `activated`, the payment became `PAID`, the subscription `ACTIVE` (30 days), and the
  instance was created and reached `ACTIVE`. The first attempt failed for two reasons worth keeping: the dashboard still pointed the webhook at an old URL, so no
  delivery reached the VPS and the payment stayed `PENDING`; and a pending invoice (valid 60 minutes) counts against `MAX_INSTANCES_PER_TENANT` (1), so a new
  checkout answers 409 `instance_limit_reached` until the invoice expires (the test invoice was marked `EXPIRED` by hand). **Not verified:** the receipt email
  (no send error in the log, inbox not checked), the `hosting-kredit` plan and its US$2 router credit, any real-money payment (needs KYC). To fix before opening
  sign-up: a customer who abandons checkout is locked out for an hour.
- **Backups.** Daily local `pg_dump` (19:00 UTC, newest 14 kept). New on 2026-11-17: `hermes-db-offsite` (19:30 UTC) copies the newest dump into the
  existing restic repository on Cloudflare R2 (tag `nibie-cloud-db`, same credentials as the older `hermes-r2-backup.sh`, which only covers
  `/opt/hermes`), and `hermes-restore-drill --from-r2` (Sundays 20:00 UTC) restores the newest snapshot into a throwaway Postgres with no network. Proven
  on the VPS on 2026-11-17: first upload OK, drill from R2 OK (3 plans, 2 tenants, 4 instances, 3 users, equal to the live database). **Not done:**
  tenant volume backups, a disaster-recovery rehearsal on a second server.
- **Host watchdog and `/readyz` are deployed (2026-11-17, image `2ab6462`), alerts are not live yet.** `GET /readyz` (loopback only; the public
  proxy answers 404) checks the database, Redis and Docker and answers only `ok` or the names that failed. `hermes-watchdog` (systemd timer, every
  minute) checks `/readyz`, the three core containers, disk, the freshness of the local dump, the public API and the TLS certificate age; it
  restarts only the backend container, after 3 failed checks in a row and at most 3 times an hour. Tested with a fake `docker` (alert at the third
  failure, one restart call, recovery message). It sends Telegram messages once `OPS_TELEGRAM_BOT_TOKEN` and `OPS_TELEGRAM_CHAT_ID` are set in
  `/etc/hermes-cloud/ops.env`; until then it only writes to the journal. **Not done from the autopilot plan:** the `OperatorAlert` table and emit
  points inside the backend (recovery exhausted, stalled provisioning, failed jobs), a daily summary with payment counts, customer emails on
  incidents. The branch `claude/project-thread-uym76i` named in earlier notes never reached GitHub, so this is a smaller rewrite, not that code.
  Incident during the test: a first test run used `sudo`, which ignored the fake `docker`, and restarted the real backend once (healthy again in
  seconds, no customer traffic then).
- **Owner to-do:** VPS auto-renew (the plan ends 2026-12-11), Telegram alert bot, SPF/DKIM/DMARC for the SumoPod sender, KYC at the chosen
  gateway, read the three legal drafts, test the admin pages.

- **Autopilot phase 1, backend alerts (2026-11-16, branch `claude/project-thread-uym76i`, NOT deployed).** The part PR #33 lists as "not done": the table
  `OperatorAlert` (migration `20261116230000_add_operator_alert`; enable row level security on it like the other `hermes` tables) and `src/modules/ops`:
  `Alerter` (dedupe per condition, repeat after 1 h critical / 6 h warning, immediate escalation, one recovery message, storm limit of 20 messages per
  10 minutes, token-like text removed), `createTelegramSink` through `safeFetch`, and `AlertScanner`, which runs inside the locked maintenance tick
  (at most once a minute) and raises alerts from state the platform already records: instance `DEGRADED` or `recovery_exhausted` after 10 minutes,
  `FAILED` (critical when the customer already pays), a verified payment without an instance after 15 minutes, router provisioning or credit grant
  stuck from 5 attempts, full tenant disk, exhausted queue jobs, plus a daily summary from 09:00 WIB. New optional env names
  `OPS_TELEGRAM_BOT_TOKEN` and `OPS_TELEGRAM_CHAT_ID` (together or neither; `deploy/backend.env.example`). The host watchdog and `/readyz` of PR #33 are
  untouched. Plan: [superpowers/plans/2026-11-15-operasi-autopilot-tanpa-admin.md](superpowers/plans/2026-11-15-operasi-autopilot-tanpa-admin.md).
  **Verified in a cloud sandbox:** `tsc`, unit tests (alerter, Telegram sink, config), the scanner against Postgres 16. **Not verified:** delivery to a real
  Telegram chat, a run on the VPS or against the production database volume. Not built: customer emails on incidents, plan phases 2-6.

## Where things stand

- **Git.** `main` was at `729f938` (merge of PR #32) when this was updated on 2026-11-17; PR #33 (`claude/prod-readiness`) carries the go-live
  changes below and is the checkout the VPS currently runs (`affd9d3` plus docs and ops scripts that are not deployed). `origin` is
  `https://github.com/habiibullahm/nibie-cloud` (public). Older notes saying `main` is at `6e5d644` are historical.
- **Milestone 1 (runtime foundation)** is complete: `src/` modules, Prisma migrations, `compose.yaml`,
  Vitest suite.
- **Milestone 2.2 (runtime security acceptance)** is partly done. The hardening baseline and the
  per-instance API key, runtime selection and strict readiness are wired into the provisioning and
  recovery path (`aa9e2c8`). Evidence lives in
  [milestone-2-runtime-security.md](milestone-2-runtime-security.md), a reconstruction that is
  **incomplete**: WS1-WS3 contents and the WS4b benchmark numbers are not recoverable, and gVisor
  was not re-run.
- **Design.** Root `DESIGN.md` (generated through https://design.dev/ai/design-md-generator, validated
  with `@google/design.md@0.4.0`) was revised in `7afcbce` together with `design-preview.html`.
- **Dashboard.** `apps/web` exists (`6e5d644`; plan:
  [superpowers/plans/2026-11-12-frontend-dashboard.md](superpowers/plans/2026-11-12-frontend-dashboard.md)).
  It is a preview: mock data by default, instance endpoints through a dev bridge in `live` mode,
  billing is a UI shell; sign-in, `/auth/confirm` (email links), `/set-password` and an auth gate are wired to Supabase Auth when `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` are set (PR #17, merged; verified with a real invite link on 2026-11-14: link, set password, login). The dashboard uses `basePath` `/dashboard` and runs as the Cloudflare Worker `nibie-cloud-web` (OpenNext adapter, Workers Builds from `main`, route `cloud.nibie.app/dashboard*`, PR #18, live since 2026-11-14). `NEXT_PUBLIC_HERMES_API_MODE=customer` (branch `feat/web-customer-api`, PR open) makes the browser call the customer API with the user's Supabase token (instances, `/me`, `/plans` real; rest preview); it is not enabled on the Worker until the backend side (`SUPABASE_URL`, `DASHBOARD_ORIGIN`, `BETA_ALLOWED_EMAILS`, plan rows) is confirmed on the VPS. See [../apps/web/README.md](../apps/web/README.md).
  Branch `fix/web-antislop-review` (PR #2) applies an antislop review: audit and report in
  `apps/web/anti-slop/`, 45 dashboard tests. It also gives outline and secondary buttons
  `border-strong` edges (approved by Nash, recorded in `DESIGN.md`).

- **Billing screens and NibieRouter credit (merged in PRs #24 and #25, 2026-11-15; backend deployed to the VPS with
  billing and the router OFF).** Plan:
  [superpowers/plans/2026-11-15-dashboard-billing-checkout.md](superpowers/plans/2026-11-15-dashboard-billing-checkout.md).
  Part A (`apps/web`): in `customer` mode the dashboard uses the milestone D billing endpoints (checkout then Duitku payment
  page, "Awaiting payment" cards, return-from-payment banner, renew, cancel renewal, grace/suspended banner, Start hidden
  while suspended); mock mode keeps sample subscriptions. Plan cards show `includedCreditUsd`. Verified in mock mode and with
  fake `fetch` only (83 tests); the Worker is not switched to `customer` mode for billing yet.
  Part B (backend, milestone E): `src/modules/nibierouter` creates one NibieRouter user per tenant, one key per instance
  (attached as the `NIBIEROUTER` provider, instance restarted) and a one-time credit (`Plan.includedCreditNano`, exactly once
  through `CreditGrant`) after the first payment; retried by the billing tick; off unless `NIBIEROUTER_ADMIN_KEY` and
  `NIBIEROUTER_DEFAULT_MODEL` (`nibierouter-free`) are set. Migrations `20261114135034_add_billing` and
  `20261115010000_add_nibierouter_credit` are applied on the VPS (database dumped first).
  **Verified on the real router (from the VPS, 2026-11-15):** create user, create key for a user, list keys, credit grant and
  the balance-history entry (the note is in `reference`). **Not verified:** the whole path after a real Duitku payment, a
  sandbox payment at all, the emails, Caddy routes (the VPS Caddy still serves the old Caddyfile, so the public billing routes
  and the Duitku callback answer 404 until it is recreated). The admin key used on the VPS has no IP restriction because the
  router's proxy does not yet pass the real client address in `X-Real-IP`; tighten it once it does. The Hosting + Kredit AI
  plan stays off sale until a paid flow works. Setup and operator steps: `docs/setup.md`, "NibieRouter key and credit";
  gaps: `docs/architecture.md` 9b.

- **Admin dashboard, phase A (read-only), branch `claude/project-thread-tirdms`, PR [#31](https://github.com/habiibullahm/nibie-cloud/pull/31), CI green (backend, docs, landing, t0, web).** Plan:
  `hermes-cloud/plans/2026-11-15-admin-dashboard-nibie-cloud.md` (owner decisions of 2026-11-15: panel at
  `/dashboard/admin` inside `apps/web`, MFA TOTP for every data-changing action, Indonesian UI, start with
  phase A). Backend: `src/http/admin-routes.ts` + `src/modules/admin/audit-service.ts`, a third Fastify
  plugin under `/api/v1/admin`, registered only when `SUPABASE_URL` is set. It verifies the same Supabase
  tokens as the customer API, then requires the email to be in the new `ADMIN_EMAILS` config (empty =
  nobody, fail closed); reads answer at `aal1`, mutations (phase B) will require `aal2`. Every route sends
  `cache-control: no-store`, the surface is rate-limited, and each request is written to the new `AuditLog`
  table (migration `20261115174608_add_audit_log`). Read routes: `me`, `overview`, `customers?q=`,
  `customers/:tenantId`, `instances?status=`, `instances/:id` (+`events`), `subscriptions`, `payments`,
  `plans`, `nodes`, `jobs/failed` (503 `queue_unavailable` without Redis), `audit`, `system`. Cursor
  pagination; the admin module never imports `secrets/secret-store` and never selects ciphertext or
  wrapped-key columns (test-enforced). Frontend: `apps/web/src/app/(app)/admin/*` (Ringkasan, Pelanggan
  +detail, Instance +detail, Langganan & pembayaran, Plan, Node, Job gagal, Audit), Indonesian, behind an
  `AdminGate` that asks `/admin/me` and shows "Tidak berwenang" for anyone else. The panel has **no mock
  data**: in `mock`/`live` mode every page renders "Panel admin butuh backend". Verified 2026-11-16 in the
  cloud sandbox: backend 26 integration + 32 unit admin tests pass (real Postgres on 5433, Redis on 6380);
  `apps/web` typecheck and lint clean, 97 tests pass, `next build` green with 8 admin routes; Playwright T0
  53 passed / 1 skipped, including 10 new admin specs (every admin route refuses to draw sample data, the
  sidebar link is hidden for a non-admin, no serious a11y violations). **Not verified:** against a real
  Supabase project or its JWKS, the real `ADMIN_EMAILS` on the VPS, Caddy for `/api/v1/admin/*`, any MFA
  TOTP flow (phase B), any deployment. Waiting on the owner: **A6** (Caddy allowlist, `ADMIN_EMAILS` in
  `/etc/hermes-cloud/backend.env`, migration, deploy) and **A7** (enable MFA TOTP in Supabase and enrol an
  authenticator). The billing/duitku type errors and the 33 `BILLING_GATEWAY` config failures in the shared
  working tree come from the SumoPod thread's uncommitted changes, not from this work.

- **Landing page (`apps/landing`, merged in PR #21, live on `cloud.nibie.app` since 2026-11-14).** Public
  site for `cloud.nibie.app` (root), needed for the Duitku KYC review: home, `/harga`, `/kontak`, Syarat Layanan,
  Kebijakan Refund, Kebijakan Privasi and a 404, in Indonesian. Standalone package (own `package.json`, lockfile),
  Next.js 16 static export, shadcn/ui and the `DESIGN.md` tokens, hairline-grid hero, light CSS-only motion.
  Deployed as the Worker `nibie-cloud-landing` (static assets only, `wrangler.jsonc`) on route `cloud.nibie.app/*`;
  `/dashboard*` and `/docs*` stay on their own Workers because their routes are more specific. The product name
  stays "Hermes Cloud", published by Nibie (`nibie.app`). Owner decisions of 2026-11-14 shown on the page: one
  template (Hermes Agent, 1 CPU, 1 GB RAM, 1 GB storage, Jakarta), two plans: Hosting Rp 50.000 (beta Rp 25.000) and
  Hosting + Kredit AI Rp 75.000 (beta Rp 50.000, with a one-time NibieRouter credit of US$2), beta prices for the
  first 100 beta users only; refund: full within 7 days of the first payment if the instance is unused, no refund
  otherwise, none for NibieRouter usage. The public contact email is **not in the repository**: it is the build
  variable `NEXT_PUBLIC_CONTACT_EMAIL` (Telegram is the fallback). `DESIGN.md` gained the marketing type tokens
  `display`, `h2` and `lead` (landing only; `@google/design.md lint`: 0 errors, 0 warnings). Verified in a cloud
  sandbox: `pnpm typecheck`, `pnpm lint`, 13 tests, `pnpm build`, the exported site served by `wrangler dev`
  (all routes 200, unknown path 404), Playwright at 1440 and 390 px (no horizontal overflow, no console errors).
  **Deployed 2026-11-14 (20:5x UTC):** the Worker `nibie-cloud-landing` was created in the Cloudflare dashboard
  (Workers Builds from `habiibullahm/nibie-cloud`, branch `main`, root directory `apps/landing`, build
  `pnpm install --frozen-lockfile && pnpm build`, deploy `npx wrangler deploy`, preview builds off, build variable
  `NEXT_PUBLIC_CONTACT_EMAIL`), the route `cloud.nibie.app/*` (zone `nibie.app`) was added, and the build was green.
  Checked in a real browser against https://cloud.nibie.app: `/`, `/harga`, `/kontak`, `/syarat-layanan`,
  `/kebijakan-refund`, `/kebijakan-privasi`, `/robots.txt`, `/sitemap.xml` answer 200, an unknown path answers 404,
  `/dashboard/sign-in` still answers 200 from the dashboard Worker, and the contact page links the public email.
  The docs site is live since 2026-11-15 (Worker `nibie-cloud-docs`, route `cloud.nibie.app/docs*`, so the
  "Dokumentasi" links work; `/docs/`, `/docs/quickstart`, assets and `/docs/api/search` answer 200, an unknown docs path
  answers 404). **Still open:** no real phone was used. The legal pages are drafts for
  the owner to read before publishing. The docs page "Paket dan penagihan" still says prices are not set, and
  the backend has no price data for these plans (`Plan.monthlyPriceIdr` is null); the US$2 credit needs a
  NibieRouter and backend integration that does not exist yet. See [../apps/landing/README.md](../apps/landing/README.md).
- **Self-service sign-up open on the landing page (2026-11-15, owner decision "asumsikan bisa bayar, KYC diproses, langsung rilis").**
  The main buttons ("Daftar dan pilih paket", "Pilih ...") now link to `/dashboard/register` by default; the build variable
  `NEXT_PUBLIC_SIGNUP_OPEN=false` brings back the email/Telegram invite (`apps/landing/README.md`). The dashboard register page links
  the real Terms, Privacy and Refund pages; the docs intro no longer says "private beta" or "price not set". Verified in a cloud
  sandbox: landing typecheck, lint, 23 tests and build (4 register links on `/`, no mailto), dashboard typecheck, docs typecheck and
  lint. **Not verified, owner steps:** billing is still OFF on the VPS (Duitku env, plan prices by SQL, dashboard `customer` mode;
  runbook: project file `billing/panduan-pilih-hosting-production.md`), so a visitor can register but cannot pay until those are done.
- **Rename to Nibie Cloud (2026-11-15, owner decision; uncommitted).** The product name is now "Nibie Cloud" (it was "Hermes
  Cloud"; the owner reversed the 2026-11-14 decision). Changed: landing (`SITE.name`, copy, legal pages), dashboard strings and
  metadata, billing emails (`Nibie Cloud` instead of `NibieCloud`), the Telegram test message, `DESIGN.md` (lint: 0 errors, 0 warnings),
  READMEs, the deploy file headers. Not changed on purpose: package names (`@hermes-cloud/*`, `hermes-cloud`), the repository,
  Docker and compose names, historical docs (`prd.md`, `architecture.md`, handoffs), and "Hermes" as the name of the hosted agent.
  Verified in the sandbox: backend `tsc`, email and Duitku unit tests, landing typecheck, lint, 13 tests and build (no
  "Hermes Cloud" left in the export), dashboard typecheck, lint and 62 tests. The live site changes only after a merge to `main`.
- **Browser end-to-end tests (`e2e/`, 2026-11-15, Nash approved the plan and its recommendations; branch `claude/project-thread-r1cipl`).**
  Plan: [superpowers/plans/2026-11-15-browser-automation-testing.md](superpowers/plans/2026-11-15-browser-automation-testing.md).
  Standalone Playwright package with three tiers: T0 (landing export and dashboard on mock data, no secrets), T1 (customer-mode
  dashboard + real backend + stub containers + Supabase Auth; 2026-11-15 owner decision: use the existing project `nibie-cloud-sgp` with three
  hand-made confirmed accounts and no service-role key anywhere, instead of a new test project) and T2 (read-only production smoke test).
  Workflows: `.github/workflows/e2e.yml` (T0 on pull requests that touch `apps/web`, `apps/landing` or `e2e`; T1 on push to `main`,
  nightly and manual, skipped with a notice until the secrets `E2E_SUPABASE_URL`, `E2E_SUPABASE_PUBLISHABLE_KEY` and `E2E_USER_PASSWORD` exist; T2 nightly and manual) and `ci.yml`
  (type-check, lint and unit tests of all four packages; the repository had no CI before). **Verified in a cloud sandbox:** T0
  all green in Chromium, `e2e` type-check, the database and seed steps of `stack:prep` against a local Postgres 16, backend
  `tsc` and 462 unit tests, dashboard 83 tests, landing 13 tests. **Not verified:** all of T1 (needs the Supabase test project
  and a Docker daemon), T2, and the GitHub Actions runs themselves. Not built: Duitku callback/suspension tests (P1 #11, #12) and
  provider/Telegram tests (#13). T0 found three product issues, recorded as known findings in the specs: landing `<dl>` with a
  `role="img"` child, the sign-in "Create an account" link distinguished by color alone (2.31:1), and focus not returning to
  the trigger after a Stop/Restart dialog closes. Commands and setup: [../e2e/README.md](../e2e/README.md).
- **Planned next (not built):** dashboard billing and checkout plus NibieRouter credit and key provisioning, see
  [superpowers/plans/2026-11-15-dashboard-billing-checkout.md](superpowers/plans/2026-11-15-dashboard-billing-checkout.md).
- **Multi-platform note (2026-11-14, owner request).** Hermes runs one gateway for many messaging platforms; the
  official Nous docs (https://hermes-agent.nousresearch.com/docs/user-guide/messaging/) list Telegram, Discord, Slack,
  Google Chat, WhatsApp, Signal, SMS, Email, Mattermost, Matrix, Microsoft Teams, LINE, IRC and more ("20+"), each with
  its own credentials and a deny-by-default allowlist. Hermes is MIT-licensed (LICENSE read; no trademark or
  hosted-service terms were found, but the README and per-platform pages were not verified). `docs/prd.md` section 9 now
  separates upstream capability (9.1) from what Hermes Cloud builds (9.2: only Telegram is wired; other platforms need
  credential, egress, inbound-traffic and allowlist specs first) and adds open decision 13. The docs site intro and
  Telegram page and the landing page say "Telegram now, other platforms later" without naming dates.
- **Backend milestone A (customer API).** On branch `claude/project-thread-b5f2bk`, rebased onto the egress controls merge
  (`a8d86fd`): Supabase token verification (`src/modules/auth`), `User` and `TenantMember`
  models with a new migration, a customer API next to the operator API (`src/http/customer-*.ts`),
  CORS, rate limits, a beta provisioning gate and a per-tenant instance cap. Spec:
  [superpowers/specs/2026-11-12-backend-design.md](superpowers/specs/2026-11-12-backend-design.md);
  plan: [superpowers/plans/2026-11-12-backend-milestone-a-auth-customer-api.md](superpowers/plans/2026-11-12-backend-milestone-a-auth-customer-api.md).
  Milestone D (Duitku POP billing) was designed in the spec first and is described further below.
- **Backend milestone B (jobs), on branch `claude/milestone-b-jobs-plan`, not committed.** Redis + BullMQ:
  create/start/stop/restart/delete run as jobs when `REDIS_URL` is set (required in production), the API
  answers `202` with a `jobId`, transient errors retry 4 times with backoff, exhausted jobs are listed and
  retried by the operator (`/api/v1/jobs/failed`), and the reconciler plus a `PENDING` sweeper run as a
  scheduled job under a Redis lock. Without `REDIS_URL` everything runs inline as before. Plan:
  [superpowers/plans/2026-11-13-backend-milestone-b-jobs.md](superpowers/plans/2026-11-13-backend-milestone-b-jobs.md);
  how it works and its known gaps: [architecture.md](architecture.md), [setup.md](setup.md#job-queue-redis-and-bullmq).
  Redis for the beta is decided: same VPS, Docker Compose, loopback with a password.
- **Backend milestone C (secrets, providers, Telegram), on branch `claude/project-thread-b5f2bk`, not committed.**
  A customer attaches an AI provider (own key, or NibieRouter attached by the operator) and a Telegram bot to
  an instance. Credentials are envelope-encrypted (`SECRETS_KEK` from the environment, versioned, rotated by
  `POST /api/v1/secrets/rewrap`), never returned, logged or put in Redis payloads, and reach the container as
  env vars plus a seeded `model:` block in `config.yaml`; a change recreates the container at the next
  start/restart (volume kept). Control-plane calls to Telegram and to provider URLs go through an SSRF-safe
  fetch. Customers read redacted logs (`GET /instances/:id/logs`). Secrets are purged after the runtime is
  removed on delete. Plan: [superpowers/plans/2026-11-13-backend-milestone-c-secrets-providers-telegram.md](superpowers/plans/2026-11-13-backend-milestone-c-secrets-providers-telegram.md);
  decision and evidence: [adr/0003-hermes-config-delivery.md](adr/0003-hermes-config-delivery.md); how to run it
  and rotate the key: [setup.md](setup.md#secrets-provider-keys-and-telegram). Not built: AI usage metering,
  per-tenant NibieRouter key minting, a secrets manager (KEK stays an env var for the beta, backup in the
  password manager). Milestone D (Duitku POP billing) is below.
- **Backend milestone D (Duitku POP billing and billing emails), on branch `claude/project-thread-bprg8j`, not committed.**
  Customers buy a 30-day subscription per instance through Duitku POP (virtual account and QRIS are chosen on Duitku's
  hosted page): `POST /subscriptions/checkout` returns a payment URL, a signature-verified, idempotent callback
  (`POST /api/v1/billing/duitku/callback`) activates or renews, and the instance is created only after the first
  verified payment. A billing tick walks the PRD 10 lifecycle (reminders 7/3/1 days before the end, 3 days of grace,
  suspension with the instance stopped and its volume kept, 30 days of retention, deletion) and sends Indonesian emails
  over SumoPod SMTP. `Plan.monthlyPriceIdr` is nullable (`null`: not for sale); `scripts/seed-sandbox-plans.ts` sets a
  sandbox test price. The `BETA_ALLOWED_EMAILS` free path is unchanged. Plan:
  [superpowers/plans/2026-11-14-backend-milestone-d-duitku-billing.md](superpowers/plans/2026-11-14-backend-milestone-d-duitku-billing.md);
  how to run it: [setup.md](setup.md#billing-duitku-pop); design and gaps: [architecture.md](architecture.md) ("Billing", gap 9a).
  **Verified:** `tsc` clean; unit tests (Duitku signature vectors, lifecycle rules, templates, mailer, config) and
  integration tests against a real Postgres with a fake Duitku, fake mailer, fake runtime and an injected clock
  (service, HTTP callback, tick). **Not verified:** a real sandbox invoice and callback (Task 0 of the plan: needs the
  owner's sandbox credentials on a machine that can reach Duitku), real SumoPod delivery, the Docker-based integration
  tests (no daemon in the sandbox that built this), and deployment. Not built: callback IP allowlist, plan upgrade or
  proration, refunds, a billing screen in `apps/web`, production go-live (the Duitku merchant is still being verified).
- **SumoPod Managed Payment fixes, verified 2026-11-16 against the real sandbox.** Three defects found while testing an
  actual check-out, all fixed in `src/modules/billing`: (1) `sumopod-client.ts` never sent a return URL, so SumoPod fell
  back to the project's dashboard Redirect URLs and the payer landed on the production site after paying a sandbox
  invoice — it now sends `success_return_url`/`cancel_return_url` from `InvoiceRequest.returnUrl`; (2)
  `handleSumoPodWebhook` read `order_id`/`status` from the top level, but SumoPod sends a svix-style envelope
  `{ event_type, data: { … } }` — every real `payment.completed` answered 400. It now reads `data`, still accepts a flat
  body, and acknowledges `payment.test` with 200; (3) the handler passed SumoPod's word `status` straight through as
  Duitku's `resultCode`, and `applyInTransaction` treats only `'00'` as paid — a genuine SumoPod payment would have been
  written `FAILED`. Paid word statuses are now normalized to `'00'`. **Verified:** `tsc` clean; 479 unit tests pass,
  including new `test/unit/sumopod-webhook.test.ts` (5 tests); SumoPod's own "Save & Test" delivers to a real local
  backend and gets 200 (`outcome: ignored_failure`). **Not verified:** a real invoice reaching `PAID` through SumoPod —
  its sandbox has no simulate-payment control, so activation, `ensureInstance`, the receipt email and the redirect all
  remain untested end to end. The webhook URL is configured in the SumoPod dashboard only;
  `SUMOPOD_CALLBACK_URL` in `.env` is dead code that `sumopod-client.ts` never reads.
- **Owner decisions recorded on 2026-11-12:** Supabase Auth and Supabase managed Postgres (schema
  `hermes`), Duitku POP, Resend (sender on a verified domain), Cloudflare for DNS and the dashboard,
  R2 for backups, dashboard at `cloud.nibie.app/dashboard`, API at `api.cloud.nibie.app`, NibieRouter
  is a SumoRouter instance at `https://router.nibie.app/v1`. Open items are in section 9 of the spec.
- **Owner decision on 2026-11-14: email goes through SumoPod SMTP (`smtp.sumopod.com`), not Resend,** for both
  Supabase Auth email and the backend. The backend does not send any email yet (the first sender is milestone D,
  billing reminders); it only parses the optional `SUMOPOD_SMTP_HOST`, `SUMOPOD_SMTP_PORT`, `SUMOPOD_SMTP_USER`,
  `SUMOPOD_SMTP_PASS` and `MAIL_FROM` (all five or none, `config.mail`, uncommitted). No SMTP client library is
  installed and nothing has been sent through SumoPod from this repository.

## First VPS deployment (2026-11-13, files in `deploy/`)

Milestones A and B (`main` at `edb7d62`) run on the owner's single VPS (Ubuntu 24.04, kernel 6.8, Docker 29.9,
cgroup v2) with Docker Compose: Redis, the backend and Caddy in `NODE_ENV=production` with
`HERMES_DISK_QUOTA=enforce` (XFS with project quota on a loop image) and `HERMES_EGRESS_POLICY=enforce`.
Verified there, from real command output: image build, migrations on Supabase, TLS, the public boundary
(operator routes 404, 401 without token, CORS), a real login and an instance reaching `ACTIVE` with the
official Hermes image on `runc` in about 21 seconds, the XFS quota on the tenant volume, egress rules
rejecting private and metadata ranges from the tenant bridge, a clean delete (no container, volume, network or
bridge left), and a reboot with everything coming back by itself. This supersedes "no run on the VPS" and
"nothing has seen tenant traffic yet" in [egress-host-notes.md](egress-host-notes.md) for those checks only.
Milestone C (PR #8) was merged afterwards and is **not deployed**: the VPS still runs the A and B build; updating
needs `SECRETS_KEK` (required in production), the new migration and a rebuild.
Order of work, the full verified list and pitfalls: [../deploy/README.md](../deploy/README.md).

**Update, later on 2026-11-13 (from real command output on the VPS):**

- **Milestone C is deployed.** The checkout is `main` at `95228b9`, image tag `95228b9` (`edb7d62` kept for
  rollback), `SECRETS_KEK` is set, migration `20261113162824_add_secrets_and_integrations` is applied (6 of 6),
  startup logged the egress canary passing and `secretStore:true`, and the public boundary checks still hold
  (`/healthz` 200, operator routes 404, `/api/v1/plans` 401). No credential route was exercised with a real
  provider key or Telegram token on the VPS.
- **Database backup exists.** `/usr/local/sbin/hermes-db-backup` runs `pg_dump` 17 (schemas `hermes` and `auth`,
  custom format) into `/var/backups/hermes-cloud`, daily at 19:00 UTC by a systemd timer, newest 14 kept. The
  first dump was read back with `pg_restore --list` (35 tables). A restore was not rehearsed, the dumps live
  only on the VPS (no copy to R2 yet), and tenant volumes are still not backed up.
- **gVisor: the pids fix works, but a new blocker was found (2026-11-13, deployed `d2778aa`).** With the egress
  canary's `PidsLimit` raised to 256 under `runsc` (PR #10), the backend starts cleanly under `HERMES_RUNTIME=runsc`
  (canary passed in ~9 s) and a full lifecycle on a real tenant container succeeded: `ACTIVE` in ~19 s (vs ~21 s
  under `runc`), correct `Runtime`/`PidsLimit`/memory/CPU limits, the XFS quota held, the `HERMES-EGRESS` rules
  rejected the metadata address and a private range while the public internet stayed reachable, and restart,
  stop/start and delete all worked cleanly (container, volume, network and bridge all gone after delete).
  **Blocker found: DNS did not resolve inside a `runsc` tenant container.** `curl` to a public IP worked, `curl`
  to a hostname failed (`could not resolve host`). Docker gives tenant containers its embedded resolver at a
  loopback address in `/etc/resolv.conf`; that resolver is not reachable from inside the gVisor sandbox. An
  agent would not have been able to reach a model provider or Telegram by name under `runsc`.
  **Fix built and deployed (2026-11-14, `main` at `515d061`, VPS image tag `515d061`), retested, still not
  enough.** `HERMES_DNS_RESOLVERS` gives tenant containers explicit DNS resolvers via Docker `HostConfig.Dns`;
  `docker inspect` confirmed `Dns=["1.1.1.1","9.9.9.9"]` on the `runsc` tenant container. **Hostnames still did
  not resolve inside it**: `getent hosts`, Python `getaddrinfo` and `curl` by hostname all failed, while a raw
  DNS query sent straight to `1.1.1.1:53` from inside the same container got a real answer, and
  `curl --resolve` (IP pinned by hand) reached `https://example.com` with a 200. The container's own
  `/etc/resolv.conf` still read `nameserver 127.0.0.11` — `HostConfig.Dns` only changes where Docker's
  *embedded* resolver forwards to, it does not change what the container itself queries, and the embedded
  resolver at `127.0.0.11` is the part unreachable from inside the gVisor sandbox. So the real fix still
  needed is to put the public resolvers directly into the tenant container's own `resolv.conf` (e.g. a
  generated file bind-mounted in, bypassing Docker's embedded resolver entirely), not just set `HostConfig.Dns`.
  Everything else from the first `runsc` retest still passed on `515d061`: pids/memory/CPU limits, the XFS
  quota, `HERMES-EGRESS` rejecting the metadata address and a private range while the public internet stayed
  reachable, restart, stop/start and a clean delete (container, volume, network and bridge all gone).
  Required when `HERMES_RUNTIME=runsc` (startup now fails loudly without it, like `HERMES_CANARY_IMAGE` under
  egress enforcement); optional and a no-op under `runc`, which keeps today's behaviour. A resolver on a
  private address still needs a matching `RESOLVERS` entry in `ops/egress/egress.conf`. See
  [setup.md](setup.md#configuration).
  **Second fix built, deployed and retested (2026-11-14, `main` at `9d33abc`, VPS image tag
  `9d33abc`): fixed.** Instead of relying on `HostConfig.Dns`, the resolvers now seed a dedicated
  Docker volume (`hermes-dns-resolv-conf`, `dns-resolv-conf.ts`) with a plain `resolv.conf`, written
  by a short-lived container using `HERMES_CANARY_IMAGE` (now required under `runsc` too, not only
  under egress enforcement). Every `runsc` tenant container bind-mounts that one file over its own
  `/etc/resolv.conf` (`hardening.ts`'s `HostConfig.Mounts`, `Subpath: 'resolv.conf'`), bypassing
  Docker's embedded resolver entirely instead of trying to make it reachable. `HostConfig.Dns` is
  still set alongside it (harmless). On the VPS, inside a real `runsc` tenant container:
  `/etc/resolv.conf` read `nameserver 1.1.1.1` / `nameserver 9.9.9.9` (no `127.0.0.11`), `getent
  hosts example.com` and Python `getaddrinfo` both resolved, and `curl https://example.com` and
  `https://api.telegram.org` both got a response (200 and 302). Resolution kept working after a
  restart and after stop/start. Everything from the earlier `runsc` checks still passed on
  `9d33abc` too: limits, the XFS quota, `HERMES-EGRESS` rejecting the metadata address (timed out
  this run instead of refusing at once, but the reject counter still rose) and a private range while
  the public internet stayed reachable, restart, stop/start and a clean delete; the shared
  `hermes-dns-resolv-conf` volume correctly survived the test instance's delete. **gVisor is now
  verified working end-to-end, including DNS.** Nash approved the switch the same day: the VPS env
  now has `HERMES_RUNTIME=runsc` (set 2026-11-14 13:03 UTC), backend recreated and confirmed healthy
  (canary passed, then `"resolvers":2,"msg":"tenant dns resolv.conf ready"`), loopback and public
  `/healthz` both 200. No instances were live at the switch; new instances are created under
  `runsc`, existing ones would keep their runtime until recreated. One stale `ConflictError` row was left in
  `GET /api/v1/jobs/failed` from a test script mistake during an earlier retest (harmless, kept 7
  days). `xfs_quota` leftover project ids keep accumulating, one per deleted instance (3 now;
  harmless so far, see below).
- **Supabase Auth email does not go through a custom SMTP server yet.** The auth log of 2026-11-13 shows the
  confirmation email sent by Supabase's built-in sender, and requests came from `http://localhost:3000`. Custom
  SMTP (SumoPod, see the 2026-11-14 decision above), Site URL and Redirect URLs are set in the Supabase dashboard
  by the owner.

**Not verified, still open:** backups of tenant volumes (none exist); whether stale XFS project ids
pile up after deletes keeps being confirmed (now 3 emptied entries, harmless so far but unbounded);
Redis AOF recovery after a crash,
several replicas, customers reaching their agent from the internet, and the database password rotation
(the first password was exposed in a chat and must be rotated). The deploy files are a snapshot of what ran;
they have no automated test.

## Verified tests

Milestone C run, 2026-11-13, cloud sandbox (Node 22, Postgres 16, Redis 7 with `noeviction`, Docker 29.9.2, stub image):
`pnpm build` clean; `pnpm test` 676 passed, 2 skipped (56 files), after the review fixes. Real Docker was used for the config seeding, recreate and
log tests; the config delivery was also checked once against the official image (ADR 0003). **Not verified:** a real model
reply through a real provider, a real Telegram bot, the egress rules letting Telegram traffic through on a real host,
several API replicas, real Supabase, any VPS run.

Milestone B run, 2026-11-13, cloud sandbox (Node 22, local Redis 7.0 without AOF, Postgres 16, Docker
29.9.2, stub image): `pnpm build` clean; `pnpm test` 467 passed, 2 skipped (43 files). A manual run of the
real `src/main.ts` with Redis, Postgres and Docker (stub image) provisioned an instance through the job
queue, accepted a create while Redis was down (`PENDING`, `jobId: null`) and recovered it after Redis was
restarted and flushed (that manual run predates the review fixes: the full suite was re-run after them). **Not verified:** Redis with AOF across restarts, several API replicas on one Redis,
the real Hermes image under the worker, any VPS run.

Milestone A run, 2026-11-12, cloud sandbox (Node 22, pnpm 10.28.0, local Postgres 16, Docker 29.9.2,
stub image), after rebasing onto `a8d86fd`: `pnpm build` clean; `pnpm test` 409 passed, 2 skipped
(34 files, unit and integration). Tokens in these tests are signed with locally generated keys. **Not verified:**
a real Supabase project or its JWKS, Supabase Postgres (no migration run there), CORS from a real
browser, any deployment on the VPS, the dashboard against the customer API.

Earlier baseline:

Re-run on 2026-11-12 in a cloud sandbox at `6e5d644` (Node 22, pnpm 10.28.0):

- Backend: `pnpm build` (`tsc --noEmit`) clean; `pnpm test:unit` 89/89 passed.
- Dashboard (`apps/web`): `pnpm typecheck` clean, `pnpm lint` clean, `pnpm test` 44/44 passed.
  `pnpm build` was not run.

Reported earlier the same day on another sandbox (Docker 29.9, cgroup v1, Postgres 16, runc only) and
**not re-run since**: 101/101 integration tests against the stub image; live harness on the official
image, 21 checks before the runsc step passed; one-off end-to-end run on the official image reached
ACTIVE with strict readiness. Details and caveats: [milestone-2-runtime-security.md](milestone-2-runtime-security.md).

Not verified anywhere: gVisor (`runsc`) runs, cgroup v2 or a production host, behaviour under a real
model backend, any run on the owner's Windows workstation (reported to have no `node_modules` or pnpm).
Earlier claims of "25/25 live checks on runc and runsc" and the `@google/design.md` lint/export results
have not been reproduced.

## Disk quota (merged to `main` in PR #3)

Re-run in a cloud sandbox (Docker 29.9, ext4, Postgres 16): `pnpm build` clean; `pnpm test:unit`
135/135; integration files that need only Postgres (`disk-wiring`, `disk-monitor`, `key-wiring`,
`schema`) pass. Docker-backed integration tests could not run there because the stub image build was
blocked by Docker Hub rate limiting (HTTP 429), so the new `runtime-manager` integration test for the
unquotaed-volume refusal has not run; the same behaviour was checked once with a throwaway script
against the real daemon. Not verified: kernel enforcement on XFS, `runsc`, a live DiskMonitor run.

Starting an existing container is guarded too: with `HERMES_DISK_QUOTA=enforce`, a user start or
restart and the reconciler's restart check the volume first (`RuntimeManager.assertVolumeQuota`) and
refuse an absent or unquotaed volume (`volume_quota_missing`; user start/restart answer 409 and the
instance keeps its previous status). Known and deferred: a refused reconciler restart is recorded as
`recovery_failed`, not `volume_quota_missing`, and `disk.quota_mismatch` is written on every
`ensure()` while the mismatch lasts, not once.

## Egress controls branch (`feat/egress-controls`)

Plan: [superpowers/plans/2026-11-12-egress-controls.md](superpowers/plans/2026-11-12-egress-controls.md);
spec: [superpowers/specs/2026-11-12-egress-controls-design.md](superpowers/specs/2026-11-12-egress-controls-design.md).
Tasks 1, 3, 4, 5, 6 and 7 are done; **Tasks 2 (host spike, from step 3 on) and 8 (live verification) are
open** and need a Docker host that can run containers.

Run in a cloud sandbox (Docker 29.9.2, nf_tables `iptables` 1.8.10, Postgres 16): `pnpm build` clean;
`pnpm test:unit` 209/209; the Postgres-only integration files (`network-policy`, `disk-wiring`,
`key-wiring`, `disk-monitor`, `schema`, plus the real-daemon canary test) 44 passed, 2 skipped (the two skipped need
a canary image and the rules); `shellcheck` clean on `ops/egress/hermes-egress.sh`. Also run once by
hand: the ruleset applied for real (idempotent, `remove` and `status` behave), `DockerRuntimeManager`
network creation against the real daemon (bridge name honored, stale network and collision refused), and
the control plane exiting with the fixed canary message when the canary image is missing.

**Not verified, so do not claim it:** that tenant traffic is blocked on a real host (no container could
be started in the sandbox: Docker Hub rate limiting blocked every image pull), the canary with a real
image (neither the "rules absent" nor the "rules applied" case), runc and runsc behaviour, rule
persistence across a Docker restart and a reboot, DNS on the real host, the live harness egress checks
(`test/validation/egress-checks.ts`, never run), and the new-connection cap, which is an unmeasured
placeholder (`NEW_CONN_RATE=200/sec`). Details: [egress-host-notes.md](egress-host-notes.md).

Known and deferred (final review, Minor): the reuse check does not look at `EnableIPv6` on an existing
network; a container that was already running on a pre-policy network keeps running unfiltered and is
not reported at startup (there are no production tenants yet); DNS to the configured resolvers and
`ip:port` exceptions are not covered by the new-connection cap.

New files: `ops/egress/` (script, example config, systemd unit), `src/modules/runtime/egress-canary.ts`,
[runbook-egress.md](runbook-egress.md), [egress-host-notes.md](egress-host-notes.md). New configuration:
`HERMES_EGRESS_POLICY`, `HERMES_CANARY_IMAGE`, `HERMES_CANARY_PRIVATE_IP` ([setup.md](setup.md)). New
failure reason: `network_policy_missing`.

## Known issues

- `docs/milestone-2-runtime-security.md` is a partial reconstruction (see above). Two of the 25
  live-harness checks cannot fail, so the real count is lower.
- The stub returns 401 for everything when no `API_SERVER_KEY` is set; the official image's behaviour
  without a key is unchecked.
- Rotating `HERMES_MASTER_KEY` invalidates running instances' keys until their containers are recreated
  ([setup.md](setup.md#recreating-an-existing-instances-container)).
- `npx @google/design.md ...` hangs on the update check; invoke the local binary directly
  (`node <pkg>/dist/index.js ...`) or pin and install it first.
- Docker-published ports bypass UFW on the reference host; egress policy lives in `DOCKER-USER`/`INPUT`.
- gVisor is compatible but non-default; `runc` stays the default.
- Observed and unresolved: HTTP 400 rejection of a `c:`-prefixed URL on the provider/tool path of the
  local Hermes tooling. Not diagnosed, not reproduced, not fixed. Do not claim otherwise
  ([HANDOFF_TO_CLAUDE.md](HANDOFF_TO_CLAUDE.md), section E).
- Production blockers are listed in [architecture.md](architecture.md#known-gaps-and-deferred-security-work).

## Open decisions and next steps (owner)

- Whether `design-preview.html` is visually approved. The previous docs said "awaiting approval";
  `apps/web` was built afterwards and no document records the approval.
- `DESIGN.md` prose for the terracotta and focus-ring rules is awaiting the owner's alignment with the
  decisions already applied in code (terracotta only on the primary button fill, checked checkbox and switch-on track; neutral
  focus ring). `apps/web/README.md` already follows them.
- Re-run the live harness on a host with gVisor (ideally cgroup v2) and fill the "Verification run"
  section of [milestone-2-runtime-security.md](milestone-2-runtime-security.md).
- Disk quota is merged (PR #3). Not verified on an XFS host: the plan's Task 1 (host spike) and
  Task 8 (live verification) are still open, see [disk-quota-host-notes.md](disk-quota-host-notes.md).
- Egress controls are implemented on branch `feat/egress-controls` and await review. They are not
  verified on a Docker host (plan Tasks 2 and 8), see [egress-host-notes.md](egress-host-notes.md). The
  location of NibieRouter (public URL or private address needing an exception) and the abuse policy
  (PRD 21 item 11) are still undecided.

## Customer docs site (`apps/docs`), 2026-11-12

- New standalone package `apps/docs` (Fumadocs, Next.js 16, static export, `basePath` `/docs`) for
  `cloud.nibie.app/docs`. Content in Indonesian, written from `docs/prd.md` and the backend spec only;
  unfinished features and the whole API reference carry `Draft` callouts. No prices are stated.
- Verified in a cloud sandbox: `pnpm typecheck`, `pnpm lint`, `pnpm build` (20 pages + static search
  index), Playwright at 1440 and 390 px (no console errors, no horizontal overflow, search works).
- Deployed 2026-11-15 as Cloudflare Worker `nibie-cloud-docs` (Workers Builds from `main`, root `apps/docs`, route
  `cloud.nibie.app/docs*`); see `apps/docs/README.md`.
- Not done:
  `@google/design.md` lint not run; fumadocs callout icon colours (blue, amber, red) are library
  defaults, not `DESIGN.md` tokens, and need an owner decision.
