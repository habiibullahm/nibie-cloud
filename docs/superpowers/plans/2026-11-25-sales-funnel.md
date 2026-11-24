# Sales Funnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make paid plans easier to buy and keep: AI credit on every paid period, paid plans pinned to Jakarta, paid-to-paid plan changes with prorated charge, outcome-led landing copy, and an upsell notice on free instances.

**Architecture:** Backend changes stay inside `BillingService`, `NodeScheduler` and the existing `CreditGrant` delivery (`AiAccountService.retryPurchases`). Two additive, nullable migrations. Dashboard reuses the existing billing page, `PayButton` and `useActionConfirmation`. Landing and docs are copy-only.

**Tech Stack:** TypeScript (ESM), Fastify, Prisma + PostgreSQL, Vitest; Next.js 16 + shadcn/ui (`apps/web`, `apps/landing`); Fumadocs MDX (`apps/docs`).

**Spec:** Owner decisions of 2026-11-25 (this conversation):
- Scope: deploy landing+docs, outcome-led copy, paid-to-paid plan change, free-tier upsell + region.
- Plan change charge: prorated difference; the period end stays the same.
- Kredit plans: the plan's credit is granted on every paid period, not only the first.
- Region: paid plans run on Jakarta nodes only (`jkt-1`); `jkt-2` (Singapore) stays for the free beta.

## Global Constraints

- Branch per PR from `main`: `feat/*`, Conventional Commits, no direct commit to `main`, no deploy without the owner's explicit go.
- Migrations are additive and nullable; never edit an applied migration.
- Money: IDR as whole rupiah `Int`; router credit as nano-USD `BigInt` (US$1 = 1_000_000_000).
- `SUMOPOD_MIN_AMOUNT_IDR` = 1_000; `PERIOD_DAYS` = 30 (`src/modules/billing/lifecycle.ts`).
- Nothing under `src/http/*` imports `secrets/secret-store`.
- UI copy: no em dash (U+2014) or en dash (U+2013), no emoji, no buzzwords. Dashboard uses shadcn/ui primitives only and English source strings with Indonesian in `apps/web/src/lib/i18n-id.ts`.
- Public repo: no host addresses, contact emails or secrets in code, docs or commits.
- Update `docs/CURRENT_STATE.md` in every PR that changes behavior or status.
- Checks before each PR: backend `pnpm build && pnpm test:unit` (+ `pnpm test:integration` on Linux Docker/Postgres/Redis for billing tasks); `apps/web`: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`; `apps/landing`: same four; `apps/docs`: `pnpm typecheck && pnpm lint`; `git diff --check`.

## Review Focus

1. A renewal paid twice (QRIS after wallet) must grant the credit once: the second payment goes to the wallet and creates no `CreditGrant`. Test in Task 2.
2. A plan change invoice paid after a newer plan change or after the subscription ended must not change the plan: the money goes to the wallet. Test in Task 6.
3. A plan change requested while a renewal invoice is open must be refused (`renewal_open`), so a renewal priced on the old plan cannot buy a period of the new plan. Test in Task 5.
4. A free instance on a Singapore node asking to upgrade must get `region_not_for_paid`, not a generic capacity error. Test in Task 4.
5. Storage must never shrink through a plan change (the XFS quota cannot go below used data). Test in Task 5.

---

## PR 0: Record that landing and docs are live (`docs/landing-live-status`)

### Task 0: Correct CURRENT_STATE

Checked 2026-11-25: `https://cloud.nibie.app/harga` and `/docs/paket-dan-penagihan` already show four plans (Workers Builds from `main`, commit `b4735bf`). No deploy is needed.

**Files:**
- Modify: `docs/CURRENT_STATE.md:114` and `:125-126`

- [ ] **Step 1:** Change the heading suffix "landing and docs pending deploy" to "landing and docs live" and replace the "Not deployed yet" sentence with "Live through Workers Builds from `main` (checked 2026-11-25)."
- [ ] **Step 2:** `git diff --check`, commit `docs: mark four-plan landing and docs as live`.

