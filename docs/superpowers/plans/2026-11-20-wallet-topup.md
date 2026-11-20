# Plan: Nibie Cloud wallet (top-up saldo)

## Context

Customers can only pay per invoice (SumoPod QRIS) for hosting, and AI credit only arrives once via
`Plan.includedCreditNano`. Tenant router users are synthetic (`t-<tenantId>@…`, password never kept), so customers
cannot use NibieRouter's own top-up: Nibie Cloud must sell it. Owner decisions (2026-11-20):

- A **Nibie Cloud wallet in IDR** per tenant, topped up by **custom amount**, Rp 10.000 to Rp 2.000.000, whole rupiah.
- Wallet pays **hosting (checkout + renew)**, **auto-renews** subscriptions, and **buys AI credit** (wallet IDR to
  NibieRouter credit, one way).
- IDR-per-US$ rate for AI credit lives **in the database**, edited by admins (reason + audit).
- Dashboard shows the **live NibieRouter AI balance** next to the wallet.
- **Admin adjust** (credit/debit) with reason + audit. Balance is **non-refundable**, no withdrawals.

Not a duplicate of NibieRouter: wallet (IDR, here) and AI credit (nano-USD, router) are two balances; money only
moves wallet → router.

Reference model (owner-supplied): SumoPod's own [Top Up Billing](https://docs.sumopod.com/guides/billing/topup-billing)
and [Top Up AI Balance](https://docs.sumopod.com/guides/ai/top-up-ai-balance). Same two-balance shape: an IDR credit that
pays every service, a separate USD AI balance funded only from that credit, "not real money, cannot be refunded or
withdrawn". Adopted from it:
- Top-up dialog: **preset chips** (Rp 25.000 / 50.000 / 100.000 / 250.000) **plus a custom amount**.
- AI top-up dialog: customer enters **US$** (presets $5 / $10 / $25 / $50), dialog shows both balances, the rate and the
  IDR cost (`ceil(usd × rate)`), "Saldo tidak cukup" when short, Turnstile check before confirm (when configured),
  terms + refund policy line on the dialog.
- Receipts: every top-up, hosting payment and AI purchase listed in a **Payments/Riwayat** tab on Billing.
- Wording: "Saldo Nibie Cloud bukan uang tunai dan tidak dapat dikembalikan atau ditarik."
Not adopted: voucher redeem (later), VA/e-wallet/card (our Managed Payment integration is QRIS only).

Ship as **3 PRs**, each usable alone, each with its own docs update.
**Owner decision (2026-11-20): build PR 1 now** on a new branch, behind `WALLET_ENABLED=off`. PR 2 and PR 3 stay planned
(saved under `docs/superpowers/plans/2026-11-20-wallet-topup.md` as part of PR 1) and are built after PR 1 has handled real
top-ups. The owner runs the real Rp 25.000 payment test before `WALLET_ENABLED` is turned on.

---

## PR 1: wallet, top-up, ledger, admin adjust

### Schema (`prisma/schema.prisma` + one migration)
- `Wallet { tenantId @id, balanceIdr Int @default(0), updatedAt }`, migration adds `CHECK ("balanceIdr" >= 0)`.
- **Cap** `WALLET_MAX_IDR = 5_000_000` (owner decision). Checked at top-up start (balance + open top-ups + amount,
  under the tenant advisory lock) and on admin credit → `409 wallet_limit`. Not in the DB CHECK: a verified paid top-up
  is always credited in full, so money is never lost (e.g. an expired invoice paid late).
- `WalletEntry { id, tenantId, amountIdr Int (signed), kind WalletEntryKind, refId String, balanceAfterIdr Int,
  note String?, actorEmail String?, createdAt; @@unique([kind, refId]); @@index([tenantId, createdAt]) }`.
  `enum WalletEntryKind { TOPUP, HOSTING, AUTO_RENEW, AI_CREDIT, ADMIN_CREDIT, ADMIN_DEBIT }`.
  The unique `(kind, refId)` is the exactly-once guard for every movement.
- `WalletTopup { id, tenantId, merchantOrderId @unique, amountIdr, status PaymentStatus, idempotencyKey,
  reference?, paymentUrl?, resultCode?, expiresAt, paidAt?, createdAt, updatedAt; @@unique([tenantId, idempotencyKey]) }`.
  Separate from `Payment` so `Payment.subscriptionId` stays required and nothing that reads payments changes.
- RLS on new tables like the other tenant tables (check how `WaitlistEntry` migration does it).

### Backend
- New `src/modules/billing/wallet.ts`: `WalletService`
  - `move(tx, { tenantId, amountIdr, kind, refId, note?, actorEmail? })`: upsert `Wallet`, `SELECT … FOR UPDATE`, refuse
    a debit below 0 (`409 insufficient_balance`), write entry + new balance. P2002 on the entry = already applied.
  - `view(tenantId)`: balance + last 50 entries.
  - `startTopup({ tenantId, email, amountIdr, idempotencyKey })`: zod-checked limits, reuse
    `paymentClient.createInvoice` (`productDetails: 'Nibie Cloud top-up saldo'`, `returnUrl: …/dashboard/billing?topup=<order>`,
    60 min), same idempotency/FAILED-on-error pattern as `BillingService.issueInvoice`. Order id prefix `nw-`.
- `BillingService.applyInTransaction` (`billing-service.ts:301`): when no `Payment` matches the order, look up
  `WalletTopup`; amount check; mark PAID (never downgrade); `wallet.move(kind TOPUP, refId topup.id)`; new outcome
  `topped_up`. Failure path mirrors payments. `PaymentEvent` dedupe unchanged.
- Receipt email: new kind `topup_received` in `email-templates.ts` (Indonesian, plain text like PR #85).
- `BillingTick.runOnce`: also expire `WalletTopup` PENDING past `expiresAt`.
- Routes in `billing-routes.ts` (customer plugin, same `gate`, rate-limited like checkout):
  `GET /wallet`, `POST /wallet/topups` (Idempotency-Key), `GET /wallet/topups/:id`.
- Admin (`admin-routes.ts`, aal2, reason, `audit.record` in the same tx like `/plans/:planId/stock`):
  `GET /customers/:tenantId/wallet`, `POST /customers/:tenantId/wallet/adjust { amountIdr (±, ≤ 2.000.000), reason }`
  → `ADMIN_CREDIT`/`ADMIN_DEBIT`, refId = new uuid. Add both to the MCP tool list (`admin-mcp.ts`).
- Admin overview / customer detail: show wallet balance.

### Dashboard (`apps/web`)
- `lib/api/types.ts` + `client.ts` + `customer` client + `mock.ts` + `live.ts`: `wallet()`, `topup(amount, key)`.
- `hooks/use-hermes.ts`: `useWallet`, `useTopup`.
- Billing page (`billing-view.tsx`): wallet card (balance, "Top up" dialog with amount `Input`, min/max hint,
  non-refundable notice, then `startPayment(url)`), ledger table. `?topup=` return shows a pending/paid toast.
- Header balance chip (CURRENT_STATE says none today): add one, links to `/billing`.
- Admin customer detail: wallet card + adjust dialog (reason ≥ 3 chars, like stock dialog).
- i18n strings in `lib/i18n-id.ts`. shadcn components only, `DESIGN.md` tokens.

### Landing
- Terms page: one line that saldo is non-refundable and not withdrawable (owner to approve wording).

---

## PR 2: pay hosting from wallet + auto-renew

- Extract the "money arrived" block of `applyInTransaction` (`billing-service.ts:328-348`) into
  `private activatePaid(tx, payment)` so webhook and wallet share one path.
- `checkout`/`renew` accept `payWith: 'qris' | 'wallet'` (default `qris`). Wallet: inside the existing tx, create the
  `Payment` (order `nw-…`, `status PAID`, `paidAt now`, `reference 'wallet'`), `wallet.move(HOSTING, refId payment.id, -price)`,
  `activatePaid`, then the same `afterActivation` post-actions. Capacity/stock locks unchanged.
- Schema: `Subscription.autoRenew Boolean @default(true)` (owner decision: toggle, default on);
  `Payment.method PaymentMethod @default(QRIS)` with `enum PaymentMethod { QRIS, WALLET }`.
  Route `POST /subscriptions/:id/auto-renew { enabled }`; switch on the instance Billing tab.
- Auto-renew in `BillingTick.processOne`: before `nextTransition`, if `autoRenew`, status `ACTIVE|GRACE`, not
  `cancelAtPeriodEnd`, `currentPeriodEnd − now ≤ 1 day`, plan priced, and balance ≥ price → wallet renew with
  `refId = autorenew:<subId>:<periodEnd ISO>` (exactly once per period). Insufficient balance: fall through to the
  normal reminder/grace flow; add a line to the reminder email "saldo kurang Rp X".
- Dashboard: deploy form + instance Billing tab get "Bayar pakai saldo" when balance ≥ price; note that the wallet
  renews automatically unless cancelled.

---

## PR 3: buy AI credit + rate admin + live router balance

Built 2026-11-20 with one change (owner: "buying AI credit from saldo in Rupiah"): the customer enters **Rupiah**
(`POST /ai/credit { amountIdr }`, Rp 10.000 to 1.000.000, presets Rp 20.000 / 50.000 / 100.000 / 200.000), not US$. The rate,
the balance and the admin route came with PR B. See `docs/CURRENT_STATE.md`.

- Schema: `BillingSetting { id 'default' @id, aiCreditIdrPerUsd Int? }` (null = buying AI credit is off).
  `CreditGrant.subscriptionId` → nullable, add `walletEntryRef String? @unique`.
- `RouterProvisioner`: split `ensureCredit` into a generic exactly-once `applyGrant(userId, row)` (same
  attempts/`hasCreditNote` logic); `runPending` also retries PENDING grants that have a `walletEntryRef`.
- `POST /wallet/ai-credit { amountUsd }` (whole US$ 1 to 100; Turnstile token required when `TURNSTILE_SECRET_KEY` is set):
  `costIdr = ceil(amountUsd × rate)`; tx: `wallet.move(AI_CREDIT, -costIdr)` + `CreditGrant`
  (`amountNano = amountUsd × 1e9`, note `nibie-cloud wallet <entryId>`), then `ensureUser` + `applyGrant`
  outside the tx. Router down: grant stays PENDING, tick retries, existing alert-scanner rule flags exhausted grants.
  No automatic refund (admin adjust).
- `NibieRouterClient.getBalance(userId)` → `GET /users/:id`, `balance_nano`. **Unverified shape**: verify with
  `test/validation/nibierouter-live.ts` before enabling. `GET /wallet` returns `aiCreditUsd: number | null` (null when the
  router is off, the tenant has no router user, or the call fails; short cache).
- Admin: `POST /settings/ai-credit-rate { idrPerUsd | null, reason }` + Pengaturan page field + MCP tool.
- Dashboard: "Top up saldo AI" dialog as in the reference model above; AI balance on the wallet card.

---

## Critical files
`prisma/schema.prisma`, `src/modules/billing/{billing-service,billing-tick,email-templates}.ts`, new
`src/modules/billing/wallet.ts`, `src/http/{billing-routes,admin-routes,admin-mcp}.ts`, `src/main.ts` (wiring),
`src/modules/nibierouter/{router-provisioner,nibierouter-client}.ts` (PR 3), `apps/web/src/lib/api/*`,
`apps/web/src/hooks/use-hermes.ts`, `apps/web/src/app/(app)/billing/billing-view.tsx`, admin customer detail,
`docs/{CURRENT_STATE,architecture,setup}.md`, `AGENTS.md` billing bullet, `docs/feature-spec.md`.

## Security notes
- Amount and price are always server-side; client sends only `amountIdr` for top-up/AI credit, validated by zod.
- Balance can never go negative (row lock + DB CHECK). Every movement has a unique `(kind, refId)`.
- Webhook auth unchanged (Svix / token before DB). Amount mismatch never credits.
- Admin adjust: aal2, reason, audit row in the same transaction, debit cannot overdraw.
- No real-money payment is verified yet (Known gaps 9a): the wallet inherits that gap.

## Blockers and gaps (review 2026-11-20)

Blockers for going live (not for building):
1. **Real Rp 25.000 payment test not done yet.** Production already runs SumoPod Managed Payment (`SUMOPOD_ENV=production`,
   keys installed, webhook verified: `docs/CURRENT_STATE.md:406`, `:704-705`; the "no KYC" line at `:765` is stale).
   That test proves the same invoice + webhook path top-up uses: do it before turning `WALLET_ENABLED` on.
2. **Regulation, owner to check (not legal advice):** a stored IDR balance can count as closed-loop e-money under Bank
   Indonesia rules; as far as known, a licence is needed above a total float of about Rp 1 miliar. Also check that
   SumoPod's merchant terms allow deposit/top-up, and how PPN applies (at top-up or at use). The terms page must say
   non-refundable, and that balance is forfeited when the account is deleted.
3. **PR 3 only:** NibieRouter `GET /users/:id` balance shape is unverified. Check it read-only first (live harness or the
   router admin `get_user`, with the owner's OK).

Gaps fixed in the plan:
- **Max balance per tenant**: Rp 5.000.000 (decided). Bounds risk, the e-money float, and `Int` overflow.
- **Auto-renew consent**: per-subscription toggle, default on (decided), stated on the top-up dialog and terms.
- `Payment.method` column (`QRIS | WALLET`, default `QRIS`) so admin payment lists tell them apart (PR 2).
- Auto-renew vs. an open QRIS renewal invoice: auto-renew marks open `RENEWAL` invoices of that subscription
  `EXPIRED` in the same tx (a later paid one is still honored, extends 30 days, never lost).
- Renewal reminder emails (`renewal_7d/3d/1d`): when auto-renew is on and saldo covers the price, say "akan
  diperpanjang otomatis dari saldo"; when short, say how much to top up (PR 2).
- `alert-scanner.ts:157` credit-grant alert uses `subscriptionId`: handle null and key by grant id (PR 3).
- New tables `ENABLE ROW LEVEL SECURITY` in the migration, like `BetaInvite`.
- Wallet checkout/renew run `afterActivation` after the response (`setImmediate`), like the webhook.

## Risk by PR and mitigations

| PR | Risk | Main failure | Mitigation |
| --- | --- | --- | --- |
| 1 Wallet + top-up | Medium | Double or wrong-tenant credit in the webhook | New branch only when no `Payment` matches (QRIS path untouched); tenant from the `WalletTopup` row, never the body; `PaymentEvent` + `(TOPUP, topupId)` unique + PAID compare-and-set; additive migration |
| 2 Pay + auto-renew | **High** | Shared activation refactor breaks paying customers; tick charges wrongly every 5 min | Refactor covered by the existing webhook/billing integration tests first; at most one charge per subscription per period (`autorenew:<sub>:<periodEnd>` unique); env `WALLET_AUTO_RENEW=off` default until sandbox-verified |
| 3 AI credit | Medium-high | Router has no idempotency: debit without credit, or double credit | Same proven `CreditGrant` exactly-once path; PENDING retried; alert on exhausted; rate range-checked (e.g. Rp 5.000 to 50.000 per US$) and audited |

Extra guard for all PRs: env `WALLET_ENABLED` (default off; routes 404, UI hidden), and an `alert-scanner` rule that
flags any tenant whose `Wallet.balanceIdr` differs from the sum of its `WalletEntry` rows.

## Verification
- Unit: wallet `move` math and limits, AI credit nano conversion, `topup_received` email render.
- Integration (`hermes_test`, serial): extend `sumopod-webhook.test.ts` (top-up paid / duplicate / amount mismatch /
  failed), new `wallet.test.ts` (concurrent debits never overdraw, idempotent top-up key), `billing-tick.test.ts`
  (top-up expiry; PR 2 auto-renew once per period, skip when short), `billing-api.test.ts` (wallet routes, pay-with-wallet),
  `router-provisioner.test.ts` (PR 3 grant retry), admin adjust audit test.
- `pnpm build && pnpm test:unit && pnpm test:integration`; `apps/web`: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
- Manual in mock mode (dashboard at `localhost:3100/dashboard/billing`), then SumoPod sandbox top-up end to end.
