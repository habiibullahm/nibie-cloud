# Current State — Hermes Cloud

Last updated: 2026-11-18 (docs refresh, see the first section). Earlier entries below keep their own dates, and
several still describe branches as "not committed" or billing as "OFF" that have since merged or changed; the first section and
[HANDOFF.md](HANDOFF.md) win. Index of all docs: [README.md](README.md). New session? Start with [HANDOFF.md](HANDOFF.md) and [START_PROMPT.md](START_PROMPT.md).

## Back from BYOK to the NibieRouter key (2026-11-21, branch `claude/restore-nibierouter`, not merged)

Owner: own keys (BYOK) may use any model, the default stays NibieRouter, and a customer must be able to go back to it.
Before, saving BYOK was one-way: the dashboard disabled the NibieRouter choice and the provisioner never ran again.
- `POST /api/v1/instances/:id/providers/nibierouter` (customer, 5 per minute) calls `RouterProvisioner.restore`: revokes every
  unrevoked `inst-<id>` key of the tenant's router user (BYOK had dropped its secret but left it live), creates a new one,
  attaches it as `NIBIEROUTER` with `NIBIEROUTER_DEFAULT_MODEL` and restarts the instance if it is running (a stopped or
  suspended one is not started; the key applies on its next start). Already on NibieRouter: no change.
  A router error leaves the customer's own key in place.
- Dashboard: the NibieRouter choice on Configuration is no longer locked; saving it calls the route.
- Model rules unchanged: BYOK has no model limit; the default provider on a free plan offers free models only.
- Known gap: saving BYOK still does not revoke the `inst-` key on the router at that moment; `restore` cleans it up later.
  Two restores at the same instant can leave one extra unrevoked key whose secret nobody holds (`shortcut:` in the code).

## Host capacity on the admin Node page (2026-11-21, branch `claude/node-capacity`, not merged)

Owner: "buat kapasitas di Node", without adding backend load.
- `ops/host/hermes-usage.sh` (the existing 5-minute timer) also replaces `/var/lib/hermes-usage/node.json`: RAM total/used/available,
  1-minute load and core count, disk of `/` and of `/var/lib/docker/volumes`, running tenants and their summed RAM.
- `deploy/compose.prod.yaml` mounts `/var/lib/hermes-usage` read-only into the backend. `GET /api/v1/admin/nodes` adds `host`
  (`src/modules/admin/host-usage.ts`: one small file read per request, zod-checked, null when missing or malformed). The
  backend runs no `docker stats` and polls nothing for this. One snapshot for the one host (shortcut until multi-node).
- Dashboard Node page: "Kapasitas host" card with RAM, system disk and customer-volume disk bars (numbers and percent in text),
  CPU load, the snapshot age (marked old after 15 minutes) and an estimate of how many more instances fit under the 70 % RAM
  rule (`apps/web/src/lib/host-capacity.ts`: average of the running instances, or 400 MB idle when none run).
- Host scripts installed on the VPS on the owner's word ("install drill and install usage", 2026-11-20 18:39 UTC; old copies
  `/usr/local/sbin/*.bak-20261120T183928Z`). `node.json` is written. The Node page shows it once the backend is recreated
  with the new mount (the deploy after merge). The first drill install was CRLF (from the Windows worktree) and failed
  `bash -n`; reinstalled as LF a minute later, and `.gitattributes` now forces LF for `ops/host/*`.

## Caddy allowlist missed the AI routes (2026-11-21, branch `claude/caddy-ai-routes`, not deployed)

The dashboard showed CORS errors on `GET /api/v1/ai` and `GET /api/v1/ai/models`. Cause: `deploy/Caddyfile` did not forward
`/api/v1/ai*`, so Caddy answered its own `404 not found` with no CORS headers. Fix: `/api/v1/ai` and `/api/v1/ai/*` added to
the `@public` matcher, plus a test in `test/integration/billing-api.test.ts`. The VPS Caddy needs the new file and a reload.

## Production test data cleaned (2026-11-20)

Owner: "clean all testing data" (all test instances; keep accounts; keep billing records; dump first).
- Dump `/var/backups/hermes-cloud/hermes-20261120T135124Z.dump` taken first (`hermes-db-backup`).
- The 3 test instances (`aaaa`, `free plan testing`, `Habib testing paid 25k`) deleted through the operator API on the host:
  all `DELETED`, no tenant container, volume or network left on jkt-1. Their subscriptions were set `ENDED` by SQL (the
  operator delete does not call `endForInstance`; only the customer route does).
- Their `inst-` NibieRouter keys, plus a leftover one of instance `8bf59a00` (deleted 2026-11-18), were revoked by hand:
  **instance delete does not revoke the router key** (gap, not fixed).
- Kept: all 6 customer accounts and router users. Later the same day the owner cleared the billing and admin history too
  (owner ran the SQL in the Supabase SQL editor after a fresh dump `hermes-20261120T180400Z.dump`): `Payment`, `PaymentEvent`,
  `Invoice`, `InvoiceCounter` (the next invoice is number 1), `WalletEntry`, `WalletTopup`, `BillingNotice`, `Subscription`,
  `WaitlistEntry`, `BetaInvite`, `AuditLog` are empty; wallet balances 0.
- Host: the old standalone `hermes-agent` (compose project `hermes` in `/opt/hermes`, from 2026-11-11, not a tenant) was
  removed with `docker compose down`; its files in `/opt/hermes` are kept. 11 unattached volumes were removed by name
  (6 Postgres data dirs, 3 old Hermes data dirs, `v-ws4b-runsc`, `ws4-runsc-vol`); left: Caddy x2, Redis,
  `hermes-dns-resolv-conf` (managed, unattached by design: never `docker volume prune`).
- Cause of the Postgres leftovers: `ops/host/hermes-restore-drill.sh` removed its container without `-v`; fixed to
  `docker rm -fv` on branch `claude/node-capacity`; the installed `/usr/local/sbin/hermes-restore-drill` needs reinstalling.

## NibieRouter step 4: buying AI credit from the wallet in Rupiah (2026-11-20, branch `claude/ai-credit-wallet`, merged `de11115`)

Plan: AI credit in Rupiah through NibieRouter, PR C of 3 (owner: "PR C, buying AI credit from saldo in Rupiah"). The customer
types Rupiah, not US$ as the older wallet plan said, matching the Rupiah AI balance of PR B.
- **Backend:** migration `20261120500000_ai_credit_purchase` (additive): `CreditGrant.subscriptionId` nullable, new
  `amountIdr`, `idempotencyKey`, unique `(tenantId, idempotencyKey)`, and a CHECK that a row is either a plan credit or a
  purchase. `POST /ai/credit` (`Idempotency-Key`, `{ amountIdr, captchaToken? }`, Rp 10.000 to 1.000.000, only with
  `WALLET_ENABLED`): one transaction under the wallet lock writes the grant and the `AI_CREDIT` wallet entry; the router call
  follows. Router down: 201 with `PENDING`, the billing tick delivers it (`AiAccountService.retryPurchases`). New
  `credit-grant.ts` `applyGrant` is used for plan credit too: `attempts` is now taken by compare-and-set, so two runs never
  post one grant twice. `GET /ai` has `buy` (limits, or null). The `credit-grant:` alert names purchases. Same gate and
  Turnstile check as `pay-with-wallet`.
- **Dashboard:** Billing page, AI balance card: "Top up saldo AI" (only with the wallet on, a router account and a rate)
  opens a dialog with presets Rp 20.000 / 50.000 / 100.000 / 200.000, a custom amount, both balances before and after, the
  US$ credit, "Saldo tidak cukup" (button off), Turnstile when configured, and a no-refund line. Mock mode moves sample
  Rupiah between the two balances.
- **Docs:** `setup.md` (NibieRouter section), `AGENTS.md`, customer API reference `api-reference/integrasi.mdx`.
- **Checks:** backend `tsc`; unit 541 pass (2 known Windows-only `egress-canary` failures); integration on a separate DB
  `hermes_test_aicredit`: `ai-credit-purchase` (6, new), `ai-account` (8), `router-provisioner` (21) pass; the full integration
  run had not finished when the PR was opened. Dashboard typecheck, lint, tests (213). Dialog seen headless in mock mode
  (desktop and 390 px): presets, short balance (button off), purchase moves Rp 50.000 between the two balances.
- **Not done:** no admin view of purchases beyond the wallet ledger and the alert; no refund path (admin adjust by hand).
  Not tried against the real router. `WALLET_ENABLED` is still off in production.

## Customer "AI models" page (2026-11-20, branch `claude/customer-ai-models`, not committed)

Owner: a page listing the NibieRouter models a customer can call with their API keys.
- **Backend:** `GET /ai/models` (customer plugin, `src/http/ai-routes.ts`) via `AiAccountService.models` answers
  `{ baseUrl, freeOnly, models }` from the existing `model-catalog.ts` (one shared catalog instance in `main.ts`, so the
  instance model picker and this page share the 10-minute cache). Same rule as `GET /instances/:id/models`, at tenant level: a
  tenant without a non-deleted instance on a priced plan gets the free models only. 404 without NibieRouter.
- **Keys unchanged (owner decision):** `usr-` keys get no `allowed_models`; they can call every model and a balance of 0 is
  relied on to refuse paid ones. **Not verified on the real router.** Check on a test tenant with balance 0 and a `usr-` key:
  `POST https://router.nibie.app/v1/chat/completions` with a paid model id must be refused (expect 402/403) and a free model id
  must answer 200; then see the balance still 0 in the router admin.
- **Dashboard:** `/ai-models` page (sidebar "AI models"/"Model AI" under Account): base URL with copy, table with model name
  and id (mono, copy button), input/output price per 1M tokens in US$, a "Free"/"Pay per use" text badge, and the free-plan
  note. "Lihat daftar model" link on the API keys page. `BillingApi.aiModels()` (customer: 404 -> null; mock: the existing
  `MOCK_ROUTER_MODELS`; unavailable: null), hook `useAiModels`.
- **Checks:** backend `tsc`; unit 542 pass, 2 known Windows-only `egress-canary` failures; integration `ai-account` (10) pass.
  Dashboard typecheck, lint, tests (210), build. Headless Chromium on the built dashboard in mock mode: page renders in
  Indonesian, 4 rows, sidebar link, link from API keys works, no console errors, no page overflow at 400 px (dark theme).

## Customer NibieRouter API keys (2026-11-20, PR #111, merged `f26b9dc`)

Owner: customers can create their own NibieRouter keys on a new "API keys" page under Akun.
- **Backend:** `AiAccountService.listKeys/createKey/revokeKey` (`modules/nibierouter/ai-account.ts`); customer routes
  `GET /ai/keys`, `POST /ai/keys` (201, the only answer with the `sk-` secret), `POST /ai/keys/:keyId/revoke` (204). Keys are
  router keys named `usr-<name>` under the tenant's router user, `rpm_limit` 20, at most 5 active (`409 key_limit`); no router
  user yet answers `409 ai_account_missing`. Only `usr-` keys are listed or revocable, so instance keys (`inst-`) cannot be
  touched; nothing is stored in our database. New client call `revokeKey` = `DELETE /api/admin/users/:id/keys/:keyId`, taken
  from docs.sumorouter.com/api/admin and **not yet tried on the real router**; `created_at` on a key row is read when present.
- **Dashboard:** `/api-keys` page (base URL with copy, create form, secret shown once in a dialog, table, revoke confirm),
  sidebar link under Account, Indonesian strings; mock mode has one sample key.
- **Checks:** backend `tsc`; unit pass except the 2 known Windows-only `egress-canary` failures; integration `ai-account` (9),
  `router-provisioner`, `customer-api` pass. Dashboard typecheck, lint, tests (210), build. Headless Chromium on the built
  dashboard in mock mode: list, name validation, create with secret shown once and gone after the dialog, revoke, 400 px width.
- **Before relying on it:** create, call `GET https://router.nibie.app/v1/models` with the key, revoke and see it refused, on a
  test tenant.

## Backup alerts for R2 and the restore drill; restore runbook (2026-11-20, branch `claude/backup-alert-runbook`, not merged, not installed)

Owner: "mulai", for the open items of the entry below.
- **Alerts:** `ops/host/hermes-watchdog.sh` step 4b raises a Telegram alert when the last `OK: uploaded` in
  `/var/log/hermes-db-offsite.log` is older than 26 hours or missing, and when `hermes-restore-drill.service` is `failed`. It
  sends a recovery message when that is fixed. Telegram is configured on the VPS (both `OPS_TELEGRAM_*` names set, checked
  without reading values). The installed watchdog matched the repository before this change.