---

## PR 1: AI credit on every paid period (`feat/plan-credit-every-period`)

### Task 1: Schema for payment-keyed credit grants

**Files:**
- Modify: `prisma/schema.prisma` (`CreditGrant`, `Plan.includedCreditNano` doc comment)
- Create: `prisma/migrations/20261125100000_credit_grant_payment/migration.sql`

**Interfaces:**
- Produces: `CreditGrant.paymentId String? @unique @db.Uuid`. Rows with `paymentId` set keep `subscriptionId` null, so `AiAccountService.retryPurchases` (filter `subscriptionId: null`) delivers them with no change.

- [ ] **Step 1:** Add the column, `@unique`, and a doc comment: "Set for the credit of a renewal or plan change payment; the first payment's credit stays keyed on `subscriptionId`." Change the `includedCreditNano` comment to "NibieRouter credit granted with every paid period".
- [ ] **Step 2:** `pnpm prisma migrate dev --name credit_grant_payment --create-only`; check the SQL is one `ALTER TABLE ... ADD COLUMN` plus one unique index. Rename the folder to the timestamp above.
- [ ] **Step 3:** `pnpm build` passes. Commit `feat(billing): key credit grants on payments`.

### Task 2: Grant the plan's credit on each paid renewal

**Files:**
- Modify: `src/modules/billing/billing-service.ts` (`activate`, around line 470)
- Test: `test/integration/billing-service.test.ts`

**Interfaces:**
- Consumes: `CreditGrant.paymentId` (Task 1).
- Produces: inside `activate(tx, payment, now)`, when `payment.purpose === 'RENEWAL'`, the subscription did not end, and `plan.includedCreditNano > 0n`: `tx.creditGrant.upsert({ where: { paymentId: payment.id }, create: { tenantId, paymentId, amountNano: plan.includedCreditNano, note: \`nibie-cloud credit payment ${payment.id}\` }, update: {} })`. Read `includedCreditNano` in the existing `sub` query (`include: { plan: { select: { name: true, includedCreditNano: true } } }`).

- [ ] **Step 1: Write failing tests**
  - `renewal of a Kredit plan creates one PENDING credit grant keyed on the payment`: pay a RENEWAL on `hosting-kredit`; expect one `CreditGrant` with `paymentId = payment.id`, `amountNano = 2_000_000_000n`, `subscriptionId = null`, `status = 'PENDING'`.
  - `renewal of a plan without credit creates no grant`: same on `hosting`; expect 0 rows with `paymentId`.
  - `wallet auto-renew of a Kredit plan grants the credit`: `autoRenew` path; expect one grant.
  - `renewal paid by wallet then by QRIS grants once`: expect 1 grant, webhook result `credited_to_wallet`.
  - `payment for an ended subscription grants nothing`: result `paid_after_end`, 0 grants.
- [ ] **Step 2:** `pnpm vitest run test/integration/billing-service.test.ts` fails on the new cases.
- [ ] **Step 3:** Implement the upsert above in `activate` after the `ENDED` return.
- [ ] **Step 4:** Same command passes; `pnpm test:integration` passes `billing-*`, `ai-credit-purchase`, `router-provisioner`.
- [ ] **Step 5:** Commit `feat(billing): grant the plan's AI credit on every paid period`.

Note for the code: delivery waits for the billing tick (`retryPurchases`, `RETRY_AFTER_MS` 2 minutes, tick every 5 minutes). Add `// shortcut: credit lands within about 7 minutes of a renewal, deliver inline if customers ask`.

### Task 3: Copy says "every month"

**Files (exact lines found 2026-11-25):**
- `apps/landing/src/components/site/pricing.tsx:17` and `:44`
- `apps/landing/src/components/site/faq.tsx:11`
- `apps/landing/src/app/syarat-layanan/page.tsx:52`
- `apps/docs/content/docs/(panduan)/index.mdx:51`, `paket-dan-penagihan.mdx:22`, `provider-ai.mdx:24`
- `apps/docs/content/docs/api-reference/akun-dan-paket.mdx:63`
- `apps/web/src/app/(app)/instances/[id]/billing/page.tsx:109`, `:294`; `apps/web/src/app/(app)/deploy/deploy-form.tsx:204`; matching keys in `apps/web/src/lib/i18n-id.ts` (e.g. `:248`)
- `docs/CURRENT_STATE.md` (new entry)

