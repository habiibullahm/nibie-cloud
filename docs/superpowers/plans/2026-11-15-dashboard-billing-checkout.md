# Nibie Cloud: dashboard billing, checkout and NibieRouter credit — plan

Date: 2026-11-15. Status: **revised after the owner's answers of 2026-11-15, draft for approval, no feature code written.**
Scope: part A is `apps/web`; part B is a new backend milestone E (NibieRouter credit and key). Backend milestone D (PR #22, merged) already provides the billing endpoints.

## Owner decisions so far (2026-11-15)

1. Dashboard stays English for now. 2. Plan rows carry the **beta** price (Rp 25.000 and Rp 50.000) for the first 100 users.
3. The US$2 NibieRouter credit is built together with billing (part B). 4. The product is renamed **Nibie Cloud**
(done in this change set: landing, dashboard, legal pages, backend emails and Telegram test message, DESIGN.md, READMEs;
"Hermes" stays as the name of the agent). Package names, the repository and Docker/compose names are unchanged on purpose.
5. Reference screenshot from the owner (another host's suspended instance): banner with deletion date and a Renew button,
plan and price in the page header, an Upgrade & Renew tab. Used as inspiration only; the design follows `DESIGN.md`.

## Part A — dashboard

### Goal

A customer can pick a paid plan on Deploy, pay with Duitku (virtual account or QRIS), come back to the
dashboard and see the instance appear, then see and manage the subscription (renew, cancel) on the
instance Billing page. Prices shown come from the real plan rows, not from the mock.

## What the backend already gives (verified in `src/http/billing-routes.ts`, `billing-service.ts`)

All under `/api/v1`, customer token, only when the backend has the three `DUITKU_*` variables set.

| Call | Result |
| --- | --- |
| `GET /plans` | now includes `monthlyPriceIdr` (`null` means not for sale) |
| `POST /subscriptions/checkout` (`Idempotency-Key`, body `{ name, planId }`) | `201 { subscription, payment }`; `payment.paymentUrl` is the Duitku page while the invoice is payable (60 minutes) |
| `GET /subscriptions`, `GET /subscriptions/:id` | `SubscriptionView`: status `PENDING_PAYMENT`, `ACTIVE`, `GRACE`, `SUSPENDED`, `ENDED`, `instanceId` (null until the first payment), `currentPeriodEnd`, `cancelAtPeriodEnd`, `graceEndsAt`, `retentionEndsAt`, `latestPayment` |
| `POST /subscriptions/:id/renew` | `201 { subscription, payment }`, reuses an open invoice |
| `POST /subscriptions/:id/cancel` | sets non-renewal only |
| `GET /payments/:id` | `PaymentView`: `PENDING`, `PAID`, `FAILED`, `paymentUrl`, `expiresAt`, `paidAt` |

The Duitku return URL is `https://cloud.nibie.app/dashboard/instances?payment=<merchantOrderId>`. The instance is
created by the verified callback, not by the browser, so after returning the page must poll until the
subscription has an `instanceId`.

## Decisions (answered 2026-11-15, kept for the record)

1. **Language of the dashboard.** The landing page is Indonesian; the dashboard is English today. Plan: keep
   English for consistency with the rest of the dashboard, Indonesian copy later as one pass. Say if you want
   Indonesian for the new screens now.
2. **Plan choice on Deploy.** Plan: show the plans returned by `GET /plans` that have a price, as radio cards with
   the beta price and the struck normal price from the landing (`apps/landing/src/lib/plans.ts` values, copied,
   not imported). The backend has one price per plan row, so the beta discount must be the row's price. Confirm
   that sandbox and production rows will carry the **beta** price (Rp 25.000 and Rp 50.000) until the first 100
   users are in.
3. **The US$2 NibieRouter credit**: answered "integrate it now". Part B. The "Hosting + Kredit AI" plan goes on sale only
   when part B works end to end, so nobody pays for a credit we cannot grant.

## Changes

1. **API layer** (`apps/web/src/lib/api`): add types `SubscriptionView`, `PaymentView`, `CheckoutResult`; extend
   `HermesApi` with `checkout`, `listSubscriptions`, `getSubscription`, `renew`, `cancel`, `getPayment`;
   implement them in `customer.ts` (bearer token, `Idempotency-Key` on checkout and renew), and a small mock in
   `mock.ts` so mock mode and tests keep working. `Plan.monthlyPriceIdr` is already typed.
2. **Deploy** (`deploy-form.tsx`): when the chosen plan has a price, submit `checkout`, then
   `window.location.assign(payment.paymentUrl)`. A stable `Idempotency-Key` per form session so a double click
   returns the same invoice. Plans with `null` price keep the existing direct create (beta path). Errors by code:
   `plan_not_for_sale`, instance limit, `provisioning_not_enabled`.
3. **Return page** (`/instances?payment=...`): a banner "Waiting for your payment" that polls
   `GET /subscriptions` every 3 seconds (stop after 5 minutes), then shows success when a subscription has an
   `instanceId` and `ACTIVE`, failure when the latest payment is `FAILED` or expired, with a "Pay again" button
   (`renew` for existing, `checkout` for pending).
4. **Pending purchases on the instances list**: a subscription in `PENDING_PAYMENT` has no instance yet, so list
   it as a row "Awaiting payment" with "Pay now" (while `paymentUrl` is set) and expiry.
5. **Billing page** (`instances/[id]/billing`): replace the preview card with the real subscription: status label
   (also in text, not color only), renews on, grace and suspension dates with the plain consequences
   (instance keeps running during 3 days of grace; stopped when suspended; data kept 30 days), `Renew now`
   (opens Duitku), `Cancel renewal` (confirm dialog, only stops auto-renewal as the backend defines), and the latest payment.
   Remove the "Billing is not live yet" alert and the preview label when in customer mode.
6. **Suspended and grace state on the instance page** (from the owner's reference): a banner at the top of every instance
   page when the subscription is `GRACE` or `SUSPENDED`, showing the plain consequence and the dates (`graceEndsAt`;
   for suspended, the deletion date = `retentionEndsAt`), with one primary "Renew now" button (opens Duitku) and a link
   to Billing. The instance header shows plan, billing cycle and price, for example "Nibie Small, monthly, Rp 25.000".
   Banner uses an icon plus text (never color alone) and `DESIGN.md` status tokens, not a hard-coded red. The backend
   answers `409 subscription_suspended` on start; show that message with the same Renew button instead of the generic error.
   The reference has a separate "Upgrade & Renew" tab; here Renew lives on Billing, and upgrade is out of scope (the
   backend has no plan upgrade yet).
7. **Docs**: update `apps/web/README.md`, `docs/CURRENT_STATE.md`, and the docs page "Paket dan penagihan"
   (apps/docs) so it no longer says prices are unset.

Design rules: shadcn/ui components only, `DESIGN.md` tokens, terracotta only for the single primary pay button,
visible focus, status never by color alone, reduced motion respected.

## Tests (Vitest, `apps/web`)

- Customer API client: checkout sends the bearer token, the `Idempotency-Key`, and maps the response; renew and
  cancel call the right paths; backend error codes surface.
- Deploy: priced plan goes to checkout and redirects; unpriced plan keeps direct create; double submit reuses the key.
- Return polling: success, failure, timeout.
- Billing page: label and dates per status (`ACTIVE`, `GRACE`, `SUSPENDED`, `ENDED`, cancel scheduled).
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` and `cf:build` still pass.

## What this plan cannot prove

- A real payment. That needs the backend deployed with sandbox Duitku credentials, a sandbox price on a plan row
  (`scripts/seed-sandbox-plans.ts`), and the dashboard Worker built with `NEXT_PUBLIC_HERMES_API_MODE=customer`
  and the API URL. Those are owner/VPS steps listed in `docs/setup.md` and `deploy/README.md`; I will give them as
  numbered click-by-click steps when the code is ready.
- Duitku's real callback fields and failure code are still unconfirmed (open item in the PR #22 test plan).

## Order of work

API layer and mock, then Billing page, then Deploy and return flow, then list row and suspended message, then docs.
No commit or push until the owner asks.

## Part B — NibieRouter credit and key (backend milestone E)

Facts from the SumoRouter documentation (NibieRouter is a SumoRouter instance; docs read 2026-11-15, Indonesian source,
https://docs.sumorouter.com). Money is integer nano-USD (US$1 = 1,000,000,000). Admin endpoints need an admin API key
`sk-admin-...` (`Authorization: Bearer`), 120 requests per minute, optional IP allowlist, a human with 2FA must create
the first one in the NibieRouter dashboard.

| Need | Endpoint | Status in the docs |
| --- | --- | --- |
| Router user for a tenant | `POST /api/admin/users` `{ email, password (min 8), name, is_admin: false, balance_nano }` | documented |
| Grant US$2 once | `POST /api/admin/users/{id}/credit` `{ delta_nano: 2000000000, note }` returns `{ balance_nano }` | documented; **no idempotency**, a retry double-applies |
| Read balance | `GET /api/admin/users/{id}` (`user.balance_nano`), `GET /api/admin/users/{id}/balance-history` | documented |
| Create the instance's API key for that user | admin "Create an API key for a user" (likely `POST /api/admin/users/{id}/keys`) | listed in the sidebar, **body not documented**, must be tested live |
| Read key spend | `GET /api/admin/users/{id}/keys` (`usage_nano`, `credit_limit_nano`) | documented |

Credit is an **account balance** on the router user, not a per-key balance. So the model is: one router user per tenant,
the US$2 grant goes to that user, the instance gets one key (optionally with a spend cap) that spends that balance.

### Two sources compared (owner asked for https://router.nibie.app/ as extra context)

The public NibieRouter site (read 2026-11-15; its `/docs`, `/v1/models` and `/api/billing/config` are disallowed by its
`robots.txt`, so they were not read) agrees with the SumoRouter docs on the core and differs or adds as follows:

| Topic | SumoRouter docs | router.nibie.app | Effect on this plan |
| --- | --- | --- | --- |
| Money unit in the API | nano-USD, fields end in `_nano` | the site publishes no API field names | Keep nano-USD; the live check must confirm it on the real instance |
| Rate | `idr_per_usd` is a config value | "estimate" Rp18.200 per US$, not the live rate | US$2 is about Rp36.400 at that estimate: see the cost note below |
| Keys | customer self-service key with a credit limit and a model allow-list; admin "create key for a user" listed but undocumented | self-service only; no admin-created keys mentioned | Admin key creation stays the main unknown; fallback below |
| Credit | top-up by QRIS, coupons, admin grant | top-up by QRIS (minimum Rp10.000), coupon redeem once per account, no cash welcome credit | The admin `credit` grant is still the way to give US$2; a coupon is not usable for this (one per account, redeemed by the user) |
| Free models | not mentioned | six free models, shared capacity | Could be the default for Hosting-only; the default model is still the owner's choice |
| Insufficient balance | `insufficient_credits` in logs | HTTP 402 | Surface "AI credit used up" in the dashboard later |
| Endpoints | chat, responses, messages, embeddings, count_tokens, models, decisions | chat, responses, messages, embeddings listed | Hermes only needs chat completions |
| Admin API | documented (`sk-admin-...`) | not public | Documented only on the SumoRouter side: must be confirmed live |

**Fallback if admin key creation is not available or does not accept a spend cap:** sign in as the tenant's router user
(`POST /api/auth/login`, 7-day token) with a password we generate and keep encrypted, then `POST /api/keys` with
`credit_limit_nano`. That needs a stored per-tenant secret and is only built if the live check shows the admin path does not work.

**Cost note for the owner:** the "Hosting + Kredit AI" beta price is Rp 50.000 against Rp 25.000 for Hosting, so the credit is
paid for with Rp 25.000, while US$2 is about Rp 36.400 at the site's Rp 18.200 estimate (if the router sells at a markup,
its real cost to you is lower). Worth checking before the first 100 users.

### Design

1. **Data** (migration): `Plan.includedCreditNano` (nullable BigInt, `null` means none); `Tenant.routerUserId`; a ledger
   table `CreditGrant` (unique on `subscriptionId` + `kind`, status `PENDING` / `DONE` / `FAILED`, amount, router balance
   after) so the grant is exactly once on our side; `ProviderConfig` already stores the encrypted key (`attachNibieRouter`).
2. **Router client** (`src/modules/integrations/nibierouter-client.ts`): `safeFetch` to `https://router.nibie.app`, env
   `NIBIEROUTER_ADMIN_KEY` (VPS env only, never in the repository or logs), methods `createUser`, `grantCredit`, `getUser`,
   `balanceHistory`, `createKey`, `listKeys`. Money in `bigint` nano-USD.
3. **Flow** (a queued job, not inside the Duitku callback): after the first verified payment creates the instance, ensure the
   router user (synthetic address `t-<tenant uuid>@router.nibie.app`-style so the customer's real email is not shared; the
   customer never signs in to the router; the random password is not stored), grant credit if the plan has
   `includedCreditNano` and the ledger row is not `DONE`, create the key, attach it to the instance, bump `configRevision`.
4. **Exactly-once grant** despite no idempotency on the router: write the ledger row `PENDING` first; on retry, read
   `balance-history` for our `note` (it carries the subscription id) before posting again; only then mark `DONE`.
5. **Hosting-only plan**: still gets a router user and a key (NibieRouter is the default provider), but no credit grant.
6. **Failure handling**: a failed router call never blocks the payment or the instance; the instance stays on its
   configuration screen with "AI provider not ready", the job retries with backoff, and an operator can re-run it.
7. **Dashboard**: Configuration shows "NibieRouter" with credit balance (read through a customer endpoint that calls
   `GET /api/admin/users/{id}`, no key ever returned).

### Needs from the owner (numbered steps will be given when I reach this)

- An admin API key for the backend (created by you in the NibieRouter dashboard with 2FA, restricted to the VPS IP, kept in
  Bitwarden, set as `NIBIEROUTER_ADMIN_KEY` on the VPS). I never need to see it.
- One live check of the undocumented "create key for a user" call with a throwaway test user, run on the VPS by script.
- The default model id Hermes should use on NibieRouter (from `https://router.nibie.app/v1/models`).
- Whether the router user email may be a synthetic address (my proposal) and whether the Privacy policy should name
  NibieRouter as the AI gateway that receives prompts (it should; I will add it to the draft).

### What I cannot verify

Everything against the real router (key creation body, whether spend caps are accepted on admin-created keys, rate
limits) until the admin key exists. Unit and integration tests use a fake router that mimics the documented shapes.

## Order of work (both parts)

1. Rename (done), API layer and mock, Billing page, instance banner and header, Deploy and return flow, list row, docs.
2. Milestone E on the backend: migration, router client with fake, job, tests, docs; then the live check.
3. Seed the plan rows with beta prices and the credit amount; "Hosting + Kredit AI" goes on sale only after step 2 works live.
No commit or push until the owner asks.