- **Runbook:** new `docs/runbook-restore.md`: what is backed up, the daily check, a safe restore test, restoring the production
  `hermes` schema (never `auth`), and what to repair after a restore. The production restore is **not rehearsed**.
- **Checks:** `bash -n` on the watchdog. The R2 freshness parser was run on fake logs: a fresh upload recovers; an old upload,
  a log without `OK` and a missing log all alert. The quoting of the runbook's RLS query was checked in a shell.
- **To install on the VPS after merge** (the pull deploy updates only the backend):
  `cd /opt/hermes-cloud && git fetch -q origin && git show origin/main:ops/host/hermes-watchdog.sh > /tmp/hermes-watchdog && sudo install -m 755 /tmp/hermes-watchdog /usr/local/sbin/hermes-watchdog`
  (the checkout is a detached HEAD after `deploy.sh`, so `git pull` is not used). Check: `sudo /usr/local/sbin/hermes-watchdog` prints
  no `ALERT offsite` or `ALERT restore-drill`.
- **Still open:** confirming that the restic password and R2 credentials are in the password manager (owner).
  `hermes-db-backup` is installed on the VPS but not kept in this repository.

## Database backup to R2 checked, restore drill passed (2026-11-20, VPS, no code)

Owner ran the checks on the VPS with the steps from this session; all read-only, production untouched.
- **Timers:** `hermes-db-backup.timer` (03:00 CST = 19:00 UTC) and `hermes-db-offsite.timer` (03:30 CST) both active, last
  run 2026-11-19 19:00/19:30 UTC.
- **R2 upload:** `/var/log/hermes-db-offsite.log` has `OK: uploaded` every day from 2026-11-16 to 2026-11-19 and no `ERROR`.
  The `Load(<lock/...>) ... The specified key does not exist` lines at the end of the log come from the `forget --prune` /
  `check` step after the upload and resolved on retry.
- **Restore drill:** `sudo /usr/local/sbin/hermes-restore-drill --from-r2` restored `hermes-20261119T192859Z.dump` from R2
  into a throwaway Postgres with no network: rows (plans|tenants|instances|users) `3|6|10|7`, `restore drill OK`, exit 0.
- **Still open:**
  - The restic password and R2 credentials live only in `/etc/restic/r2/env` on the VPS. The owner must keep a copy in the
    password manager, or the R2 backups cannot be read if the VPS is lost. Not confirmed yet.
  - The runbook and the R2 and drill alerts are in the entry above (`claude/backup-alert-runbook`).

## NibieRouter step 3: AI balance in Rupiah and low-balance reminder (2026-11-20, branch `claude/ai-balance-rupiah`, not committed)

Plan: AI credit in Rupiah through NibieRouter, PR B of 3. Owner: the router's rate by default, an admin can override it;
reminder is a customer switch with a customer-set amount.
- **Backend:** migration `20261120400000_ai_balance` (additive): `BillingSetting` (one row, `aiCreditIdrPerUsd`, RLS on) and
  `Tenant.aiLowAlert` / `aiLowThresholdIdr` / `aiLowNotifiedAt`. New `AiAccountService` (`modules/nibierouter/ai-account.ts`);
  client `getUsage` (`GET /api/admin/users/:id`) and `getIdrPerUsd` (`GET /api/admin/settings/payment`, only `idr_per_usd`
  is read), both shapes read on the real router first. Customer `GET /ai`, `PUT /ai/alert`; admin
  `POST /settings/ai-credit-rate` (aal2, reason, audited) and `settings.ai.creditRate` on `/system`; MCP tool
  `set_ai_credit_rate`. The billing tick sends `ai_low_balance` (Indonesian) at most once an hour per drop, only to tenants
  with a DONE `CreditGrant`.
- **Dashboard:** Billing page "AI balance" card (Rupiah balance, rate and its source, 30-day spend, daily chart, per-model
  table, reminder switch and amount); the NibieRouter model card shows the balance with a link to Billing; Pengaturan shows
  the router rate and the rate in use, with a form to override or clear it.
- **Also fixed:** `test/integration/admin-api-keys.test.ts` expected `/system` without the wallet fields added earlier, so it
  failed on `main`; the expectation now includes them.
- **Checks:** backend `tsc`; unit 541 pass (2 known Windows-only `egress-canary` failures); integration on a separate DB
  `hermes_test_ai`: `ai-account` (8), `billing-tick`, `router-provisioner`, `admin-api`, `admin-api-keys`, `customer-api`,
  `billing-api`, `wallet` all pass. Dashboard typecheck, lint, tests (210). Not seen in a browser.

## NibieRouter step 2: rpm limit on instance keys, own NibieRouter key in BYOK (2026-11-20, PR #109, merged and deployed `6aeb4ea`)

Deployed by the host's pull deploy after the merge (`OK: backend 6aeb4ea is ready`, no migration). The first billing tick
gave the existing instance keys `rpm_limit` 20 (checked on 3 tenants at the router; no sweep warning in the backend log).

Plan: AI credit in Rupiah through NibieRouter, PR A of 3 (owner approved; PR B balance and reminder, PR C buying AI credit
from the wallet, follow).
- **Backend:** every new instance key is created with `rpm_limit` 20 (`KEY_RPM_LIMIT`); older `inst-*` keys without a limit get
  it once per backend start from `runPending`, keeping their other settings; a limit set by hand is left alone. Client:
  `createKey` sends `rpm_limit`, `listKeys` returns id, limit and settings, new `updateKey` (PUT). `safeFetch` allows `PUT`.
  The free models' 50 requests a day stay configured on the router worker (owner).
- **Router checked by hand** with a throwaway user (keys revoked, user disabled): create with `rpm_limit` and PUT update work
  as built. `test/validation/nibierouter-live.ts` now also tries the update and reads the user.
- **Dashboard:** BYOK offers "NibieRouter (own account)" (`https://router.nibie.app/v1`) with a "Create one at
  router.nibie.app" link; the BYOK picker still defaults to OpenAI. The locked NibieRouter card says to bring an own NibieRouter
  key instead of "Contact support". Such a key is a normal BYOK key on the customer's own router account.
- **Checks:** backend `tsc`; unit tests pass except the 2 known Windows-only `egress-canary` failures; integration
  `router-provisioner` (21 tests). Dashboard typecheck, lint, tests (206). Not seen in a browser; whether router.nibie.app
  lets anyone sign up was not checked.

## NibieRouter step 1: the customer chooses the model (2026-11-20, branch `claude/nibierouter-model-choice`, PR #105, deployed `d798b01`)

Deployed by the owner by hand on 2026-11-20 (`deploy.sh`: database dump, build, no pending migrations, backend and caddy
recreated, `OK: backend d798b01 is ready`). The image tag was already `d798b01` before that run. Not yet checked in the
dashboard by a customer.

Owner: "mulai langkah 1" of `docs/superpowers/plans/2026-11-20-nibierouter-integration.md`.
- **Backend:** new `src/modules/nibierouter/model-catalog.ts` reads the router's public `/v1/models` (no key, router host
  only, 10-minute cache, last copy served while the router is down, embedding models dropped, malformed entries
  skipped). `ProviderService.models` and `setModel`; customer routes `GET /instances/:id/models` (`{ freeOnly, models }`)
  and `PUT /instances/:id/providers/model` (`{ model }`). A free plan (`monthlyPriceIdr` null) gets the free models only;
  an unknown model or a paid one on a free plan is 400; a BYOK or unconfigured instance is `409 not_nibierouter`. Saving
  bumps `configRevision` and keeps the key; the same model again changes nothing. Default model unchanged
  (`NIBIEROUTER_DEFAULT_MODEL`).
- **Dashboard:** Configuration, AI provider tab: a "NibieRouter model" card under the provider form when NibieRouter is
  attached: search, a list with prices per 1M tokens and a "Free" label, a note on free plans, a note that a paid model
  uses the AI balance, "Save model", then the existing restart notice. Mock mode has four sample models.
- **Docs:** `setup.md` (NibieRouter section, route list), customer API reference `api-reference/integrasi.mdx`,
  `apps/web/README.md`, `AGENTS.md`.
- **Checks:** backend `tsc`; unit tests pass except the 2 known Windows-only `egress-canary` failures (new
  `model-catalog.test.ts`, 5 tests); integration (own DB `hermes_test_sumopod`) `provider-service` and
  `integration-routes`, 48 tests. Dashboard typecheck, lint, tests (206). The card was not seen in a browser.
- **Not done (later steps):** key rate limits (step 2), AI balance and usage page (step 3), buying AI credit (step 4).
  The balance is not shown next to the picker until step 3.

## Backend deploys pulled by the host (2026-11-20, branch `claude/pull-deploy`, not merged, not installed)

The GitHub deploy for #103 failed twice: `ssh: connect to host *** port 22: Connection timed out`. The host's `ufw` allows 22 and
`sshd` listens; the owner said the VPS provider now limits inbound SSH ("kena security port vps"). #103 was deployed by hand from
the owner's workstation (owner: "deploy #103"; `f34269e`, ready, no errors). Owner: "buat pull deploy", Tailscale later.
- **Built:** `ops/host/hermes-pull-deploy.service` + `.timer` (every 2 minutes, as `ubuntu`) run `hermes-auto-deploy`, which now
  also skips a commit whose `ci` run is not `success` (public GitHub API via `curl` + `jq`, both on the host) and marks a failed
  deploy (`/var/lib/hermes-deploy/failed-<commit>`) so it is not retried every 2 minutes. `.github/workflows/deploy.yml` is
  `workflow_dispatch` only until SSH reaches the host another way. Install steps: `deploy/README.md`.
- **Checks:** `bash -n` on the script; the CI query ran on the host against the current `main` and answered `success`. Not
  installed or run on the host yet.
- **Until it is installed:** each backend merge needs a manual deploy from an allowed IP.

## Balance payments: confirmation with Turnstile, open the new instance (2026-11-20, branch `claude/wallet-confirm`, PR #103, deployed `f34269e` by hand)

Owner: "should have confirmation payment with turnstile widget" and "its not redirected to overview instance".
- **Backend:** `POST /payments/:id/pay-with-wallet` takes `{ captchaToken }` and, when `TURNSTILE_SECRET_KEY` is set (it is on
  production), checks it before anything is read or written: `400 captcha_failed`, `503 captcha_unavailable` (fails closed).
  The route now creates a new purchase's instance before answering (`ensureInstance`; the post actions and the billing tick still
  repair a failure), so `subscription.instanceId` is in the response. `CaptchaFailedError` moved to `modules/waitlist/turnstile.ts`.
- **Dashboard:** a balance payment opens a dialog (amount, balance now, balance after, Turnstile widget, "Konfirmasi
  pembayaran"); the order is created only after the confirmation, and a retry reuses it (same Idempotency-Key, or the open
  renewal/upgrade invoice). After paying a purchase the dashboard opens `/instances/<id>`.
- **Checks:** backend `tsc`; integration (own DB `hermes_test_wallet`): every billing and waitlist test file plus `admin-api`, 13
  files, 230 tests, including a new route test (no token / wrong token 400, outage 503, nothing charged, then paid with
  `instanceId`); unit tests pass except the 2 known Windows-only `egress-canary` failures. Dashboard typecheck, lint, tests (203),
  `next build`. The production dashboard bundle carries a Turnstile site key. The dialog was not seen in a browser (preview
  plans have no price).

## One pay button: balance when it covers the price, else QRIS (2026-11-20, branch `claude/one-pay-button`, PR #100, merged `4af2244`)

Owner chose option A ("1"): no choice between balance and QRIS. Dashboard only (backend unchanged): Deploy, the unpaid-order
notice, the Billing table, renew and upgrade on the instance Billing tab each have one button that pays from the balance when it
covers the amount ("… from balance") and otherwise opens QRIS. Shared in `components/app/pay-button.tsx` (`usePay`, `PayButton`),
which replaces `wallet-pay-button.tsx` and the "Bayar dengan" radio. Checks: dashboard typecheck, lint, tests (203), `next build`.
Priced flows not seen in a browser (preview plans have no price).

## SumoPod gaps closed (2026-11-20, branch `claude/sumopod-gaps`, PR #99, deployed `3abc2fd`)