- [ ] **Step 1:** Pricing card row: `` `$${plan.creditUsd} setiap bulan` ``. Note paragraph: "Kredit $2 atau $3 diberikan setiap periode yang dibayar. Kredit yang tidak terpakai tetap di saldo AI. Di luar kredit itu, atau pada paket tanpa kredit, pemakaian AI ditagih terpisah oleh NibieRouter atau provider pilihanmu. Tidak ada janji pemakaian AI tanpa batas."
- [ ] **Step 2:** Same meaning in FAQ, terms, docs and API reference (`includedCreditUsd`: "Kredit NibieRouter dalam US$ yang diberikan bersama setiap pembayaran periode, atau `null` bila tidak ada."). Terms text is legal copy: flag it in the PR description for owner review.
- [ ] **Step 3:** Dashboard English sources: "Includes US${amount} AI credit with every paid period. More AI usage is paid from your AI balance or your own provider." and "Includes US${amount} AI credit every month, in NibieRouter"; Indonesian: "Termasuk kredit AI US${amount} setiap periode yang dibayar. ..." / "Termasuk kredit AI US${amount} setiap bulan, di NibieRouter".
- [ ] **Step 4:** `grep -rn "satu kali di awal\|sekali di awal\|one-time\|given once" apps/landing/src apps/docs/content apps/web/src` returns nothing about plan credit.
- [ ] **Step 5:** Run landing, docs and web checks (Global Constraints). Update `CURRENT_STATE.md`. Commit `docs(plans): AI credit is granted every paid period`.

---

## PR 2: Paid plans on Jakarta nodes only (`feat/paid-region-pin`)

### Task 4: Region filter in placement

**Files:**
- Modify: `src/config/env.ts` (new `PAID_NODE_REGIONS`), `src/modules/instances/node-scheduler.ts`, `src/modules/billing/billing-service.ts` (checkout `select` ~line 186, `upgrade` ~240, `applyPlanChange` ~657), `src/main.ts` (pass config), `deploy/` env example if one lists billing vars
- Test: `test/integration/multi-node-fleet.test.ts`, `test/integration/billing-upgrade.test.ts`

**Interfaces:**
- Produces: env `PAID_NODE_REGIONS` (comma list, e.g. `id-jakarta`; empty means any region) -> `config.paidNodeRegions: string[] | undefined`.
- Produces: `NodeScheduler.select(tx, demand, now, claim)` where `Reservation` gains `regions?: readonly string[]`; when set, candidates add `region: { in: regions }`.
- Produces: `BillingServiceDeps.paidNodeRegions?: readonly string[]`, passed as `regions` on every priced-plan `select`.
- Produces: `upgrade()` throws `new AppError('Paid plans run in Jakarta only', 409, 'region_not_for_paid')` when the instance's node region is not in `paidNodeRegions`, checked before `select`.

- [ ] **Step 1: Write failing tests**
  - multi-node-fleet: `select with regions skips nodes outside them`: two nodes `id-jakarta` and `sg-singapore`, Jakarta full; `select(..., { regions: ['id-jakarta'] })` rejects with `CapacityFullError`; without `regions` it returns the Singapore node.
  - billing-upgrade: `upgrade of a free instance on a Singapore node is refused`: expect status 409, code `region_not_for_paid`, no subscription created.
  - billing-service: `checkout with paidNodeRegions reserves a Jakarta node`: `reservedNodeId` is the Jakarta node when both have room.
