# Backend Milestone D (Duitku POP billing + billing emails) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (default) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Status: approved by the owner on 2026-11-14 and built in a cloud sandbox (uncommitted). Task 0 (real Duitku sandbox) and the VPS end-to-end run in Task 9 Step 2 are still open. See "As built" at the end for where the build differs from this text.**

**Goal:** A customer can pay for a hosting subscription with Duitku POP (virtual account and QRIS), a verified payment callback activates or renews the instance, and the backend walks the PRD 10 lifecycle (reminders, 3-day grace, suspension, 30-day retention, deletion) with emails sent over SumoPod SMTP.

**Architecture:** Money state lives in four new tables (`Subscription`, `Payment`, `PaymentEvent`, `BillingNotice`). A `DuitkuClient` (create invoice, verify callback signature) and a `Mailer` (SMTP) sit behind small interfaces so tests use fakes. The public callback is its own Fastify plugin (neither the operator bearer nor the customer JWT applies; the HMAC signature is the authentication). Activation and renewal are compare-and-set transitions in one transaction with the payment, so a replayed callback changes nothing. A billing tick (new repeatable job under the existing Redis lock, with the same in-process fallback as the reconciler) moves subscriptions through reminder, grace, suspension and deletion, and calls the existing `InstanceCommands`/`InstanceService` (stop, start, delete), so leases, fencing and the reconciler's "never restarts STOPPED" rule stay as they are.

**Tech Stack:** Existing Fastify 5, Prisma 6, BullMQ, Vitest 3. New dependencies: `nodemailer` (SMTP client) and `@fastify/formbody` (Duitku posts `application/x-www-form-urlencoded`). Node's built-in `crypto` for HMAC, built-in `fetch` for the Duitku API.

**Spec:** `docs/superpowers/specs/2026-11-12-backend-design.md` section 6 ("D"), PRD 5.4, 10, 11.1, 14, 15.2.

## Global Constraints

- Repository is public: no merchant code, API key, SMTP password, IP address or email address in any file. `.env.example` holds names and placeholders only.
- The browser return URL never changes payment state. Only a callback with a valid signature (or, if the sandbox spike confirms it exists for POP, a signed status check) does.
- Money is integer rupiah (PRD 14.1). Duitku minimum is Rp 10.000; below that the checkout refuses.
- Every payment transition is idempotent: the same callback twice, or a callback after a status check, is a no-op the second time.
- Secrets (`DUITKU_API_KEY`, `SUMOPOD_SMTP_PASS`) are never logged, returned, put in job payloads or in error messages. Request logging must not print the callback form body.
- The existing `BETA_ALLOWED_EMAILS` path for free beta instances keeps working unchanged. The paid path is additive.
- No pricing is invented (PRD 5.2): `Plan.monthlyPriceIdr` is nullable and `null` means "checkout disabled for this plan". Sandbox prices are set by seed script, clearly marked, and never in a migration.
- Node >= 22, ESM, pnpm; `pnpm build` (tsc) clean; no `any` escapes.

## Decisions to confirm (defaults in brackets, all reversible before code)

1. **One subscription per instance** [yes]. Paying for a new instance creates a `Subscription` in `PENDING_PAYMENT` that carries the intended instance `name` and `planId`; the instance row is created only when the first payment is verified (PRD 11.1: verified payment, then provision), using the existing provisioning path with idempotency key `pay-<merchantOrderId>`.
2. **Billing period is 30 days** [yes], not calendar months. Renewal while still active extends from `currentPeriodEnd`; renewal after expiry or suspension starts from the payment time.
3. **Grace and retention** per PRD 10.1: grace 3 days after `currentPeriodEnd` (instance keeps running), then suspension (instance stopped, volume kept), then 30 days of retention, then delete. Cancel sets `cancelAtPeriodEnd`; after the period it follows the same expiry, grace, suspension path (PRD 10.4).
4. **Reminders** [7, 3 and 1 days before `currentPeriodEnd`; on grace start; 1 day before suspension; on suspension; 7 days before deletion]. Each kind is sent once per period (unique row in `BillingNotice`). Plus one receipt email per verified payment.
5. **Duitku channels** [VA and QRIS only], chosen on the hosted POP page, not by this backend.
6. **Plan prices** [set by a sandbox seed script with a marked test price, for example Rp 10.000; production prices come from the owner later]. Needs the owner's number for the sandbox seed.
7. **Return URL** [`<DASHBOARD_ORIGIN>/dashboard/instances?payment=<merchantOrderId>`]. The dashboard billing screens stay mock until a later frontend task; D is backend only.
8. **Callback IP allowlist** [deferred]. The backend sits behind Caddy (sees loopback), the sender list must be copied from the live Duitku docs (not reachable from the cloud sandbox), and the signature is the real control. Recorded as a known gap.