Deployed by the auto-deploy after the merge: the host log says "backend 3abc2fd is ready", the backend is healthy, and the
public webhook without a token answers 400.

**Resend verified on 2026-11-20.** The owner resent the `payment.completed` delivery of top-up `nw-678df…` (Rp 15.000,
paid at 00:02 UTC) from the SumoPod Webhooks tab, 14 minutes after payment. The backend log shows the resends at 00:16 UTC
answered with outcome `duplicate`, and SumoPod shows the last response as `200`. The wallet holds one Rp 15.000 entry, so
nothing was credited twice. SumoPod therefore signs every resend with a fresh timestamp, and our 5-minute Svix window does
not block resending old payments.

Owner asked to analyse SumoPod against the code and close the gaps. Facts were read from docs.sumopod.com, the
SumoPod dashboard Quick Start (Live, read-only) and the production admin MCP.
- **SumoPod facts:**
  - The documented events are `payment.completed`, `payment.failed`, `payment.expired` and `payment.test`; a paid
    payload has `status: "completed"`.
  - The invoice response always has `payment_link_url` (`https://pay.sumopod.com/pay/<payment_id>`).
  - `expires_in_hours` is optional, defaults to 24 and has a maximum of 24.
  - A failed delivery is not retried; it waits for a manual Resend in the Webhooks tab.
  - "Charge fee to customer" is OFF on the Nibie Cloud account: a Rp 10.000 top-up shows a Rp 370 fee on our side.
  - NibieRouter takes its payments (`SR-` orders) through a separate SumoPod account.
- **Production (admin MCP):** `SUMOPOD_ENV=production` with a signing secret. Real hosting invoices reached `PAID` on
  2026-11-17 and 2026-11-18, so the "not verified" note further down (2026-11-16 entry) is outdated.
- **Code:**
  - The webhook decides from a known `event_type`. A body without one still uses the status word. Anything unknown
    is answered 200, changes nothing and is logged as a warning (`ignored_event`); before, an unknown status word
    marked the invoice FAILED.
  - `amount_mismatch` is now logged as an error and `unknown_order` as a warning.
  - The `sumopod webhook processed` line now carries `merchantOrderId`.
  - The client requires `payment_link_url`; the invented `app.sumopod.com/pay/<payment_code>` fallback is gone.
  - `payment.expired` now sets EXPIRED, not FAILED. SumoPod now expires the QR together with our row, so its webhook
    often arrives before the one-minute billing tick.
  - The client now sends `expires_in_hours` (1 for our 60-minute invoices and top-ups). Before, a QR stayed payable
    for 24 hours after our row expired: on 2026-11-20, three `nc-` invoices that had expired on our side were still
    Pending at SumoPod.
- **Docs:**
  - New [runbook-payments.md](runbook-payments.md).
  - [billing-go-live.md](billing-go-live.md): the webhook answers 400, not 401/403. The stale "uncommitted checkout
    fix" line is removed. Fee setting and account note added.
  - `SUMOPOD_CALLBACK_URL` is described as what it is: never sent to SumoPod.