- [ ] **Step 2:** Run those files; new cases fail.
- [ ] **Step 3:** Implement the interfaces above. Do not pass `regions` from `waitlist-inviter.ts` (free) or `node-recovery.ts` (operator moves stay unrestricted).
- [ ] **Step 4:** Tests pass; `pnpm build`, `pnpm test:unit`.
- [ ] **Step 5:** Dashboard: in `apps/web` map error code `region_not_for_paid` to "This instance runs in Singapore. Paid plans run in Jakarta. Contact support to move it first." (+ Indonesian). Run web checks.
- [ ] **Step 6:** Commit `feat(fleet): place paid plans in PAID_NODE_REGIONS only`.

Ops after merge (owner action, not in code): set `PAID_NODE_REGIONS=id-jakarta` in the backend env on `jkt-1`. A free instance on `jkt-2` that wants to upgrade is moved by the operator with the cross-node recovery runbook (`docs/runbook-multi-node.md`).

### Task 4b: Region copy matches reality

**Files:**
- Modify: `apps/landing/src/app/kebijakan-privasi/page.tsx:70`, `:87`; `apps/landing/src/lib/metadata.ts:6`; free-beta copy in `apps/landing/src/components/site/free-beta.tsx` if it names a region; `apps/docs/content/docs/(panduan)/paket-dan-penagihan.mdx:13` (stays "Jakarta" for paid).

- [ ] **Step 1:** Privacy policy: "Tencent Cloud untuk server tempat instance berjalan: paket berbayar di Jakarta, Indonesia; instance beta gratis bisa berjalan di Jakarta atau Singapura." and the data-location sentence to match. Legal copy: owner approves in the PR.
- [ ] **Step 2:** Metadata description: drop "di Jakarta" or say "paket berbayar di Jakarta".
- [ ] **Step 3:** Landing checks; update `CURRENT_STATE.md`; commit `docs(landing): state where free and paid instances run`.

---

## PR 3: Paid-to-paid plan change (`feat/paid-plan-change`)

### Task 5: Request a plan change

**Files:**
- Modify: `prisma/schema.prisma` (`PaymentPurpose` + `PLAN_CHANGE`; `InvoiceKind` + `HOSTING_PLAN_CHANGE`; `Payment.fromPlanId String? @db.Uuid`, `Payment.targetPlanId String? @db.Uuid`, `Payment.creditNano BigInt?`)
- Create: `prisma/migrations/20261125200000_plan_change_payment/migration.sql`
- Create: `src/modules/billing/plan-change.ts` (pure quote)
- Modify: `src/modules/billing/billing-service.ts` (new `changePlan`)
- Test: `test/unit/plan-change.test.ts`, `test/integration/billing-plan-change.test.ts` (new)

**Interfaces:**
- Produces in `plan-change.ts`:
  ```ts
  export type PlanTerms = { monthlyPriceIdr: number; includedCreditNano: bigint | null; cpuMillis: number; memoryMb: number; storageMb: number };
  export type PlanChangeQuote = { amountIdr: number; creditNano: bigint; immediate: boolean };
  export function quotePlanChange(i: { current: PlanTerms; target: PlanTerms; now: Date; periodEnd: Date }): PlanChangeQuote;
  export function canChangePlan(current: PlanTerms, target: PlanTerms): boolean; // every resource of target >= current, and target differs
  ```
  Rules: `fraction = clamp((periodEnd - now) / (PERIOD_DAYS days), 0, 1)`; `amountIdr = Math.ceil((target.price - current.price) * fraction)`; `immediate = amountIdr < SUMOPOD_MIN_AMOUNT_IDR`; `creditNano = immediate ? 0n : max(0n, (targetCredit - currentCredit) * remainingMs / periodMs)` in BigInt, rounded down.