## Env variables (names, to confirm against Nash's local `.env`)

`DUITKU_MERCHANT_CODE`, `DUITKU_API_KEY`, `DUITKU_ENV` (`sandbox` | `production`, default `sandbox`), `DUITKU_CALLBACK_URL` (full public URL, `https://api.cloud.nibie.app/api/v1/billing/duitku/callback`). All Duitku variables set together or none (billing off: checkout and callback answer 404/503, nothing else changes). `DUITKU_ENV=production` additionally refuses to start unless `NODE_ENV=production`. The mail block already exists (`SUMOPOD_SMTP_*`, `MAIL_FROM`); billing emails are skipped with a logged warning when mail is not configured, never an error that blocks a payment.

## Review Focus

1. A forged or tampered callback (wrong signature, changed amount, other order's signature) never activates anything; a valid signature with a wrong amount is recorded and ignored.
2. Same callback delivered twice, or concurrently, activates once: one instance, one period extension, one receipt email.
3. Callback for an unknown `merchantOrderId` with a valid signature answers `200` (so Duitku stops retrying) after recording it; an invalid signature answers `400` and records nothing about the claimed order.
4. Any resultCode other than `00` marks the payment failed (not paid). Both `01` and `02` are treated the same, which sidesteps the contradiction in Duitku's docs.
5. A tenant can only see and pay its own subscriptions (cross-tenant `404` for every new route).
6. The billing tick never touches an instance that has an operation in flight (it uses the existing commands, which already 409 on conflict) and is safe to run on two replicas (Redis lock, plus compare-and-set on `Subscription.status`).
7. Suspension stops the instance and customer `start` answers `409 subscription_suspended`; the reconciler does not restart it; a verified renewal restarts it.
8. No secret or form body appears in logs; the callback route is the only public route added to the Caddy allowlist besides customer routes.

---

## File structure

- Modify `prisma/schema.prisma` + new migration `add_billing`: `Plan.monthlyPriceIdr`, `Subscription`, `Payment`, `PaymentEvent`, `BillingNotice`.
- Create `src/modules/billing/duitku-client.ts`: `createInvoice`, `verifyCallbackSignature`, request signing, timestamp.
- Create `src/modules/billing/lifecycle.ts`: pure functions (`computeNextState`, `periodAfterPayment`, which notices are due) with an injected clock.
- Create `src/modules/billing/billing-service.ts`: checkout, renewal, cancel, `applyVerifiedPayment`, `recordFailedPayment`.
- Create `src/modules/billing/billing-tick.ts`: reminders, grace, suspension, retention deletion.
- Create `src/modules/billing/mailer.ts` and `src/modules/billing/email-templates.ts`: SMTP + Indonesian templates.
- Create `src/http/billing-routes.ts` (customer routes, inside the customer plugin) and `src/http/duitku-callback.ts` (public plugin).
- Modify `src/config/env.ts`, `src/http/server.ts`, `src/http/customer-routes.ts` (start guard), `src/main.ts`, `src/modules/jobs/scheduler.ts` (billing tick), `deploy/Caddyfile`, `.env.example`, `deploy/backend.env.example` (if tracked), `scripts/demo.ts` or a new `scripts/seed-sandbox-plans.ts`.
- Create tests listed per task; `test/validation/duitku-sandbox-live.ts` (manual harness).
- Docs: `docs/setup.md`, `docs/architecture.md`, `docs/CURRENT_STATE.md`, `AGENTS.md`, `deploy/README.md`.

---

### Task 0: Verify Duitku facts against the sandbox (spike, no production code)

The Duitku docs are not reachable from the cloud sandbox (proxy returns 403), so this task runs on the owner's machine or the VPS, using the owner's sandbox credentials from the environment (never printed).

- [ ] **Step 1:** Write `test/validation/duitku-sandbox-live.ts` (manual harness, not part of `pnpm test`): reads `DUITKU_MERCHANT_CODE`, `DUITKU_API_KEY` from the environment, creates one sandbox invoice for Rp 10.000 and prints only `statusCode`, `reference` and `paymentUrl`.
- [ ] **Step 2:** Record in the plan's ledger what the real response shows: exact field names, whether `x-duitku-timestamp` in UNIX milliseconds is accepted, error body shape for a wrong signature and for amount below the minimum, `expiryPeriod` units.
- [ ] **Step 3:** Pay the sandbox invoice (VA demo page or QRIS simulator, see the Duitku guide) against a temporary public callback (the VPS after Task 8, or a tunnel), and record the callback's exact form fields and which `resultCode` a failed or expired payment sends.
- [ ] **Step 4:** Check whether a signed status-check endpoint works for a POP invoice. If it does, Task 6 adds a reconciliation call for payments stuck `PENDING` past their expiry; if not, expiry is decided by local time only and the gap is documented.
- [ ] **Step 5:** Adjust Tasks 2 to 6 to what the ledger says before relying on them.

### Task 1: Config, dependencies, schema

**Files:** `package.json`, `pnpm-lock.yaml`, `src/config/env.ts`, `prisma/schema.prisma`, new migration, `.env.example`; Test: `test/unit/config.test.ts`

- [ ] **Step 1: Write failing config tests:** Duitku variables all-or-none; `DUITKU_ENV` defaults to `sandbox` and rejects other values; `DUITKU_CALLBACK_URL` must be `https`; `production` Duitku env requires `NODE_ENV=production`; errors name the variable and never echo the value; `Config.billing` is `null` when unset.
- [ ] **Step 2:** Implement in `env.ts`; add `billing: { merchantCode, apiKey, env, callbackUrl } | null` to `Config` and update every `Config` literal (`scripts/demo.ts`, `test/helpers/*`, `test/integration/api.test.ts`).
- [ ] **Step 3:** Install `nodemailer`, `@types/nodemailer`, `@fastify/formbody`; read the installed typings and write down the transport options used (port 465 uses `secure: true`, other ports STARTTLS).
- [ ] **Step 4: Schema.** `Plan.monthlyPriceIdr Int?`. `Subscription` (id, tenantId, planId, instanceId unique nullable, intendedName, status enum `PENDING_PAYMENT | ACTIVE | GRACE | SUSPENDED | ENDED`, currentPeriodEnd, cancelAtPeriodEnd, graceEndsAt, suspendedAt, retentionEndsAt, timestamps; index on `status` and `currentPeriodEnd`). `Payment` (id, subscriptionId, merchantOrderId unique max 50, amountIdr, purpose `NEW | RENEWAL`, status `PENDING | PAID | FAILED | EXPIRED`, reference, paymentUrl, resultCode, expiresAt, paidAt, periodStart, periodEnd). `PaymentEvent` (id, merchantOrderId, reference, resultCode, amountIdr, outcome text, createdAt; unique on `(merchantOrderId, reference, resultCode)`; no signature, no raw body). `BillingNotice` (subscriptionId, kind, periodEnd, sentAt; unique on `(subscriptionId, kind, periodEnd)`). All `onDelete: Restrict`.
- [ ] **Step 5:** `pnpm db:migrate`, `pnpm build`, existing tests still green.
- [ ] **Step 6: Commit** `feat(billing): config and schema` (only after the owner allows commits).

### Task 2: Duitku client (unit-tested, fake HTTP)

**Files:** Create `src/modules/billing/duitku-client.ts`; Test: `test/unit/duitku-client.test.ts`

- [ ] **Step 1: Failing tests:** request signature equals `HMAC-SHA256(merchantCode + timestamp, apiKey)` lowercase hex for a fixed vector; headers present; endpoint chosen from `DUITKU_ENV`; `merchantOrderId` over 50 chars, amount below 10.000 or non-integer are rejected before any request; non-`00` `statusCode` becomes a typed error with a sanitized message; network failure and timeout (10 s) become `PaymentProviderUnavailableError`; the API key never appears in any error message.
- [ ] **Step 2:** `verifyCallbackSignature({ merchantCode, amount, merchantOrderId, signature })` with `crypto.timingSafeEqual` on equal-length buffers (length mismatch returns false). Tests: valid, tampered amount, tampered order id, wrong length, empty, uppercase hex.
- [ ] **Step 3:** Implement `DuitkuClient` over built-in `fetch` using `safeFetch`-style rules where they fit (https only, no redirects). The base URL is fixed per environment, never user supplied.
- [ ] **Step 4:** Run unit tests; commit `feat(billing): Duitku POP client`.

### Task 3: Lifecycle rules (pure functions)

**Files:** Create `src/modules/billing/lifecycle.ts`; Test: `test/unit/billing-lifecycle.test.ts`

- [ ] **Step 1: Failing tests** with a fixed clock: first payment gives period `[now, now+30d]`; renewal before expiry gives `[end, end+30d]`; renewal after expiry or in grace or suspended gives `[now, now+30d]`; `ACTIVE` past `currentPeriodEnd` becomes `GRACE` with `graceEndsAt = end + 3d`; `GRACE` past `graceEndsAt` becomes `SUSPENDED` with `retentionEndsAt = suspendedAt + 30d`; retention elapsed means delete; `cancelAtPeriodEnd` follows the same path; which notices are due at a given instant (each kind exactly once, none twice); boundaries exactly on the instant.
- [ ] **Step 2:** Implement pure functions with an injected `now`, no I/O.
- [ ] **Step 3:** Run; commit `feat(billing): subscription lifecycle rules`.

### Task 4: Billing service (checkout, applying a payment)

**Files:** Create `src/modules/billing/billing-service.ts`; Test: `test/integration/billing-service.test.ts` (Postgres, fake `DuitkuClient`, fake runtime as in existing integration tests)

- [ ] **Step 1: Failing tests:**
  - checkout for a plan with a price creates `Subscription(PENDING_PAYMENT)` + `Payment(PENDING)` and returns `paymentUrl`; plan with `null` price answers `409 plan_not_for_sale`; name validation and `MAX_INSTANCES_PER_TENANT` apply at checkout; same `Idempotency-Key` returns the same payment (no second invoice); Duitku outage leaves no orphan paid state and answers `503`.
  - `applyVerifiedPayment` with `resultCode 00` and matching amount: payment `PAID`, first payment creates the instance through the normal provision path, later payments extend the period and restart a `SUSPENDED` instance; a second identical call changes nothing (assert row counts and a single receipt email).
  - wrong amount: `PaymentEvent.outcome = amount_mismatch`, payment still `PENDING`, no activation.
  - `resultCode` not `00`: payment `FAILED`, subscription unchanged; a `PAID` payment is never downgraded by a later failure callback.
  - unknown order id: event recorded, nothing else.
  - two concurrent identical callbacks (`Promise.all`): exactly one activation.
  - renewal creates a new `Payment` for the same subscription; cancel sets `cancelAtPeriodEnd` and refuses on `PENDING_PAYMENT`/`ENDED`.
- [ ] **Step 2:** Implement. Applying a payment is one transaction: insert `PaymentEvent` (unique violation means duplicate, stop), compare-and-set `Payment PENDING to PAID`, update `Subscription`, then after commit enqueue provision/start via `InstanceCommands` and send the receipt. A crash between commit and enqueue is covered by Task 6's sweep ("paid subscription without a running instance").
- [ ] **Step 3:** Run; commit `feat(billing): checkout and payment application`.

### Task 5: HTTP routes and the public callback

**Files:** Create `src/http/billing-routes.ts`, `src/http/duitku-callback.ts`; Modify `src/http/server.ts`, `src/http/customer-routes.ts`, `deploy/Caddyfile`; Test: `test/integration/billing-api.test.ts`

- [ ] **Step 1: Failing tests (customer routes, inside the customer plugin, token required):** `GET /subscriptions`, `GET /subscriptions/:id`, `POST /subscriptions/checkout` (`Idempotency-Key`, strict body `{ planId, name }`), `POST /subscriptions/:id/renew`, `POST /subscriptions/:id/cancel`, `GET /payments/:id`. Cross-tenant `404` on every id route; strict bodies; responses never contain `reference` internals beyond `paymentUrl`, status and dates; `POST /instances` and `start` answer `409 subscription_suspended` for a suspended subscription's instance; free beta path unchanged.
- [ ] **Step 2: Failing tests (callback, own plugin):** `POST /api/v1/billing/duitku/callback` form body; invalid signature `400`; valid signature unknown order `200`; replay `200` and no state change; tampered amount `200` with no activation; body above 16 KB rejected; not found (`404`) when billing is off; no `Authorization` header needed; request log line contains no body or signature.
- [ ] **Step 3:** Implement. Register `@fastify/formbody` only inside the callback plugin. Rate limit the callback per IP generously (Duitku retries) so abuse cannot hammer the database before signature checking; signature is checked before any database read.
- [ ] **Step 4:** Caddy: add `/api/v1/subscriptions`, `/api/v1/subscriptions/*`, `/api/v1/payments/*`, `/api/v1/billing/duitku/callback` to the `@public` matcher and keep the traversal rule; validate with `caddy validate`. `/api/v1/tenants/*` and `/api/v1/jobs/*` stay unforwarded (add a test that greps the Caddyfile).
- [ ] **Step 5:** Run; commit `feat(billing): customer billing routes and Duitku callback`.

### Task 6: Billing tick (reminders, grace, suspension, retention)

**Files:** Create `src/modules/billing/billing-tick.ts`; Modify `src/modules/jobs/scheduler.ts`, `src/main.ts`; Test: `test/integration/billing-tick.test.ts` (injected clock, fake mailer, fake runtime)

- [ ] **Step 1: Failing tests** stepping the clock: reminders at 7/3/1 days sent once each even if the tick runs many times; a renewal payment resets which notices are due; `ACTIVE` to `GRACE` at expiry with an email; `GRACE` to `SUSPENDED` stops the instance (volume kept) with an email; suspended instance is not restarted by the reconciler; `SUSPENDED` past retention deletes the instance through the normal delete path, ends the subscription, sends the final notice, and records an `InstanceEvent`; `cancelAtPeriodEnd` subscriptions get no renewal reminders; an instance with an operation in flight is skipped and retried on the next tick; two ticks run concurrently change each subscription once; mail disabled means transitions still happen and a warning is logged; mail failure does not roll back a transition and the notice is retried next tick (`BillingNotice` written only after a successful send).
- [ ] **Step 2:** Sweep for repair: paid subscription whose instance was never created or is `STOPPED` by suspension but now paid (crash after commit in Task 4); `PENDING` payments past `expiresAt` become `EXPIRED` (and, if Task 0 confirmed it, are checked once with the status endpoint first). `PENDING_PAYMENT` subscriptions with no paid payment older than 7 days are removed.
- [ ] **Step 3:** Implement and register as a repeatable job (hourly) under the existing maintenance lock, plus the in-process fallback timer when Redis is down, like the reconciler.
- [ ] **Step 4:** Run; commit `feat(billing): lifecycle tick and reminders`.

### Task 7: Mailer and templates

**Files:** Create `src/modules/billing/mailer.ts`, `src/modules/billing/email-templates.ts`; Test: `test/unit/mailer.test.ts`, `test/unit/email-templates.test.ts`

- [ ] **Step 1: Failing tests:** `Mailer` interface with `send({ to, subject, text, html })`; `createMailer(config.mail)` returns a no-op logger-warning mailer when mail is unset; the SMTP mailer builds the nodemailer transport from config (port 465 secure) using an injected transport factory so no network is touched; templates (Indonesian, plain text + simple HTML in the NibieCloud style used by the Supabase auth emails) for: payment received, renewal due (7/3/1 days), grace started, suspension warning, suspended, deletion warning, deleted; every template HTML-escapes the instance name; none contains the API key, `reference` or payment internals except the `paymentUrl` link where a payment action is requested; subject lines never include the instance name unescaped.
- [ ] **Step 2:** Implement; recipient is the tenant owner's `User.email`.
- [ ] **Step 3:** One manual smoke send to the owner's own mailbox through SumoPod from the VPS (Task 9), checking spam placement; the sandbox cannot reach SumoPod.
- [ ] **Step 4:** Run; commit `feat(billing): SMTP mailer and Indonesian templates`.

### Task 8: Sandbox seed, docs, and deployment steps

**Files:** Create `scripts/seed-sandbox-plans.ts`; Modify `docs/setup.md`, `docs/architecture.md`, `docs/CURRENT_STATE.md`, `AGENTS.md`, `deploy/README.md`, `.env.example`

- [ ] **Step 1:** Seed script sets a test `monthlyPriceIdr` on one existing plan, refuses to run when `DUITKU_ENV=production` or `NODE_ENV=production`, and prints what it changed.
- [ ] **Step 2:** Document env variables, the callback URL, the Caddy change, how to run the sandbox harness, how to pay a test invoice, and the known gaps (no IP allowlist, no proration or upgrades, no refunds, no AI usage billing, no recurring charge, no invoices/tax receipts).
- [ ] **Step 3:** Update `docs/CURRENT_STATE.md` and `AGENTS.md` (billing paragraph in the architecture section, new env names).
- [ ] **Step 4:** Deployment checklist for the owner (numbered, click-by-click, secrets never pasted in chat): add the four Duitku variables to the VPS env file, rebuild, apply the migration, reload Caddy, seed sandbox plan, run the sandbox harness.

### Task 9: Verification before completion

- [ ] **Step 1:** `pnpm build`, `pnpm test:unit`, `pnpm test:integration` (needs Docker, Postgres, Redis; if the cloud sandbox cannot run them, say so and have them run where they can) and report real counts.
- [ ] **Step 2:** Sandbox end-to-end on the VPS with the owner's sandbox credentials: checkout, pay with a VA simulator and with QRIS, callback received, instance reaches `ACTIVE`, replay from the Duitku dashboard changes nothing, a deliberately wrong-signature `curl` is rejected, an expired invoice becomes `EXPIRED`, a reminder email lands in the owner's mailbox.
- [ ] **Step 3:** Review pass (superpowers:verification-before-completion + code review) over the Review Focus list; fix findings.
- [ ] **Step 4:** Open the PR (no commit or push before the owner says so); production Duitku keys and prices stay out until the merchant account is verified.

## Not in D (recorded, not forgotten)

Plan upgrades and proration (PRD 5.5), refunds (Duitku has none), AI usage billing, tax invoices, Duitku callback IP allowlist, a real billing UI in `apps/web` (still mock), invoice reconciliation report for operators (PRD 17), production go-live (waiting on Duitku merchant verification).

## As built: differences from the plan text (2026-11-14)

1. **No rate limit on the callback route.** Behind Caddy every caller shares one address, so an IP limit would let an attacker lock Duitku out. The signature is checked first; a forged request costs one HMAC. The body cap (16 KB here, 64 KB in Caddy) stays.
2. **`Subscription.restartPending`** was added: set when a verified payment reinstates a suspended subscription, cleared once the instance was started. It lets the tick repair a crash between the payment commit and the restart.
3. **Deleting the instance ends the subscription** (`endForInstance`, no refund), so no reminder or suspension follows a deleted instance. The tick also ends a subscription whose instance was deleted elsewhere.
4. **Checkout idempotency lives on `Subscription`** (`@@unique([tenantId, idempotencyKey])`), not on `Payment`. A renew has no key: a still-payable open renewal invoice is returned instead of a second one.
5. **Notices are claimed before they are sent** (insert the `BillingNotice` row, send, delete the row if sending failed), so two replicas cannot both send. A crash between claim and send loses that one email; the alternative would be a duplicate.
6. **The tick is throttled in process** (at most once per 5 minutes) and rides on the existing locked maintenance job, or on its own 60 s timer without Redis. Abandoned purchases are set to `ENDED` (kept for audit), not deleted.
7. **`DASHBOARD_ORIGIN` is required when billing is configured** (the invoice's return URL is built from it).
8. **Task 0 is a harness only** (`test/validation/duitku-sandbox-live.ts`); it was not run because Duitku is unreachable from the cloud sandbox.