- **Checks (Windows, local `hermes_test`):**
  - Backend `tsc` clean.
  - Unit: 532 pass. The only failures are the 2 known Windows-only `egress-canary` tests. New:
    `test/unit/sumopod-client.test.ts` (4 tests) and 2 tests in `sumopod-webhook.test.ts`.
  - Integration: `sumopod-webhook` (17: 3 new, and the amount-mismatch test now also checks the error log), `billing-api`, `billing-service`, `wallet` (1 new), `billing-tick`,
    `billing-upgrade` and `invoices` pass, 125 tests.
  - Two early runs had 1 to 3 unrelated `billing-api` failures, a different test each time (for example "rejects a
    body over 16 KB"). Later runs passed 3 times alone and once in the full set. This looks like a flaky shared
    database. The wallet-pay entry below confirms that another session was running tests on `hermes_test` at the
    same time.
- **Open:**
  - No admin action marks a hosting invoice paid when its webhook cannot be resent. Resend works, so this is needed
    only when SumoPod has no delivery to resend.
  - `amount_mismatch` reaches only the log, not the operator alerts.
  - On 2026-11-20 the admin MCP showed `nc-f44c…` still `PENDING` after its `expiresAt` (check the billing tick).
  - `nc-0ff9…` (`PAID` 2026-11-17) does not appear in the Nibie Cloud SumoPod account's payments or webhook log
    (unexplained).
  - NibieRouter integration (low-balance alert, per-key limits, usage page, model choice, AI credit from the wallet)
    is a separate plan.

## Wallet part 2: pay hosting from the balance, auto-renew (2026-11-20, branch `claude/wallet-pay`, PR #98, deployed `5bbbc76`, `WALLET_AUTO_RENEW` off)

Owner: "lanjut part 2" and, about the unpaid-order notice on Deploy, "beli arahkan ke dompet".
- **Built:** migration `20261120300000_wallet_pay` (`Payment.method` QRIS|WALLET, `Subscription.autoRenew` default true);
  `POST /payments/:id/pay-with-wallet` (purchase, upgrade, renewal; same subscription lock as the webhook; shared `activate`
  step with the webhook, so invoices and periods are identical); a QRIS payment of an invoice already paid from the wallet goes to
  the wallet (`credited_to_wallet`); auto-renew in the billing tick behind `WALLET_AUTO_RENEW` (default off), once per period;
  `POST /subscriptions/:id/auto-renew`; `GET /wallet` says whether auto-renew is on; invoices show the payment method.
  Dashboard: "Bayar dengan" saldo/QRIS on Deploy (saldo is the default when it covers the price), "Bayar pakai saldo" on the
  unpaid-order notice, the Billing table and a pending upgrade, "Renew from balance" and "Upgrade from balance" on the instance
  Billing tab, and the auto-renew switch there (only when `WALLET_AUTO_RENEW` is on and the plan has a price).
- **Not built:** renewal reminder emails do not mention the balance or auto-renew yet; AI credit (part 3).
- **Checks (Windows, own local DB `hermes_test_wallet`, because another session was running tests on `hermes_test`):** backend
  `tsc`; integration `wallet-pay` (new, 9) plus every billing test file, `admin-api` and `schema`: 13 files, 227 tests pass; unit
  tests pass except the 2 known Windows-only `egress-canary` failures. Dashboard typecheck, lint, tests (203), `next build`. The
  priced flows were not checked in the browser: preview (mock) plans have no price.

## Invoices for every payment (2026-11-20, branch `claude/invoices`, PR #97, deployed `9291fdf`)

Owner: "yaa buatkan invoice nibie". Owner decisions: seller "Nibie Cloud / nibie.app" (no address, no NPWP), numbers sequential per
month, no PPN line.
- **Built:** migration `20261120200000_add_invoices` (`Invoice`, `InvoiceCounter`, CHECK one source, RLS) that also backfills an
  invoice for every payment and top-up already `PAID`, numbered by `paidAt`; the webhook issues one in the transaction that marks a
  hosting payment or top-up paid; customer `GET /invoices`, `GET /invoices/:id` (with the owner's email as "billed to"); Caddy
  forwards `/api/v1/invoices*`. Dashboard: "Invoice" card on Billing and `/billing/invoices/[id]` with "Cetak atau simpan PDF"
  (sidebar and top bar hidden in print, light palette while printing).
- **Not built:** the invoice number or link in the receipt emails; invoices in the admin panel; a PDF file sent by email.
- **Checks (Windows, local Postgres `hermes_test`):** backend `tsc`; integration `invoices` (new, 5), `wallet`, `sumopod-webhook`,
  `billing-service`, `billing-api`, `billing-tick`, `alert-scanner`, `admin-api`, `schema` pass; the backfill SQL re-run on the test
  data gave the same numbers as the webhook; unit tests pass except the 2 known Windows-only `egress-canary` failures. Dashboard
  typecheck, lint, tests (203), `next build`; mock-mode screenshots at desktop, 400px and a printed A4 PDF.

## Wallet top-up saldo, part 1 of 3 (2026-11-20, branch `claude/wallet-topup`, PR #96, deployed `829eb4f`)

**Live since 2026-11-20:** `WALLET_ENABLED=true` on production (owner: "nyalakan wallet"); a real Rp 10.000 QRIS top-up was
credited once through the webhook (`topped_up`) with no backend warnings. The landing terms line is still missing (owner chose to
keep the wallet on).

Owner: "add billing topup saldo for users". Owner decisions: an IDR wallet per tenant (not only AI credit), custom amount
Rp 10.000 to 2.000.000, wallet cap Rp 5.000.000, admin adjust with reason and audit, non-refundable, auto-renew as a toggle
default on (part 2), AI credit rate in the database (part 3). Reference model: SumoPod's own Top Up Billing and Top Up AI
Balance. Plan: [superpowers/plans/2026-11-20-wallet-topup.md](superpowers/plans/2026-11-20-wallet-topup.md).
- **Built (part 1):** migration `20261120100000_add_wallet` (`Wallet`, `WalletEntry`, `WalletTopup`, CHECK, RLS); `WALLET_ENABLED`
  (default `false`); customer `GET /wallet`, `POST /wallet/topups`, `GET /wallet/topups/:id`; the SumoPod webhook credits
  `nw-` top-ups (`topped_up`); receipt email `topup_received`; the billing tick expires top-ups; admin customer detail shows the
  wallet, `POST /admin/customers/:tenantId/wallet/adjust` + MCP `adjust_wallet`; alert `wallet-mismatch:`; Caddy forwards
  `/api/v1/wallet*`. Dashboard: wallet card on Billing (balance, presets + custom amount, history, pending top-ups, polling),
  admin customer page wallet section with adjust dialog. Details: `docs/setup.md`, "Wallet (top-up saldo)".
- **Not built:** paying hosting from the wallet and auto-renew (part 2), buying AI credit with the live NibieRouter balance
  (part 3), a header balance chip, the landing terms line (owner wording).
- **Before `WALLET_ENABLED=true` on production:** apply the migration, verify one real SumoPod payment end to end (the Rp
  25.000 test), add the non-refundable line to the landing terms. Owner to check Bank Indonesia closed-loop e-money rules,
  SumoPod merchant terms for top-ups, and PPN timing.
- **Checks (Windows, local Postgres `hermes_test`):** backend `tsc`; integration `wallet` (new, 15), `alert-scanner`,
  `sumopod-webhook`, `billing-service`, `billing-tick`, `billing-api`, `admin-plan-stock`, `admin-api` pass; unit tests pass
  except the 2 known Windows-only `egress-canary` failures. Dashboard typecheck, lint, tests (203).

## Volume quota raised automatically after an upgrade (2026-11-20, branch `claude/auto-volume-quota`, PR #94, deployed `3952452`)

Owner: "kenapa manual? make it auto update".
- **Backend:** operator route `GET /api/v1/volume-quotas` (bearer `ADMIN_TOKEN`, refused when proxy headers are present, not in the
  Caddy allowlist) lists `{ instanceId, storageMb }` for every instance not `DELETING`/`DELETED`. `applyPlanChange` now logs at info.
- **Host:** `ops/host/hermes-volume-quota.sh` + `.service` + `.timer` (every minute, root). Reads that route over loopback, finds the
  XFS project of `hermes-data-<id>` (`xfs_io lsproj`), and raises `bsoft`/`bhard` to the plan size when the current hard limit is
  smaller; never lowers one. Install steps: `deploy/README.md`. Dry run on the VPS with sample input listed only the 1 GiB volume.
- **Installed on the VPS (owner: "install"):** script at `/usr/local/sbin/hermes-volume-quota`, units in `/etc/systemd/system/`,
  `hermes-volume-quota.timer` enabled. `DRY_RUN=1` against live data: nothing to raise. First run: `Result=success`, empty log.
  **Not verified:** a real raise after a paid upgrade (needs a real payment); check `/var/log/hermes-volume-quota.log` then.
- **Checks:** backend `tsc`; integration `operator-volume-quotas` (new) and `billing-upgrade` pass; `bash -n` on the script.

## Free instance upgrade to a paid plan; Kredit plan 10 GB (2026-11-20, branch `claude/free-upgrade`, PR #93)

Owner: "users bisa upgrade paket dari free plan dengan new payment" and "adjust plan kredit ke storage 10gb".
- **Production database (applied by hand, owner's instruction):** `hosting-kredit` `storageMb` 5120 -> 10240
  (`deploy/sql/2026-11-20-kredit-storage-10gb.sql`). No Kredit instance existed, so no volume was affected.
- **Backend:** `POST /api/v1/subscriptions/upgrade` `{ instanceId, planId }` + `Idempotency-Key` (customer API, same gate and
  rate limit as checkout). Only an instance on a plan without a price; one subscription per instance (`already_subscribed`,
  `not_free`). It creates a `PENDING_PAYMENT` subscription that already points at the instance, and a NEW invoice whose return
  URL is that instance's billing page. Only the plan's stock is checked (no new instance). A second request ends the first
  (`ENDED`, unlinked), so a late payment of the old invoice is `paid_after_end`, never applied. Deleting the instance ends an
  unpaid upgrade too. On the verified payment, `applyPlanChange` runs `router.begin` (the free key is kept; the row is linked
  to the subscription so the plan's one-time credit is granted), sets `planId`, bumps `configRevision`, records `plan.changed`
  and restarts a running instance (new CPU/memory/pids). The billing tick repairs a missed plan change.
- **Volume quota:** Docker keeps the free plan's quota on the volume; since PR #94 the host timer `hermes-volume-quota` raises it
  to the new plan size within about a minute (section above).
- **Capacity:** tenant volumes share a 100 GB XFS image (`/srv/hermes-volumes.img`). Stock 10 x 5 GB (Hosting) + 10 x 10 GB
  (Kredit) = 150 GB of caps; RAM (15 GB host, 1 GB per instance) limits the host to about 12 instances anyway.
- **Dashboard:** the billing page of a free instance lists the priced plans with an "Upgrade to ..." button (SumoPod QRIS),
  shows an open upgrade invoice with "Continue payment" and polls until it is paid. `subscriptionOfInstance` ignores an
  unpaid upgrade; `retryHref` sends any order with an instance to its billing page. A priced instance without a
  subscription (created by an admin) now says "No subscription" instead of "Free beta instance".
- **Landing:** storage per plan (Hosting 5 GB, Kredit 10 GB); intros say "penyimpanan mulai 5 GB".
- **Production switch:** `PAID_CHECKOUT_OPEN=false` also closes upgrades for everyone not invited.
- **Checks:** backend `tsc`; unit 526 pass (2 known Windows `egress-canary` failures); integration billing-upgrade (new, 9),
  billing-service, billing-tick, billing-api, sumopod-webhook, router-provisioner (+1 test) pass; web typecheck, lint, 195
  tests, build; landing typecheck, lint, 67 tests, build. Not run: full integration suite, e2e. An abandoned upgrade (7 days
  unpaid) is ended and unlinked by the billing tick.

## Dashboard shell like NibieRouter, Quickstart and Billing pages (2026-11-19, branch `claude/router-style-shell`, not committed)

Owner asked for the dashboard header to look like router.nibie.app, plus Quickstart and Billing pages, and chose the options below.
- **Shell (`app-shell.tsx`):** sidebar groups "Overview" (Quickstart, Instances, Deploy) and "Account" (Billing, Account settings,
  Support), then Admin when allowed. A sticky top bar holds a breadcrumb (group > page), the language and theme switches and an
  account menu (name/email, Account settings, Support, Sign out). No balance chip: Nibie Cloud has no credit balance. On phones the
  switches move into the navigation sheet. Logo: no ink tile in the dark theme, wordmark in sentence case (`DESIGN.md` updated).
- **`/quickstart`:** three steps checked from real data for the first running instance (`lib/quickstart.ts`, tested): deploy, AI
  provider configured, Telegram configured and verified. The first open step gets the primary button.
- **`/billing`:** every subscription on the account (plan, status, period, latest payment), with Pay for an open invoice,
  Manage (the instance's Billing tab, where renew and cancel stay) or Order again for an expired order.
- **Review fixes:** the latest-payment line is one helper (`paymentText` in `lib/billing.ts`, used by Account and Billing, tested), so
  an unpaid invoice past its expiry reads "expired" and dates follow the language; no Manage link for an ended order; Quickstart waits
  for the provider and Telegram status instead of showing those steps as open; e2e `login.spec.ts` signs out through the account menu.
- **Checks:** web typecheck, lint, 23 test files (197 tests) pass; e2e typecheck; `DESIGN.md` lint clean. Build and headless
  screenshots (mock mode, 1440px dark and light, 400px) were done before the review fixes. Not run: e2e suites, customer mode
  against a real backend.

## No preview data in customer mode (2026-11-19, branch `claude/no-preview-data`, merged as PR #90)

Owner: "pastikan no preview data lagi. we're going live prod". Before this, the customer dashboard still took an instance's plan
from sample metadata when the instance had no subscription (every free instance), so the header, the free-plan NibieRouter notice
and the Runtime tab could name the wrong plan; the Runtime tab also showed a fake image (`hermes-agent:2026.11`), a fake isolation
(`runc`), a "Preview data" tag and a "Backups coming soon" row.
- **Backend:** `InstanceView` (`toView`) now includes `planId`, on the customer and operator APIs. Additive; no migration.
- **Dashboard:** instance header, instance cards, the provider form's free-plan check and the Runtime tab use the billed plan, then
  `instance.planId`. The Runtime tab shows only the plan limits (CPU, memory, storage, processes). `createCustomerApi` no longer
  takes or spreads the mock: `meta` answers null, `regions` `[]`, and access, usage, files, file content and backups reject with
  `501 not_available` (test "never serves sample data for endpoints without a backend"). Monitor, files, console, backups, domain and
  access stay hidden in customer mode.
- **Deploy order:** backend first. A dashboard built from this branch against an older backend cannot name the plan of a free
  instance (no subscription), and its Runtime tab keeps loading.
- **Checks:** backend `tsc`; unit tests 526 pass (2 known Windows `egress-canary` failures); web typecheck, lint, 193 tests, build.
  Not run: integration suite, e2e. The owner confirmed the Worker `nibie-cloud-web` build var `NEXT_PUBLIC_HERMES_API_MODE=customer` (2026-11-19).
- **Next (owner's choice, after launch):** real Monitor (CPU, RAM, disk, traffic samples from Docker, customer endpoint).

## Instance self-management design spec (2026-11-19, branch `claude/self-manage-spec`)

Design only, nothing built: [2026-11-19-instance-self-management-design.md](superpowers/specs/2026-11-19-instance-self-management-design.md).
It covers a web shell (full shell as uid 10000; owner accepted that customers can see their own instance keys), a file manager, a
`SOUL.md`/`config.yaml` editor with history, and dashboard self-recovery for `recovery_exhausted`. Target is the current Node backend
(owner: "ignore go. focus on current codebase"). The three parts ship behind `SELF_MANAGE_CONFIG|FILES|SHELL`, off by default. The
console and file manager pages stay mock until then.

## Duitku removed; SumoPod is the only payment gateway (2026-11-19, branch `claude/remove-duitku`, not committed)

Owner: "remove Duitku payment gateway, we use SumoPod". Production was checked first through the admin MCP: gateway `sumopod`,
`duitku: null`, no open Duitku invoice. Wherever older entries below mention Duitku or `BILLING_GATEWAY`, this entry wins.
- **Backend:** deleted `duitku-client.ts`, the `POST /api/v1/billing/duitku/callback` route, `BILLING_GATEWAY`, `DUITKU_*` and the
  `both` mode. Old env files still start: those variables are now ignored. `DASHBOARD_ORIGIN` is now required whenever SumoPod
  is configured (the Duitku-only check moved over; production has it). The lowest sellable price is SumoPod's `1000` (was
  Duitku's `10000`). Admin `/system` still returns `billingGateway`/`settings.billing.gateway` (`sumopod` or null) and no
  longer `settings.billing.duitku`. No migration: `Payment`/`PaymentEvent` rows from Duitku stay valid.
- **Caddy:** the Duitku callback path is no longer forwarded. **Dashboard:** deploy page says "Bayar lewat QRIS" (SumoPod page),
  Pengaturan drops the Duitku row. **Landing:** the privacy policy lists SumoPod (QRIS) as the payment processor;
  `SITE.legalUpdated` was not changed (owner's call).
- **Tests:** payment tests now drive the SumoPod webhook (`test/helpers/billing-env.ts` `FakeSumoPod`, `webhookBody`); the
  Duitku client unit test and the Duitku sandbox live script were deleted. Checks: backend `tsc`; unit tests 526 pass (2 known
  Windows `egress-canary` failures); billing-service, billing-tick, billing-api, sumopod-webhook and admin-api-keys integration
  98 pass; web typecheck, lint, 193 tests; landing typecheck, lint, 67 tests. Not run: full integration suite, builds, e2e.
- **Open:** the Go port (`server/` on PR #71 and branch `claude/go-port-m1`) still mirrors `DUITKU_*`/`BILLING_GATEWAY` in its
  config parity goldens; regenerate them when that work resumes. The VPS env file may still hold `BILLING_GATEWAY` and empty
  `DUITKU_*` lines: harmless, can be deleted.

## Beta invite email is plain text with Reply-To (2026-11-19, branch `claude/invite-deliverability`, not committed)

The admin beta invite still landed in Gmail spam after the display-name change. NibieRouter sends through the same SumoPod SMTP and
`noreply@nibie.app` and reaches the inbox, so the cause is the mail itself: an unsolicited, generic, branded "Anda diundang" mail.
Changed: `renderBetaInvite` is plain text with no HTML layout (owner: "do not use template"), subject
`Akses beta Nibie Cloud untuk <email>`, says why it came. `Reply-To` is the support contact email from the admin panel when set
(never an admin's own address); without it the copy does not ask for a reply. `MailMessage` gained optional `replyTo`; `html` is
optional. Other emails unchanged. Checked: `pnpm build`, unit tests (547 pass, 2 known Windows `egress-canary` failures),
`test/integration/admin-beta-invites.test.ts` pass. Not verified: whether Gmail now delivers it to the inbox.

## Display name shown in the sidebar (2026-11-19, branch `claude/account-name-fixes`)

Fixes anti-slop audit 006 (N1-N4) on the Account "Nama" card from PR #81. The name (Supabase `user_metadata.full_name`) was
saved but shown nowhere; the navigation rail now shows it above the email when set, email only when empty (one shared
`useDisplayName` hook in `hooks/use-hermes.ts`, so a save updates the rail at once). The card gets loading and error states
(`QueryFallback`), its duplicate visible "Nama" label is now screen-reader only, and "Simpan" appears only once the name has
changed. Checks: web typecheck, lint, 193 tests. Not run in a browser with a signed-in user.

## WhatsApp group link next to the support contacts (2026-11-19, branch `claude/support-group-link`)

Finishes work an earlier session left uncommitted in the main checkout, ported onto `main` after #80 and #82.
`SupportContact.groupUrl` (migration `20261119500000_add_support_group_url`; the abandoned copy used `20261119400000`, which
clashed with the tickets migration). Only `https://chat.whatsapp.com/<code>` is accepted (backend) and rendered (dashboard
`safeGroupUrl`), since it is a link shown to every customer; an empty value clears it, and a body without `groupUrl` keeps the
stored link. Admin Pengaturan has a "Grup WhatsApp" field in the minimal form; Bantuan shows "Komunitas: Gabung grup WhatsApp".
Checks: backend `tsc`, support-contact/support-tickets/admin-api integration 21 pass; web typecheck, lint, 193 tests, build.
The uncommitted copy in the main checkout is superseded and can be discarded.

## Support tickets (2026-11-19, branch `claude/support-tickets`)

Owner's choices: two-way thread, email both ways, fields subject + category + optional instance + message.
- **Backend:** tables `SupportTicket` and `SupportTicketMessage` (RLS on; migration `20261119400000_add_support_tickets`).
  Status OPEN (team's turn), ANSWERED (customer's turn), CLOSED (a new customer message reopens it). Customer routes
  `GET/POST /api/v1/support/tickets`, `GET /support/tickets/:id`, `POST .../messages`, `POST .../close` (tenant-scoped: another
  tenant's ticket answers 404; opening limited to 5 per 10 minutes, replies to 20). Admin routes `GET /api/v1/admin/tickets[?status]`,
  `GET /tickets/:id`, `POST /tickets/:id/messages`, `POST /tickets/:id/close` (each write audited without the message text);
  `openTickets` in `/admin/overview`. Emails (SumoPod SMTP, best effort): new ticket and customer reply to the Kontak bantuan email
  (else the first `ADMIN_EMAILS`), team reply to the customer with a dashboard link. Caddy forwards `/api/v1/support/tickets[/*]`.
- **Dashboard:** "Tiket kamu" on Bantuan, `/support/tickets/new`, `/support/tickets/[id]` (thread, reply, close); admin tab "Tiket"
  (`/admin/tiket`, open tickets first) with detail, reply and "Tandai selesai"; Ringkasan shows "Tiket perlu dibalas". Mock mode
  keeps tickets in memory (starts empty). The contact footer ("Butuh bantuan? WhatsApp ...") was removed on the owner's word.
- **Checks:** backend `tsc`; integration `support-tickets` (4) with support-contact, admin, customer and billing API files: 70 pass;
  unit 544 pass, 2 known Windows-only `egress-canary` failures. Web typecheck, lint, 192 tests, build; mock e2e 30 pass, 1 skipped;
  mock click-through (open, validation, reply, close, list, 390px, no console errors). Not run: real emails, the admin screens in a
  browser (need the real backend and MFA).
- **Go port:** PR #71 needs goose copies of this migration and of `20261119300000_add_support_contact`.

## Admin panel polish (2026-11-19, branch `claude/admin-polish`)

Fixes A1 to A9 of the anti-slop audit 005 (kept outside git in `anti-slop/`): Ringkasan numbers at heading size and five
stats in one row, cards no longer stretched, "Mati" switches drawn dashed and muted; customer search runs on submit (each admin
read writes an audit row); table links underlined; admin tabs in one scrolling row; the admin panel stays Bahasa whatever the
language switch says (`FixedLang` in `lib/i18n.ts`); one set of Indonesian status words for customers and admins (test-enforced);
the sidebar shows only the email. The Kontak bantuan form is minimal (WhatsApp, email, Simpan): the backend's `reason` for
`POST /api/v1/admin/support-contact` is optional now (owner decision); the audit row still records who and the before/after
values. Checks: backend `tsc`, support-contact integration test, web typecheck, lint, 192 tests, build. Not seen in a browser
(the admin panel needs the real backend and MFA).

## Support contacts set from the admin panel (2026-11-19, branch `claude/support-contacts`)

On the owner's word ("fill form on admin settings"; WhatsApp and email on the dashboard, email only on the landing page),
despite the Node feature freeze during the Go port:
- **Backend:** table `SupportContact` (one row, `id` = 1, RLS on; migration `20261119300000_add_support_contact`).
  `POST /api/v1/admin/support-contact` `{whatsapp, email, reason}` (admin, `aal2`, rate limit, audit row with before and after in the
  same transaction; an unchanged save writes nothing). The number is stored as digits with the country code (`+62 812-...` is
  accepted, a leading 0 is refused); an empty value clears a field. `GET /api/v1/public/support-contact` (no auth, `max-age=60`).
  Integration test `test/integration/support-contact.test.ts`.
- **Go port:** PR #71 needs a goose copy of this migration in `server/migrations` (plus `PrismaMigrations` bump, `schema.txt`,
  `sqlc generate`) when it is rebased; `server/` is not on `main` yet.
- **Dashboard:** admin Pengaturan has a "Kontak bantuan" form; the customer Support page and the footer (sign-in screens too)
  read the public endpoint and show WhatsApp (wa.me link) and email, or nothing until set. Telegram and the build variable
  `NEXT_PUBLIC_CONTACT_EMAIL` (added in PR #75) are gone from the dashboard; mock mode shows no contacts.
- **Landing:** email only (build variable `NEXT_PUBLIC_CONTACT_EMAIL` of the landing Worker, live value at the time:
  a Gmail address); Telegram removed from the footer, Kontak and the three legal pages (`legalUpdated` 19 November 2026). With no
  email configured, the links point to `/kontak`.

## Cloudflare Security Insights for nibie.app (2026-11-19, dashboard changes, no code)

Owner exported the Security Insights list (scan of 2026-11-13). Changed in the Cloudflare dashboard on the owner's word:
- Minimum TLS version for the zone raised from 1.0 to 1.2. Checked: `stars.nibie.app` refuses TLS 1.1 and answers on TLS 1.2.
- HSTS was already on (max-age 6 months, includeSubDomains, no preload, set 3 days before). `stars.nibie.app` now sends the header,
  so that finding was stale.
- AI Labyrinth turned on.
- security.txt turned on (Cloudflare Security Settings, no file in the repo): `Contact: mailto:security@nibie.app`, expires
  2027-11-19, languages `id, en`. Served at `https://nibie.app/.well-known/security.txt`. The address reaches the project inbox through
  the Email Routing catch-all. **Renew before 2027-11-19.**

Left as is, on purpose:
- DMARC stays `p=none` (owner's choice) until reports are clean for every sender (Kirim.Email, SumoPod SMTP, Supabase).
- Bot Fight Mode stays off: on the free plan it cannot be skipped per path, so it would challenge the payment webhooks
  (SumoPod, Duitku) and API clients of `stars.nibie.app`.
- Precursor not turned on (not evaluated).
- MFA on the Cloudflare account: owner turned on email and authenticator-app (TOTP) two-factor (both seen active on 2026-11-19).
  No hardware security key.
Seen on the way: Email Routing reports "Email DNS records misconfigured" while still forwarding mail; not investigated.

Supabase captcha is **on** (2026-11-19, rollout step 2 of the free sign-up section below):
- `NEXT_PUBLIC_TURNSTILE_SITE_KEY` was added to the build variables of Worker `nibie-cloud-web` (widget "Nibie Cloud auth"),
  rebuilt as `2ad14c72`. The register page shows the Turnstile widget and gets a token (checked in Chrome).
- The owner rotated the widget secret and switched on "Enable Captcha protection" (Turnstile) in Supabase Attack Protection.
- Checked: `POST /auth/v1/otp` without a token answers `400 captcha_failed`. Code audit: every captcha-protected Supabase call
  (`signUp`, `signInWithPassword`, `resend`) passes `captchaToken` and the widget is replaced after each call; `/verify`, the OAuth
  callback and `updateUser` are not captcha-checked by Supabase. Google sign-in does not go through Turnstile.
- Not yet checked: a real email sign-in. The widget showed 10 solves and 0 siteverify requests, all page-load solves before any
  email sign-in; after one sign-in "Siteverify requests" should be at least 1.
- The owner once saw "The security check could not load" (the widget's error callback). Not reproduced: the live CSP allows
  `challenges.cloudflare.com` for script, frame and connect, and the widget worked in the owner's Chrome earlier. Suspects: a
  hostname other than `cloud.nibie.app`/`localhost` (error 110200) or a browser extension. The error code is not shown yet.
- If the waiting-list backend (`TURNSTILE_SECRET_KEY` on the VPS) uses the same widget, its secret is stale after the rotation;
  the list is closed (`FREE_BETA_SLOTS=0`), so nothing uses it now. Not checked which widget it uses.
- Cloudflare Turnstile warns that the NibieRouter widget (router.nibie.app, SumoRouter, not in this repo) never calls siteverify,
  although SumoRouter has `turnstile_enabled` and a secret set. Not investigated.
- The CSP blocks Cloudflare's auto-injected Web Analytics beacon (`static.cloudflareinsights.com`); harmless.

## Register page tweaks (2026-11-19, branch `claude/register-form-tweaks`, PR #76, not merged)

- The Name field is gone from "Create account"; sign-up sends no `name` metadata (nothing read it).
- The terms checkbox moved to the bottom of the form, above the submit button; the hint under the Google button now says
  "Tick the box below".
- Card subtitles: register "Your personal AI agent, hosted for you.", sign-in "Welcome back.". The line under the card and the
  site description are now "Your own AI agent in the cloud. No server to set up or maintain." (the "24/7" claim is gone).
- The footer keeps main's Telegram link and adds "or email <address>" from `NEXT_PUBLIC_CONTACT_EMAIL` (the variable the
  Support page already uses); empty shows Telegram only. Production needs that variable on Worker `nibie-cloud-web`.
- Checked: web `typecheck`, `lint`, `test` (173 pass), and a headless screenshot of `/dashboard/register` at 420 px.
## Dashboard: unpaid and expired orders on the Instances page (2026-11-19, branch `claude/dashboard-flow-fixes`, not committed)

Fixes F1 to F9 of the anti-slop audit 004 (kept outside git in `anti-slop/`). Orders whose payment link expired no longer
appear under "Awaiting payment": they move to an "Expired orders" list under the instances, with "Deploy again", which opens
Deploy with the order's name and plan filled in (`?name=&plan=`). Deploy warns that a new checkout cancels the payment link
of an unpaid order. After a paid return the alert links to the new instance and the `?payment=` query is dropped. Checks:
web typecheck, lint, 175 tests, build, and a headless click-through in mock mode. The paid and failed returns and the Deploy
warning were not run (they need a real gateway or priced plans). A customer cannot remove an expired order yet: the backend
ends it after 7 days; a remove endpoint would belong in the Go backend.

Same branch, second part (owner request 2026-11-19):
- Language switch ID/EN (`lib/i18n.ts`, `lib/i18n-id.ts`, default Bahasa Indonesia) and theme switch dark/light
  (`lib/prefs.ts`, light palette in DESIGN.md "Light theme", default dark), in the sidebar and on Account; saved per browser
  in localStorage and applied before paint by an inline script in the root layout. Translated so far: sidebar, Instances,
  Deploy, Account, Support, status badges, payment alerts. Still English: the instance detail tabs, the sign-in screens,
  backend error messages and backend status reasons. A test fails on any `t()` text without a translation.
- Support page (`/support`, sidebar "Bantuan"): Telegram from the landing page, email from the new build variable
  `NEXT_PUBLIC_CONTACT_EMAIL` (hidden when empty), links to `/docs` and `/kontak`. The footer links Telegram.
- Account page reworked: email, sign-in method, change/set password (`/set-password`), orders and payments, preferences,
  account deletion through support. Deploy: no "change plans later" claim, price first on plan cards, unset rows hidden.
- Instances: status filter and sort, "Active first" by default (`lib/instance-list.ts`).
Checks: web typecheck, lint, 186 tests, build, `@google/design.md@0.4.0` lint 0 errors 0 warnings, headless click-through
(both themes, both languages, filter, sort, phone width, no console errors).
- Review fixes: a paid or failed renewal return no longer says an instance "is being created" (`isRenewal`, `retryHref`);
  "Change password" uses `/set-password?from=account` and returns to Account; the query cache is cleared when the session
  ends (`AuthGate`), so another account on the same tab never sees cached data; ended orders get no Billing link; the
  language buttons' names contain their visible text; the browser bar colour follows the theme. 188 tests; mock e2e
  (dashboard-mock, dashboard-mock-mobile) 30 passed, 1 skipped as before. Not run: T1 e2e, a real gateway return.

## Customers no longer call the admin API (2026-11-19, branch `claude/no-admin-probe-for-customers`, PR #74, not merged)

- **Why:** the owner saw every customer's browser call `GET /api/v1/admin/me` (403 `forbidden`) from the sidebar's Admin link.
  No data leaked, but it told every customer the admin API exists.
- **Change:** customer `GET /api/v1/me` now also returns `admin` (true only when the caller's own email is on `ADMIN_EMAILS`).
  The dashboard's `AdminLink` calls `/admin/me` only when that flag is true. `AdminGate` on `/admin` pages still asks `/admin/me`
  directly. The admin API's own checks (allowlist, `aal2`) are unchanged; the flag is a hint, not protection.
- **Quiet console:** the dashboard's `[nibie-api] ... failed` line (`apps/web/src/lib/api/live.ts`) is logged in development
  builds only; production users see the error in the UI, not in the browser console.
- **Checks** (Windows): backend `tsc` clean; integration `customer-api` 22 of 22 (one new test); dashboard typecheck, lint, 167 of 167
  (plus one new console test, `customer-api.test.ts` 17 of 17).
- **Deploy order:** a dashboard deployed before the backend hides the Admin link until the backend is live (admins can still open
  `/dashboard/admin` directly).

## Plan stock managed from the admin panel (2026-11-19)

**Branch `claude/plan-stock`, PR #73, not merged:**
- **Why:** the owner asked for stock management per plan ("add management stock paket"). Decisions taken with the owner: a number per
  plan (empty = no limit); used = instances + paid subscriptions waiting for their instance + unexpired invoices (the
  `MAX_TOTAL_INSTANCES` count, per plan); the free plan stays on `FREE_BETA_SLOTS`; the number is changed from the panel.
- **Data:** `Plan.stockLimit Int?` (migration `20261119200000_add_plan_stock_limit`, check `>= 0`). Null: no limit.
- **Backend:** `totalLoad(db, now, planId?)`, `hasStock`, `stockLeft` in `src/modules/instances/capacity.ts`. Checkout refuses a new
  purchase with `409 plan_sold_out` (`PlanSoldOutError`) once the stock is used, under a per-plan advisory lock taken after the tenant
  lock, so two buyers cannot both take the last unit. Renewals and paying customers are never blocked. Customer `GET /plans` marks a
  sold-out priced plan `available: false` for everyone, invited accounts included (the dashboard already shows "Stock 0"). Admin
  `GET /plans` adds `stockUsed` and `stockLeft`; `POST /api/v1/admin/plans/:planId/stock` (`stockLimit` 0..100000 or null, reason)
  writes one audit row (`detail.from`/`to`) per real change, refuses the free plan (`409 free_plan_stock`). MCP tool `set_plan_stock`.
- **Dashboard:** admin Plan page gets a Stok column ("Sisa 3 dari 5", "Habis (3/2)", "Tanpa batas", "Slot beta") and an "Ubah stok"
  dialog with a reason (`src/lib/admin-plans.ts`).
- **Not covered:** an admin creating a paid instance directly through `POST /instances` (testing path) skips the stock. Lowering the
  stock below what is used only stops new purchases.
- **Checks** (Windows, local Docker Postgres `hermes_test`, a heavily loaded machine):
  - Backend `tsc` clean. Unit tests 544 passed, 2 failed (the known Windows-only `egress-canary` tests).
  - Integration: `admin-plan-stock` (new, 5), `billing-service` (2 new: sold out, race for the last unit), `customer-api`,
    `admin-api`, `admin-api-keys`: all pass. `billing-api`: 3 failures on the first run (one deadlock in `resetDb`), 1 different
    failure on a solo run (`replay is 200 and changes nothing`, a fixed 150 ms wait for the email on a machine where one test took
    15-65 s). Both runs failed different tests, and that file never sets a stock, so they look like timing flakes; not re-run on `main`
    to compare.
  - Dashboard: typecheck, lint, 170 of 170 tests (new `test/admin-plans.test.ts`). `next build` not run.

## Payment return page said "Payment not completed" after a successful payment (2026-11-19, branch `claude/payment-return-fix`)

Bug: on `/dashboard/instances?payment=...` the dashboard showed "Payment not completed" right after a PAID purchase (the owner's
instance was created and chat worked end to end), because `evaluateReturn` (`apps/web/src/lib/billing.ts`) returned `failed` when
*any* older abandoned purchase had an EXPIRED invoice. Now it judges only the most recently issued invoice (latest `expiresAt`; the
customer API does not expose the merchant order id in `?payment=`). Older expired purchases still appear under "Awaiting payment"
as expired. Dashboard only, no backend change. Checked: web `test/billing.test.ts` (14 pass, new regression case), `typecheck`,
`lint`. Not checked in a browser. Goes live through Cloudflare Workers Builds once merged to `main`.

## Automatic backend deploy from main (2026-11-19)

On the owner's word ("set auto deployment on main for all services"):
- `.github/workflows/deploy.yml` deploys the backend after `ci` passes on a push to `main`, through a key locked on the VPS to
  `/usr/local/sbin/hermes-auto-deploy` (copy of `ops/host/hermes-auto-deploy.sh`), which runs `deploy.sh origin/main` only when backend
  paths changed. Details and how to stop it: [../deploy/README.md](../deploy/README.md), "Automatic deploy from main".
- Done on the VPS: wrapper installed (root, 755); the key line added to `~ubuntu/.ssh/authorized_keys` (backup
  `authorized_keys.bak-autodeploy-*` next to it). Done on GitHub: secrets `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS`. The
  private key exists only in the GitHub secret.
- Dashboard, landing and docs already deployed from `main` through Cloudflare Workers Builds; unchanged.
- **First run worked:** merging PR #69 (`329b90f`) ran CI, then deploy run 44376649803: dump, build `329b90f`, migrations, recreate,
  "OK: backend 329b90f is ready (previous tag was b6d0d56)". Full log on the host in `/var/log/hermes-deploy/`. A dry run of the
  wrapper on the host was not done (blocked in that session); this real run was the test.
- **From now on, merging to main deploys the backend**, migrations included, whenever backend paths change.

## Admin Pengaturan page, admin keys and admin MCP (2026-11-19)

**PR #65, merged as `ef22712`, live since the first automatic deploy (`329b90f`, migration `20261119100000_add_admin_api_key` applied):**
- **Checked live:** `/dashboard/admin/pengaturan` in the owner's Chrome shows all four cards with real values and no secret, and the
  key list loads (no keys yet). From outside, `POST /api/v1/admin/mcp` answers 401 with no key and with a wrong key. No key was
  created and no Claude Code client has connected yet.
- **Why:** the owner asked for an admin settings page like NibieRouter's, plus admin keys and an admin MCP server so Claude Code
  can do the panel's work.
- **Pengaturan page** (`/dashboard/admin/pengaturan`): read only. Cards Penagihan, Email, Masuk & beta, AI / NibieRouter from the new
  `settings` object on `GET /api/v1/admin/system`. It shows modes, counts and names (gateway, sandbox/production, sender address,
  default model); never a key, token, password, URL or email list (test-enforced). Changes still go through the server env file.
- **Admin keys** (new table `AdminApiKey`, migration `20261119100000_add_admin_api_key`, RLS on): created on the Pengaturan page by an
  admin at `aal2`, with a name, a reason and an expiry of 30, 90 or 365 days or none. Shown once; only the SHA-256 hash is stored. A
  key stands for its creator at `aal2`, stops working when revoked, expired or when the creator leaves `ADMIN_EMAILS`, and cannot
  list, create or revoke keys (`403 session_required`). Every use is audited with `detail.via = 'key'` and the key prefix.
- **Admin MCP** (`POST /api/v1/admin/mcp`, dependency `@modelcontextprotocol/sdk` 1.32.2): 16 tools, the panel's reads plus
  `add_beta_invite` / `revoke_beta_invite` (reason required). Each tool calls the existing admin route through `inject`, so the same
  auth, validation, rate limit (120/min per admin; one tool call counts twice) and audit apply. Caddy already forwards
  `/api/v1/admin/*`, so no proxy change is needed.
- **Risk to know:** a key skips MFA. Anyone holding it reads every customer's data and can change beta invites. Keep expiries short.
- **Checks** (Windows, local Docker Postgres `hermes_test`):
  - Backend `tsc` clean. Unit tests 537 passed, 2 failed (the known Windows-only `egress-canary` tests).
  - Integration: `admin-api-keys` (new, 6), `admin-api`, `admin-beta-invites`, `admin-auth`, `beta-invites`: all pass.
  - Dashboard: typecheck, lint, 166 of 166 tests, `next build` (route `/admin/pengaturan`). The new test caught "Tanpa batas"
    being sent as 30 days; fixed before this entry.
  - Not done: the page was not opened in a browser, and no real Claude Code client has called the MCP endpoint yet (only the
    JSON-RPC calls in the integration test).

## Beta invite sends an email (2026-11-19, merged as PR #66 `536e9c4`, deployed to the VPS the same day)

Bug: "Tambah undangan" in the admin panel only wrote a `BetaInvite` row; nothing emailed the person, so invited users never
got a message. Now `POST /api/v1/admin/beta-invites` sends `renderBetaInvite` (register link, no admin-typed note or reason)
through the existing mailer after the row and its audit entry are committed, and answers `{ invite, emailSent }`.
A failed send or a missing mailer never undoes the invite (`emailSent: false`); the panel shows a warning toast then.
Needs the SMTP settings on the VPS (`SUMOPOD_SMTP_*`, `MAIL_FROM`); without them nothing is sent. Auth email already lands in
spam on Gmail (see the free beta section), so invitations may too.
Checked: `pnpm build`, `test/integration/admin-beta-invites.test.ts` (8 pass), web `typecheck` and `test/admin-beta.test.ts`.
Not checked: a real send over SumoPod SMTP. Web lint not run.
Follow-up (2026-11-19, not committed, not deployed): the beta invite routes mask PII in every response. `email` and `addedBy` come
back as `h********n@gmail.com`; `fromEnv` is masked too (`maskEmail` in `src/modules/beta/invites.ts`). The `note` is returned as typed. The
database rows, the invitation email and the `AuditLog` detail (`{ email }`) still hold the full address.
Deployed with `ops/host/deploy.sh` on the owner's word ("backend 536e9c4 is ready"; dump taken first, no migration; previous tag
`ec27f10` kept for rollback). After the deploy the public API answered 200 and the startup log showed `mail: true`. No invitation
has been sent to a real inbox yet.

## Email lands in spam (2026-11-19, display-name change not committed, not deployed)

Gmail "Show original" of the beta invite: SPF, DKIM and DMARC all PASS, so authentication is not the cause. Checked in DNS:
SPF `v=spf1 mx include:spf.kirim.email ~all`, DMARC `p=none` (report address is a personal Gmail), sending IP has reverse DNS
(`ip04.s01.kirimemail.com`). Remaining causes are reputation: `nibie.app` is a new sending domain on a shared SumoPod IP.
Changed: `From` now carries the display name "Nibie Cloud" (`MAIL_FROM_NAME` in `src/modules/billing/mailer.ts`). Checked: `pnpm build`, `test/unit/mailer.test.ts`.
Not a code fix, owner to do (SumoPod guide "Keeping Emails Out of Spam"): warm up the domain on `noreply@nibie.app` only, 50 mails on
day 1, 100 on day 2, 500 on day 3, rising for about 30 days; send by hand to colleagues first and have them press "Not spam" / move to Primary;
watch the SumoPod Activity Log. Optional later: DMARC `p=quarantine` once reports are clean, and a `rua` address on the domain.

## Personal data audit and log masking (2026-11-18)

**Branch `claude/pii-log-masking` (worktree `nibie-cloud-pii`, not committed, not deployed).** Read-only audit of every response, log line, outbound
payload and admin page; the result is in [architecture.md](architecture.md), "Personal data".
- **Found:** the request log wrote the full URL and the exact client address. `GET /api/v1/admin/customers?q=<email>` therefore put searched
  customer emails into the container logs. Invite and audit queries returned whole rows with no `select`.
- **Changed:** request log now writes the path without its query string and the address cut to its network (`maskIp` in `src/shared/ip.ts`,
  `serializeRequest` in `src/shared/logger.ts`); no port. `ipv6Groups` is shared with the rate-limit key, whose output is unchanged.
  `INVITE_SELECT` and a named column list in `AuditService.list` keep the same fields as before.
- **Owner decisions:** admin panel stays unmasked (allowlist, `aal2`, read audit); client addresses are truncated in logs.
- **Not changed:** a Telegram user id and any end-user text in tenant container logs; no retention rule for logs or the audit trail.
- **Checks** (Windows, local Docker Postgres `hermes_test`): `pnpm build` clean; `pnpm test:unit` 539 passed, 2 failed (the two known
  `egress-canary` failures on this machine); admin, audit and beta-invite integration files 44 passed. New tests in `test/unit/logger.test.ts`.
  Not run: the rest of the integration suite and a live `pnpm dev` request.

## Free beta is invite-only (2026-11-18)

**Live change, on the owner's word ("go"), 15:24 UTC:**
- `FREE_BETA_SLOTS=0` on the VPS (was 10). The env file was backed up next to itself in `/etc/hermes-cloud/` first, then the backend
  was recreated with `--force-recreate`; it came back healthy, and `GET /api/v1/public/beta-slots` answers `{"total":0,"remaining":0}`.
  `BETA_ALLOWED_EMAILS` is unchanged.
- From now on, only invited accounts can deploy: emails in `BETA_ALLOWED_EMAILS` or with an active invite on the admin page
  "Undangan beta". Anyone else gets `403 provisioning_not_enabled`. This refusal was not tried live.
- The owner turned Supabase "Allow new users to sign up" back on (checked: `/auth/v1/settings` reports `disable_signup: false`).
  Strangers can register, but they cannot deploy.
- The owner removed `NEXT_PUBLIC_FREE_BETA_OPEN` from the landing Worker and retried its build. This was not verified yet: right
  after, `https://cloud.nibie.app/` still showed "Daftar beta gratis".
- The existing free instance was kept on the owner's choice; 7 tenant containers kept running through the recreate.
- Waiting-list invitations stop while the slots are 0.

**Code fix, branch `claude/invited-free-plan-only` (not committed, not deployed):**
- **Problem:** an invited account could `POST /api/v1/instances` with a priced plan and get it without paying. The dashboard never
  does this, because it sends priced plans to checkout, but the API allowed it.
- **Fix:** `customer-routes.ts` now refuses a priced plan on that route (`403 provisioning_not_enabled`, "Paid plans are created through
  checkout") unless the email is in `ADMIN_EMAILS`. An admin still has to be invited to pass the invite gate. Checkout for invited
  accounts is unchanged; production uses SumoPod with `SUMOPOD_ENV=production`, so they pay real money.
- **Test:** new test in `beta-invites.test.ts`: env-invited and table-invited accounts get 403 on a priced plan, an invited admin gets 202.
  It failed before the fix.
- **Checks** (Windows, local Docker Postgres `hermes_test`):
  - `tsc` clean.
  - Unit tests: 535 passed, 2 failed; the 2 are the known Windows-only `egress-canary` shell tests.
  - Integration: `customer-api`, `waitlist`, `admin-api`, `admin-auth`, `instance-commands`, `integration-routes`, `beta-invites`
    and `admin-beta-invites`, 125 of 125.
  - `billing-api` 26 of 26, run alone twice. In a 4-file run, 3 of its callback tests failed on the fixed 150 ms `settle()` wait;
    this is the same flake as the PR #62 entry below.

**Every plan is shown to every user, same branch (owner request):**
- **Before:** `GET /api/v1/plans` hid the plans an account could not take. With 0 slots and `PAID_CHECKOUT_OPEN=false`, a
  non-invited user saw an empty list.
- **Now:** it lists every active plan with a new field `available` (free plan: invited, free slots left, or an open waiting-list
  invitation; priced plans: invited or `PAID_CHECKOUT_OPEN`). `POST /instances` and checkout enforce the same rules as before.
- **Dashboard deploy page:** plans with `available: false` show a "Stock 0" badge and a disabled radio, and the default selection
  skips them. When none is open, an alert asks the person to request beta access on cloud.nibie.app; this replaces the
  waiting-list text.
- A missing `available` (older backend) counts as `true`, so the dashboard and backend can be deployed in either order.
- API reference updated (`apps/docs/.../akun-dan-paket.mdx`).
- **Checks:**
  - Backend `tsc` clean; `customer-api`, `waitlist`, `beta-invites`, `admin-beta-invites` 82 of 82; `billing-api` 26 of 26.
  - `apps/web`: typecheck and lint clean.
  - The deploy page was rendered in mock mode with one plan temporarily out of stock, in headless Chromium at 1280 px and 400 px.
    It showed the badge, the radio was disabled, a click did not select it, and there were no console errors.

## Security hardening after an OWASP Top 10 review (2026-11-18, branch `claude/owasp-hardening`, draft PR)

The full review was given to the owner privately; it is not kept in this public repository. Changes:

- **Billing webhook:** the SumoPod `X-Webhook-Token` is now compared in constant time, and an empty token is refused
  (`billing-service.ts`).
- **Public rate limits:** IPv6 visitors are keyed by their /64 network instead of the full address (`rateLimitKey` in
  `public-routes.ts`).
- **Waiting-list confirmation email:** carries no text typed on the form until the address is confirmed. The invitation email
  still greets by name.
- **Admin audit:** a failed write of an admin read-audit entry is now logged (error class only) instead of silently dropped.
- **Browser headers:** the dashboard (`next.config.ts` `headers()`) and the landing page (`public/_headers`) now send
  `X-Frame-Options: DENY`, `Referrer-Policy`, `nosniff`, `Permissions-Policy` and a Content-Security-Policy (third round).
- **`.mcp.json` is gitignored** (local agent tooling config).
- **Second round, same branch:**
  - **Runtime:** `HERMES_RUNTIME=runsc` is now required when `NODE_ENV=production`; startup fails with `runc`.
    `deploy/backend.env.example` defaults to `runsc` with `HERMES_DNS_RESOLVERS`.
  - **Client address:** Fastify trusts only the loopback proxy (`trustProxy: ['127.0.0.1', '::1']`), so `req.ip` is the real client
    address (the request log has carried only its network since the personal data audit, see the first section). The operator API's proxy-header guard is unchanged.
  - **BYOK provider URL:** a provider `baseUrl` must use the standard https port; any explicit other port is refused.
  - **Waiting-list send caps:** at most 3 confirmation emails per address while its entry lives, and at most 100 per hour
    platform-wide. A failed send is given back. New column `WaitlistEntry.confirmSends`, migration
    `20261118090000_waitlist_confirm_sends`.
  - **Dev bridge:** the dashboard dev bridge never runs in a production build; `HERMES_ALLOW_DEV_BRIDGE` is gone.
- **Third round, same branch:**
  - **SumoPod webhook signatures:** with `SUMOPOD_WEBHOOK_SECRET` (the webhook's Svix "Signing Secret", `whsec_...`) every
    webhook must carry a valid `svix-signature` over its raw body, id and timestamp (5-minute window); the token alone is
    then refused (`src/modules/billing/svix.ts`, checked against Svix's published test vector). Required in production
    when SumoPod is configured. SumoPod documents no payment-status API, so there is no status check; the signature covers
    the status field.
  - **Waiting-list captcha:** with `TURNSTILE_SECRET_KEY` the join needs a Cloudflare Turnstile token, checked with
    siteverify before anything is stored (`400 captcha_failed`, `503 waitlist_unavailable` when Cloudflare cannot be
    reached). Required in production while the list is on. The landing form shows the widget with
    `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (the dashboard sign-up widget).
  - **Admin MFA:** every admin route, reads included, needs `aal2`; an allowlisted admin at `aal1` gets
    `403 mfa_required`. The dashboard's `AdminMfa` screen enrols a TOTP authenticator (QR code plus manual key) on the
    first visit and asks for the code after that (`supabase.auth.mfa`). Also fixed: the admin gate never recognised the
    admin client's 403 (its errors are not `ApiError` instances), so a non-admin got an error state instead of
    "Tidak berwenang".
  - **CSP:** Next.js's "without nonces" policy (pages are prerendered, so no nonce): scripts and frames only from the site
    and Turnstile; `connect-src` only the site, the API, Supabase and Turnstile; `object-src 'none'`, `base-uri`,
    `form-action`, `frame-ancestors 'none'`. Dashboard origins come from the build variables (`apps/web/src/lib/csp.ts`);
    the landing `_headers` names `https://api.cloud.nibie.app` (edit it if `NEXT_PUBLIC_API_URL` changes).
  - **Images:** `node`, `redis` and `caddy` pinned by multi-arch digest (tag kept for reading) in `deploy/Dockerfile` and
    `deploy/compose.prod.yaml`. The backend image still carries devDependencies: it runs `tsx` and the Prisma CLI.
  - **Dependency audit** (`pnpm audit --prod`, 2026-11-18): backend 1 high (`deepmerge-ts` inside the Prisma CLI config
    loader, no user input), web 1 high and 2 moderate (`picomatch`, `glob`, `minimatch` inside OpenNext build tooling), docs 1
    high (`picomatch` in the Fumadocs build); landing and e2e clean. All are build or CLI tooling; fixes need major bumps or
    do not exist yet, so nothing was forced.
- **Deploying this branch:**
  - Run `prisma migrate deploy` before starting the new image.
  - The VPS env must keep `HERMES_RUNTIME=runsc`, as HANDOFF.md records, and must gain `SUMOPOD_WEBHOOK_SECRET` and
    `TURNSTILE_SECRET_KEY`; otherwise the backend refuses to start and `ops/host/deploy.sh` rolls back.
  - Landing build variable `NEXT_PUBLIC_TURNSTILE_SITE_KEY`; the Turnstile widget must list `cloud.nibie.app`.
  - Admins enrol an authenticator on their next visit to the panel; Supabase MFA (TOTP) must be enabled.
- **Owner confirmations (2026-11-18, not checked from this repo):**
  - Production takes payments through SumoPod, so the Duitku callback path is not live.
  - RLS is enabled on the `hermes` tables in Supabase.
- **Not done** (no minimum length for `SUMOPOD_WEBHOOK_TOKEN`): the token is issued by SumoPod and its length is not
  documented here.
- **Still open:** a payment-status check for Duitku before it is ever enabled (SumoPod has no documented status API);
  a CSP without `'unsafe-inline'` (needs nonces and dynamic rendering, or the experimental SRI); the audit findings above.
  The local `.mcp.json` (not in the repo) was switched to a read-only Supabase connection with docs, database and debugging only.
- **Checks:**
  - Backend: `tsc` clean. Unit tests 535 passed, 2 failed; the 2 failures are shell-script tests in
    `egress-canary.test.ts` that do not run on the Windows host used, and are unrelated to this change. Integration tests:
    waitlist, customer-auth, provider-service, sumopod-webhook, customer-api, admin-api, admin-auth, integration-routes and
    billing-api, 179 of 179 passed against local Docker Postgres and Redis, with the new migration applied to `hermes_test`.
  - `apps/web`: typecheck, lint, 151 tests and build pass.
  - `apps/landing`: typecheck, lint, 67 tests and build pass, and `out/_headers` carries the CSP.
  - Browser: the dashboard builds (customer mode, and mock mode with `/instances`, `/deploy`, `/admin`, `/sign-in`) under
    `next start` render in headless Chromium with no console error and no CSP violation. e2e T0 (landing export plus
    the mock dashboard build, CSP headers on the dashboard): 53 passed, 1 skipped. Ports 3100 and 3300 must be free first;
    Playwright reuses a running `next dev` server, which gives misleading failures.
  - Not verified: the headers on the deployed Cloudflare Workers, a real SumoPod signed webhook, a real Turnstile token, and
    the MFA enrolment against the real Supabase project.

## Beta invite list in the database (2026-11-18, branch `claude/beta-invite-list`, on `origin/main` at `6da2ef5` after the OWASP merge, NOT committed, NOT deployed)

Until now the invite list was only the `BETA_ALLOWED_EMAILS` env value, so every invite meant editing the VPS env file and
recreating the backend. The owner can now add and revoke invites from the admin panel (page "Undangan beta"); an invite takes
effect on the next request.

- **What changed:**
  - New table `BetaInvite` (email unique, lowercase; `note`, `addedBy`, `createdAt`, `revokedAt`), migration
    `20261118100000_add_beta_invite` with row level security enabled.
  - New `src/modules/beta/invites.ts`: `isInvited`, `addInvite` (idempotent, clears a revocation), `revokeInvite`, `listInvites`.
  - `src/http/customer-routes.ts`: an account counts as invited if its email is in `BETA_ALLOWED_EMAILS` OR has an active
    `BetaInvite` row. This applies to `GET /plans`, `POST /instances` and the billing gate. The env list works as before, and a
    change takes effect on the next request, with no restart.
  - `src/http/billing-routes.ts`: the gate may be async.
  - `test/helpers/db.ts`: `resetDb` also truncates `BetaInvite`.
  - Admin API (`src/http/admin-routes.ts`), the first routes that change data: `GET /api/v1/admin/beta-invites` (database rows,
    revoked ones included, plus the `BETA_ALLOWED_EMAILS` list read only), `POST /api/v1/admin/beta-invites` (email, optional note,
    required reason of 3 to 500 characters) and `POST /api/v1/admin/beta-invites/:inviteId/revoke` (reason). Like every admin route
    they need `ADMIN_EMAILS` and `aal2`. Each change and its `AuditLog` row (target `beta_invite`, reason, `detail.email`) are written in
    one transaction (`AuditService.record` takes an optional transaction client); revoking an already revoked invite changes and
    records nothing.
  - Dashboard (`apps/web`): page `/admin/beta` ("Undangan beta", in the admin nav) with an add form, the server list, the table and a
    revoke dialog that asks for a reason; client calls in `lib/api/admin.ts`, form rules in `lib/admin-beta.ts`.
- **Not built yet:** removing an address that comes from `BETA_ALLOWED_EMAILS` (host env only), and audit entries for customer actions.
- **Checks run (Windows, local Docker Postgres `hermes_test`):**
  - Backend `tsc` clean; unit tests 535 passed, 2 failed (the two shell-script tests in `egress-canary.test.ts` that fail on this Windows
    host on `main` too).
  - Integration, 88 of 89 on the first run: `beta-invites` (9), `admin-beta-invites` (7), `admin-api`, `admin-auth`, `audit-service`,
    `customer-api`, `billing-api` (1 new). One `billing-api` test ("a suspended instance cannot be started or restarted") failed once while
    the seven files ran together and passed when run alone and in a full re-run of its file (26 of 26); not investigated further.
  - `apps/web`: typecheck and lint clean; `admin-beta` (new), `admin-api` and `admin-gate` tests 25 of 25. The full dashboard test suite and
    `next build` were not run.
  - `prisma migrate diff` from the migrations to `schema.prisma`: no difference. `relrowsecurity` is true on `BetaInvite`.
  - Not verified: the page in a browser, the add and revoke calls against a real Supabase login with MFA.
- **To deploy:** run `prisma migrate deploy` before starting the new image (`ops/host/deploy.sh` does this), then confirm RLS on Supabase
  (`select relrowsecurity from pg_class where relname = 'BetaInvite'`). Not verified: the migration on Supabase.

## Docs refresh for the next handoff (2026-11-18, from `main` at `84a6dbe`, docs only)

- **Agent instructions in one place.** `AGENTS.md` now lists all five packages with their commands, the document precedence,
  the Next.js 16 note, deployment and host-control pointers; `CLAUDE.md` only loads it. The stale "last verified 2026-11-13" test
  counts were removed from `AGENTS.md` (test results belong here). `apps/docs/AGENTS.md` and `apps/landing/AGENTS.md` are the block
  `next dev` writes, committed as generated.
- **Known gaps refreshed** (`architecture.md`): entries 1-5, 7-9, 9a, 9b and 12 now match what this file and HANDOFF.md section 7
  record as verified on the VPS (XFS quota, egress rules, `runsc` with DNS, TLS through Caddy, SumoPod sandbox payment, DB backup and
  restore drill, NibieRouter keys for free instances). Gaps still open for the security audit: no audit trail for customer
  actions, the backend trusts the Supabase `email` claim without enforcing confirmation, one shared operator token, no `runsc` escape
  testing, the egress rate cap is unmeasured.
- **Root `README.md` and `docs/README.md`** describe the five packages and the free-beta status.
- **Not verified:** whether the tenant volume backup timer (PR #39) runs on the VPS (`systemctl list-timers | grep hermes-tenant`).
- **Billing paragraph in `AGENTS.md`** now names SumoPod as the default gateway (`BILLING_GATEWAY`), Duitku optional.
- No code changed, so no tests were run.

## Anti-slop fixes for dashboard, landing and docs (2026-11-18, merged as PRs #57, #58 and #59)

Audit of the three apps in anti-slop mode AFTER; finding numbers are D (dashboard), L (landing), X (docs). One PR per branch.

- **`claude/dashboard-antislop-fixes`** (`apps/web`):
  - "Sign out" on the account page now ends the session (D1).
  - Removed the "Back up before runtime upgrades" checkbox that saved nothing (D2).
  - Region is hidden in customer mode, because it was never sent (D3).
  - A failed instance is told to delete and deploy again (D5).
  - The free plan reads "Free during the beta" (D9, D10).
  - Preview labels and the data-mode chip are hidden in customer mode (D8, D15, D16).
  - Indonesian labels and "-" for empty values in the admin panel (D7, D21).
  - Smaller wording, button-variant and empty-state fixes (D6, D11-D14, D17-D22, D24).
  - Brand logo in the app and sign-in headers, plus favicon and app icons. The asset is recorded in `DESIGN.md`.
  - Not done, waiting for the owner: D4 (backup wording, depends on the VPS backup timers) and D23 ("24/7").
- **`claude/landing-antislop-fixes`** (`apps/landing`):
  - Planned features say "Belum tersedia" (L4).
  - Readable error text (L5).
  - 44 px tap targets (L6).
  - Slot note placement (L11), "Telegram sekarang" (L13).
  - Focus ring on text links (L16) and a phone menu (L17).
  - Focus after submit (L18), no hard-coded slot count (L19).
  - Logo and icons.
  - The rest (L1-L3, L7-L10, L12, L14, L15) waits for owner decisions.
- **`claude/docs-antislop-fixes`** (`apps/docs`):
  - Quickstart, Telegram and AI provider pages rewritten for the free beta.
  - The API reference matches the live endpoints, with new pages for integrations and subscriptions.
  - Feature lists are split into available and planned, and status and error tables are corrected.
  - Onest 600 is loaded; logo and icons added.
  - Waiting for the owner: X3 (prices), X8 (AI usage billing), X17 (backup timers), X19 (free beta lifecycle).
- **Checks:**
  - Dashboard: typecheck, 137 tests.
  - Landing: typecheck, lint, 60 tests.
  - Docs: typecheck, lint, build.
  - Not checked in a browser: the admin panel, the customer dashboard behind sign-in, and the rendered docs.

**Since the previous entry:**
- PR #56 was merged (`9922356`) and deployed to the VPS on 2026-11-18.
- On Supabase production, `hosting` and `hosting-kredit` were raised to 5120 MB. The free plan `beta-starter` is still 1024 MB, pending an owner decision.

## Branch `claude/free-signup-flow`: free beta sign-up flow, tested end to end on localhost (2026-11-17, merged in PR #56 and deployed 2026-11-18)

From `main` at `f8f035f`. Committed as `83fb915`, PR #56; the anti-slop audit fixes follow on the same branch.

- **Dashboard sign-up.**
  - Email registration is confirmed with the code from the email. The field takes exactly the project's length: 6 by default, matching Supabase's "Email OTP length", which the owner changed from 8 to 6 on 2026-11-17. `NEXT_PUBLIC_EMAIL_CODE_LENGTH` overrides it. A wrong or expired code gives one clear message, and "Send a new code" has a 60 s wait.
  - "Continue with Google" uses Supabase OAuth with PKCE and returns through `/dashboard/auth/callback`.
  - A Cloudflare Turnstile widget is included; Supabase does not enforce it yet.
  - The terms box is now first on the register card.
  - The Google "G" is an approved exception in `DESIGN.md`.
- **After deploy.**
  - A deploy still opens the instance overview, so provisioning is visible. Its Health card makes "Connect Telegram" the primary button until a bot is set, and the provider row says "Not set up yet" instead of "Not tested". Telegram is now the first tab of Configuration.
  - The AI provider tab says NibieRouter is being set up and refreshes by itself.
  - The deploy page explains an empty plan list instead of "No payment for this plan".
- **Errors.** An unreachable API now says "Could not reach the API at <host>" instead of "Something went wrong" (`apps/web/src/lib/api/live.ts`).
- **Backend.**
  - `CORS_EXTRA_ORIGINS`: development only, refused in production.
  - New free instances get their NibieRouter key on every 15 s maintenance run (`RouterProvisioner.runNewFree`) instead of waiting up to 5 minutes; failures still retry on the billing tick.
- **Landing.** `NEXT_PUBLIC_DASHBOARD_URL` lets the local landing link to the dashboard on its own port. The price section now says 5 GB storage.
- **Storage 1 GB to 5 GB** (owner decision, 2026-11-17).
  - Why: Hermes sends "Low disk space" to the customer's chat whenever its disk has less than 2 GiB free, so every 1 GB instance got it. The smallest competing plans carry 8 to 10 GB (Agent37 Basic 8 GB, OpenClaw Launch Lite 10 GB; from web search results on 2026-11-17, not checked on their own pages).
  - `deploy/sql/2026-11-17-storage-5gb.sql` raises `hosting` and `hosting-kredit` to 5120 MB. It is **not run**; it runs on Supabase only with the owner's approval.
  - Existing volumes keep their size. The draft host steps to grow them are in `docs/disk-quota-host-notes.md`, not verified.
  - The seeded `config.yaml` now also sets `sessions.auto_prune: true` unless the file already has a value (`src/modules/runtime/hermes-config.ts`). Hermes then never asks the customer, and deletes ended sessions idle for more than 90 days.
- **Checks run.**
  - Dashboard: typecheck, lint, 132 tests.
  - Landing: typecheck, lint, 60 tests, build.
  - Backend:
    - `tsc` clean.
    - Unit tests: 508 passed, 2 failed. Both failures are in `test/unit/egress-canary.test.ts`, which fails the same way on `main` on this Windows workstation.
    - Router provisioner integration tests: 19 passed, on local `hermes_test`.
  - Not run: the other integration tests and the `@google/design.md` lint (no local copy of the CLI).
- **Local end-to-end run** (backend :3400, dashboard :3500, landing :3300; real Supabase Auth of the production project, local Postgres, stub image), steps done by the owner in their own browser:
  - landing counter, then register with an alias and the 8-digit code (before the switch to 6; the 6-digit flow and "Send a new code" were not re-tested);
  - wrong code message;
  - free deploy reaching `ACTIVE` with the counter going from 10 to 9;
  - Google sign-in;
  - NibieRouter attached 28 s after `ACTIVE` with the provider test OK;
  - Telegram test message received;
  - the "Could not reach the API" text with the backend stopped.
- **Outside the repository** (Supabase project `nibie-cloud-sgp`, changed through the owner's browser with their approval):
  - Redirect URL `http://localhost:3500/**` added;
  - "Confirm signup" template shows `{{ .Token }}` above the existing link;
  - Google provider enabled with an OAuth client made in Google Cloud;
  - a Turnstile widget made in Cloudflare for `cloud.nibie.app` and `localhost`.
  - Captcha is **off** in Supabase.
- **Production rollout, in order, each step on the owner's word:**
  1. Merge and deploy the dashboard, landing and backend.
  2. Switch on Supabase captcha with a freshly rotated Turnstile secret.
  3. Test sign-up on `cloud.nibie.app`.
  4. Remove the link from the email template.
  5. Delete the test accounts: the alias accounts in Supabase Auth, and their router users.
- **Local database note.** The local database had no free plan; `free-beta-local` was inserted by hand there only. Production plans are in `deploy/sql/2026-11-17-production-plans.sql`.

## Deployed: waiting list with email confirmation (2026-11-17, VPS image `db46806`)

- **Git.** PRs #53 (docs) and #51 (waiting list with double opt-in) were merged on 2026-11-17 with the owner's approval; `main` at `db46806`.
- **Deploy** (run by the owner on the VPS with `bash /opt/hermes-cloud/ops/host/deploy.sh`; the scripts in `ops/host/` are stored without the
  executable bit, so calling the path directly answers "Permission denied"). Output pasted by the owner: all migrations applied, backend and Caddy
  recreated, "backend db46806 is ready (previous tag was 1584e35, kept on disk for a manual rollback)".
- **Checked from the internet afterwards:** `beta-slots` 200 `{"total":10,"remaining":10}`; `POST /api/v1/public/waitlist/confirm` with a made-up
  token 400 `confirm_link_invalid` (new backend and new Caddy allowlist); `POST /api/v1/public/waitlist` with `{}` 400; operator route 404;
  `https://cloud.nibie.app/daftar-tunggu/konfirmasi` 200 (Cloudflare built the landing from `main`); the public rate limit now counts per visitor.
- **Live waiting-list test** with the owner's address: `POST /api/v1/public/waitlist` answered 200, which for a new address means the confirmation
  email was accepted by SumoPod SMTP. Delivery, the click on the link and the automatic invitation are **not confirmed yet** (owner to check the inbox).
  Once confirmed and invited, that address holds one free slot for 48 hours.
- **Free plan test (owner):** a free instance reached `ACTIVE` in 18 seconds (events pasted by the owner) but had no provider: until now NibieRouter was
  attached only after a payment. Branch `claude/nibierouter-default-free` makes it the default for free instances too (see `setup.md`, "NibieRouter key
  and credit"); not merged or deployed yet.
- **Not checked:** the RLS query on `WaitlistEntry` on Supabase and the backend startup lines for `waiting list` and `nibierouter` (owner steps).

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
  how to run it: [setup.md](setup.md#billing-sumopod); design and gaps: [architecture.md](architecture.md) ("Billing", gap 9a).
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