- Produces: `BillingService.changePlan(i: { tenantId: string; email: string; subscriptionId: string; planId: string; idempotencyKey: string }): Promise<{ subscription: SubscriptionView; payment: PaymentView | null }>`.
  - Refuse: subscription not `ACTIVE` or period ended -> 409 `subscription_not_changeable`; same plan or `!canChangePlan` -> 409 `plan_change_not_allowed`; open `RENEWAL` payment (`PENDING`, not expired) -> 409 `renewal_open`; instance in recovery -> `ConflictError`; plan not for sale -> `PlanNotForSaleError`.
  - Under the tenant advisory lock: `assertStock(tx, target, now)`; `placement?.select(tx, target, now, { fixedNodeId: inst.nodeId, currentPlan, subscriptionId, regions: paidNodeRegions })`; expire this subscription's other `PENDING` `PLAN_CHANGE` payments.
  - `immediate`: set `sub.planId = target.id` in the transaction, return `payment: null`, then call `applyPlanChange(sub.id)` after it.
  - Otherwise: create `Payment` `{ purpose: 'PLAN_CHANGE', amountIdr, fromPlanId, targetPlanId, creditNano }`, issue the invoice with return URL `/dashboard/instances/${instanceId}/billing`. Replay of the same `Idempotency-Key` with the same plan returns the open payment; with another plan -> `ConflictError`. Store the key the way `upgrade` does (payment-level `merchantOrderId` is not the key; reuse `replay` if it fits, else look up the open `PLAN_CHANGE` payment by `targetPlanId`).

- [ ] **Step 1: Unit tests (`test/unit/plan-change.test.ts`)**
  - `hosting to pro with 15 of 30 days left costs half the difference`: current 25_000, target 49_000 -> `amountIdr` 12_000, `creditNano` 0n, `immediate` false.
  - `hosting to hosting-kredit with 30 days left`: 25_000 -> 50_000 gives 25_000 and `creditNano` 2_000_000_000n.
  - `kredit to pro is immediate and free`: 50_000 -> 49_000 gives `amountIdr` <= 0, `immediate` true, `creditNano` 0n.
  - `tiny remainder is immediate`: 1 hour left, hosting to pro -> `immediate` true.
  - `canChangePlan refuses smaller storage`: hosting-kredit (10240 MB) -> hosting (5120 MB) is false; pro -> pro-kredit is true.
- [ ] **Step 2: Integration tests (`billing-plan-change.test.ts`)**
  - `creates a PLAN_CHANGE invoice with the prorated amount`.
  - `refuses while a renewal invoice is open` -> `renewal_open`.
  - `refuses a storage downgrade` -> `plan_change_not_allowed`.
  - `refuses a suspended subscription` -> `subscription_not_changeable`.
  - `a second request expires the first PLAN_CHANGE payment`.
  - `immediate change updates the instance plan without an invoice` (instance `planId` = target, `plan.changed` event).
  - `refuses when the target plan has no stock`.
- [ ] **Step 3:** Run both; they fail.
- [ ] **Step 4:** Schema + migration (`--create-only`, check SQL: two `ALTER TYPE ... ADD VALUE`, three nullable columns), then implement `plan-change.ts` and `changePlan`.
- [ ] **Step 5:** Both pass; `pnpm build`. Commit `feat(billing): request a paid plan change with a prorated invoice`.

### Task 6: Apply a paid plan change

**Files:**
- Modify: `src/modules/billing/billing-service.ts` (`activate`, `afterActivation` unchanged), `src/modules/billing/invoices.ts` or wherever `issueInvoice` maps kinds
- Test: `test/integration/billing-plan-change.test.ts`

**Interfaces:**
- Consumes: `Payment.fromPlanId/targetPlanId/creditNano` (Task 5), `CreditGrant.paymentId` (Task 1).
- Produces: in `activate`, a `PLAN_CHANGE` payment:
  - issues invoice kind `HOSTING_PLAN_CHANGE`;
  - does not extend `currentPeriodEnd`;
  - when `sub.status` is `ACTIVE` or `GRACE` and `sub.planId === payment.fromPlanId`: set `sub.planId = payment.targetPlanId`; when `creditNano > 0n`, upsert `CreditGrant` keyed on `paymentId` (same shape as Task 2); return an `Activation` so `afterActivation` runs `applyPlanChange`;
  - otherwise (ended, replaced, or plan already changed): `moveWallet(tx, { tenantId, amountIdr: payment.amountIdr, kind: 'TOPUP', refId: \`plan-change:${payment.id}\`, note: 'Ganti paket tidak diterapkan, dana masuk ke saldo' })` and report `credited_to_wallet`.
- `applyPlanChange` event message becomes "Plan changed after payment" (it now serves both flows).

- [ ] **Step 1: Failing tests**
  - `paid plan change moves the instance to the new plan and keeps the period end`.
  - `paid plan change to a Kredit plan creates a credit grant with the prorated amount`.
  - `late payment of a replaced plan change goes to the wallet` (Review Focus 2).
  - `plan change paid after the subscription ended goes to the wallet`.
  - `plan change paid from the wallet applies the same way` (`payWithWallet`).
  - `invoice kind is HOSTING_PLAN_CHANGE`.
- [ ] **Step 2:** Run; fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm test:integration` for all `billing-*`, `sumopod-webhook`, `router-provisioner`, `multi-node-fleet` pass; `pnpm build`, `pnpm test:unit`.
- [ ] **Step 5:** Commit `feat(billing): apply a paid plan change after payment`.

### Task 7: Route

**Files:**
- Modify: `src/http/billing-routes.ts` (after `/subscriptions/upgrade`, line ~54)
- Test: `test/integration/billing-api.test.ts`

**Interfaces:**
- Produces: `POST /api/v1/subscriptions/:subscriptionId/change-plan`, body `{ planId: uuid }`, header `Idempotency-Key`, same `gate(p.email)` and rate limit `{ max: 10, timeWindow: '10 minutes' }` as upgrade. 201 with `{ subscription, payment }` (`payment` null when immediate).

- [ ] **Step 1:** Tests: `change-plan returns 201 with a payment`, `change-plan of another tenant's subscription is 404`, `change-plan without Idempotency-Key is 400`, `change-plan is closed when PAID_CHECKOUT_OPEN=false for a non-invited email`.
- [ ] **Step 2:** Fail, implement (zod body like `upgradeBody`), pass.
- [ ] **Step 3:** Document the route in `apps/docs/content/docs/api-reference/` next to the upgrade route. Commit `feat(api): change a paid plan`.

### Task 8: Dashboard plan change

**Files:**
- Modify: `apps/web/src/lib/api/types.ts`, `live.ts`, `mock.ts`, `index.ts` (billing client), `apps/web/src/hooks/use-hermes.ts` (next to `useUpgrade`, line 170), `apps/web/src/app/(app)/instances/[id]/billing/page.tsx:205-230`, `apps/web/src/lib/i18n-id.ts`
- Test: the web unit test file that covers billing (find with `grep -rln "useUpgrade\|FreeUpgrade" apps/web/src`), plus mock API

**Interfaces:**
- Consumes: route from Task 7.
- Produces: `billing.changePlan({ subscriptionId, planId }, idempotencyKey): Promise<{ subscription; payment: Payment | null }>` and `useChangePlan()` (invalidates `keys.subscriptions` and the instance query).

- [ ] **Step 1:** Replace the disabled "Switch plan (coming soon)" button and the TODO with: for each priced plan that is not current and whose `storageMb`, `memoryMb`, `cpuMillis` are all >= the current plan's, a "Switch to {plan}" button. Others show "Not available as a switch" disabled. Remove the "When plan changes arrive..." paragraph; replace with "You pay the price difference for the days left in this period. The period end stays the same. Moving to a smaller plan is not possible yet."
- [ ] **Step 2:** The button opens `useActionConfirmation` with "Switch to {plan}? The difference for the remaining days is charged now." On confirm, call `useChangePlan`. With a payment, render the existing `PayButton` for it (it already shows amount and method before paying). With `payment: null`, toast "Plan changed".
- [ ] **Step 3:** Map error codes: `renewal_open` -> "Pay or let the open renewal invoice expire first."; `plan_change_not_allowed`, `subscription_not_changeable`, `region_not_for_paid` (Task 4) to short messages. Indonesian for every new string.
- [ ] **Step 4:** Mock API returns a payment for a price increase and `null` for a decrease. Unit test: `billing page offers a switch only to plans with no smaller resources`.
- [ ] **Step 5:** Web checks pass. Update `CURRENT_STATE.md` (plan change live behind the existing checkout gate). Commit `feat(web): switch between paid plans`.

---

## PR 4: Outcome-led landing copy (`feat/landing-outcome-copy`)

### Task 9: Hero, features, pricing header

**Files:**
- Modify: `apps/landing/src/components/site/hero.tsx:23-46`, `features.tsx`, `how-it-works.tsx` (only if it says "container" as the first step), `pricing.tsx` (`PlanCard` badge), `apps/landing/src/app/harga/page.tsx:9`, `apps/landing/src/lib/metadata.ts:6`
- Test: `apps/landing/test/metadata.test.ts`, `site.test.ts` (update only assertions that pin old copy)

Draft copy (owner checks every claim against what Hermes really does before merge):
- [ ] **Step 1:** Hero `h1`: "Asisten AI pribadimu di Telegram, aktif 24 jam." Lead: "Kirim pesan, agen Hermes mengerjakan: merangkum tautan dan berita, mencatat tugas, menjalankan perintah di ruang kerjanya sendiri. Tanpa sewa VPS, tanpa Docker, tanpa perawatan server." Bullets: "Tersambung ke Telegram dalam beberapa menit", "Ingatan dan file tersimpan di volume milikmu", "Bayar bulanan dengan QRIS".
- [ ] **Step 2:** Keep the technical facts (one container, own volume, full shell, no host access) in `features.tsx` instead of the hero.
- [ ] **Step 3:** `PlanCard`: outline badge "Disarankan untuk mulai" on `hosting-kredit` only (pick by `plan.id`). Do not claim "paling populer": nothing proves it.
- [ ] **Step 4:** `/harga` meta description and `metadata.ts` lead with the use case, keep "Harga dalam Rupiah".
- [ ] **Step 5:** `grep -nP "\x{2014}|\x{2013}" -r apps/landing/src` returns nothing. Landing checks pass. Commit `feat(landing): lead with what the agent does`.

---

## PR 5: Upsell notice on free instances (`feat/free-upsell-notice`)

### Task 10: Notice on the instance overview

**Files:**
- Modify: `apps/web/src/app/(app)/instances/[id]/page.tsx`, `apps/web/src/lib/i18n-id.ts`
- Create (only if no shared helper fits): a small `FreeUpsell` component next to `BillingNotice` in `apps/web/src/components/app/`
- Test: web unit test for the component

**Interfaces:**
- Consumes: plans query already used by the billing page; instance plan `monthlyPriceIdr === null` marks a free instance.
- Produces: `<FreeUpsell instanceId plans />` renders nothing unless the instance is free and the `hosting-kredit` plan is available.

- [ ] **Step 1:** Test: `FreeUpsell shows the Kredit plan price for a free instance` and `FreeUpsell renders nothing on a paid instance` and `... nothing when hosting-kredit is sold out`.
- [ ] **Step 2:** Implement with shadcn `Alert`: title "Free plan uses free AI models"; body "Free models can be slow or limited when busy. {plan} costs {price} per month and includes US${credit} AI credit every month for faster models."; button "See paid plans" linking to `/instances/{id}/billing`. Price and credit come from the plans API, never hard-coded.
- [ ] **Step 3:** Indonesian strings, web checks pass, update `CURRENT_STATE.md`, commit `feat(web): suggest a paid plan on free instances`.

---

## Self-review notes

- Spec coverage: deploy (Task 0, already live), copy (Tasks 3, 4b, 9), plan change with proration (Tasks 5-8), credit every month (Tasks 1-3), Jakarta-only paid (Tasks 4, 4b), free upsell (Task 10).
- Not covered by design: downgrades (smaller storage or lower resources) stay unavailable; ready-made skill templates and NibieRouter coupons/banners were left out of scope.
- Order matters: PR 1 before PR 3 (`CreditGrant.paymentId`), PR 2 before PR 3 (`regions` in `select`). PR 0, PR 4, PR 5 are independent.
