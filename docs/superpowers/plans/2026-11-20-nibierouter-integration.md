# Plan: NibieRouter integration (model choice, key limits, AI usage, AI credit)

## Context

Nibie Cloud already gives every instance a NibieRouter key (`src/modules/nibierouter`): one router user per tenant, one key
per instance named `inst-<instanceId>`, and a one-time US$2 credit for the "Hosting + Kredit AI" plan. All instances use one
model from env, `NIBIEROUTER_DEFAULT_MODEL` (`nibierouter-free` in production, `router-provisioner.ts:206`), and the customer
never sees the router key, so they cannot change the model. As a result the Kredit plan's credit is never spent, since free
models cost nothing. No customer has bought that plan yet (stock used 0 on 2026-11-20).

**Owner decisions (2026-11-20):**
- The default model stays `nibierouter-free` for every plan.
- Customers may choose any active router model. Free plans get only the free models.
- Write the plan first; no code yet.

**Facts verified read-only on 2026-11-20:**
- **`GET https://router.nibie.app/v1/models`** (public, no key): 147 models, each with `id`, `name`, `context_length`,
  `pricing.prompt` / `pricing.completion` (US$ per token, as strings), `supports_reasoning` and `supports_vision`.
  - Three are free, with every price at `0`: `nibierouter-free`, `hy4-flash:free` and `qwen4-max:free`.
- **`GET /api/admin/users/:id`**: `{ user: { balance_nano, ... }, stats: { spend_nano, spend_30d_nano, requests_30d,
  last_request_at, ... }, daily: [{ day, requests, tokens, cost_nano }], models: [{ model_slug, requests, tokens, cost_nano }],
  estimated }`. This removes blocker 3 of the wallet plan (`2026-11-20-wallet-topup.md`).
- **`GET /api/admin/users/:id/keys`**: each key has `id`, `name`, `usage_nano`, and the limit fields `credit_limit_nano`,
  `budget_period` (daily/weekly/monthly), `rpm_limit`, `max_parallel`, `allowed_models`, `allowed_ips` and `expires_at`.
  On the instance keys all of these are `null`.
- **Money:** a free-plan tenant's router balance is 0. A paid model then answers HTTP 402, so a free tenant choosing a
  paid model costs us nothing; it only fails. The free-only rule is for the customer's experience, not a money guard.

**Not verified:** the request that updates a key (method and body) on the admin API. The SumoRouter admin MCP says the key
"is replaced with exactly these values". Step 2 checks this against a throwaway router user first, with the owner's OK.

## Order

One PR per step, each shippable alone. Step 1 makes the Kredit plan usable, so it comes first.

## Step 1: customer chooses the model

**Backend**
- **`ModelCatalog`** (new, `src/modules/nibierouter/model-catalog.ts`):
  - Fetches `GET {NIBIEROUTER_BASE_URL}/models` through `safeFetch` (https only, `allowHosts` = the router host).
  - Parses with zod into `{ id, name, contextLength, promptUsdPerM, completionUsdPerM, free }`, where `free` means every
    price is 0.
  - Cached in memory for 10 minutes. Router down: serve the stale copy, or throw `RouterUnavailableError` when the cache
    is empty.
- **`GET /instances/:id/models`** (customer API): the catalogue, filtered to `free` models when the instance's plan has
  no price (`Plan.monthlyPriceIdr` null), plus the instance's current model.
- **`PUT /instances/:id/providers/model`** (customer API), body `{ model }`:
  - Only for a provider of kind `NIBIEROUTER`; a BYOK instance answers 409.
  - The model must be in the catalogue, and must be `free` on a free plan; otherwise 400.
  - Calls a new `ProviderService.setModel(tenantId, instanceId, model)`. In one transaction it updates
    `ProviderConfig.model` and bumps `Instance.configRevision`. The secret does not change.
  - The answer is the provider view with `restartRequired`, the same pattern as saving a BYOK key: the customer restarts
    from the dashboard.
- **Default model:** unchanged (`NIBIEROUTER_DEFAULT_MODEL`). No `Plan.defaultModel` column, because the owner keeps the
  free model for every plan.

**Dashboard** (`apps/web/src/app/(app)/instances/[id]/configuration/page.tsx`, "AI provider" tab)
- When the provider is NibieRouter (customer mode), show:
  - a searchable model picker with each model's name, price per 1M tokens (input and output), and a "Gratis" label for
    free models;
  - a "Simpan" button, followed by the existing "restart to apply" notice.
- On a paid model, a line explains that it uses the AI balance, and that a request fails when the balance is empty.
- Free plan: only the three free models are listed, with a line that paid models come with a paid plan.

**Tests**
- Unit: the catalogue parser with a fake fetcher (prices to per-1M numbers, `free` detection, a malformed entry is
  dropped), and the cache (stale copy served when the router is down).
- Integration:
  - A free plan refuses a paid model (400).
  - An unknown model is refused (400).
  - A BYOK instance answers 409.
  - Success changes `ProviderConfig.model` and bumps `configRevision`.
  - The next start writes the new `model:` block (`hermes-config.ts`).

## Step 2: limits on the instance keys

- **`NibieRouterClient`:**
  - `listKeys` also returns `id` and the limit fields.
  - New `updateKey(userId, keyId, settings)`. Its request shape is verified first (see "Not verified").
- **Limits for every instance key:** `rpm_limit` and `max_parallel`, so one agent cannot use up the shared free capacity.
  - Set right after `createKey` in `ensureKey`.
  - Existing keys get them in a one-time sweep in the billing tick (keys whose limits are still `null`).
- `allowed_models` is not used: the zero balance already blocks paid models on free plans, and a fixed list would also
  block free models the router adds later.
- **Owner decides the numbers**, for example 20 requests per minute and 2 parallel requests.
- **Tests:** a unit test of the body sent by `updateKey`, and an integration test that a new instance's key gets the
  limits.

## Step 3: AI balance and usage in the dashboard, low-balance email

- **Client:** `NibieRouterClient.getUser(userId)` returns `{ balanceNano, spend30dNano, daily[], models[] }`, using the
  shape verified above.
- **`GET /ai-usage`** (customer API, per tenant): balance in US$, 30-day spend, daily requests and cost, and cost per model.
  - Cached for 60 seconds per tenant.
  - Router down: `503 router_unavailable`, and the page says so.
- **Dashboard:** the Usage page, hidden in customer mode today, shows this data with the existing `LineChart`. The AI
  provider tab shows the balance next to the model picker.
- **Low-balance email** (billing tick, at most once an hour per tenant):
  - **When:** the tenant has at least one instance on a paid model and a router balance below the threshold. The owner
    decides the threshold, for example US$0.20.
  - **What:** one plain-text Indonesian email per drop below the threshold (lesson of PR #85).
  - **Deduplication:** a `BillingNotice` key `ai_low:<tenant>:<n>`, where `n` increases each time the balance goes back
    above the threshold.
- **Tests:**
  - Unit: the email render, and the threshold rule (below, still below, back above, below again gives 2 emails).
  - Integration: `/ai-usage` with a fake router client.

## Step 4: buy AI credit from the wallet

Unchanged from PR 3 of `2026-11-20-wallet-topup.md`: `BillingSetting.aiCreditIdrPerUsd`, `POST /wallet/ai-credit`, the
exactly-once `CreditGrant` path, admin rate setting, and the dashboard dialog. Its blocker 3 (balance shape) is resolved
above, and it reuses `getUser` from step 3.

## Risks

- **Model list changes:** a model can disappear from the router while an instance still uses it. Requests then fail on
  the router. Step 3's usage page shows errors; the customer picks another model. No automatic switch.
- **Catalogue fetch:** the public `/v1/models` has no admin key, so it is safe to call from the control plane. A failure
  never changes a saved model.
- **Cost:** the router balance is the only spending limit. A paid-plan customer can spend their US$2 credit in a few
  requests on an expensive model. The picker shows prices, and step 3 shows the balance.

## Files

- **Backend:** `src/modules/nibierouter/{nibierouter-client,router-provisioner}.ts`, new `model-catalog.ts`,
  `src/modules/integrations/provider-service.ts`, `src/http/integration-routes.ts`, `src/modules/billing/billing-tick.ts`,
  `email-templates.ts` (step 3).
- **Dashboard:** `apps/web/src/lib/api/{customer,integrations,types}.ts`, the configuration page, the Usage page.
- **Docs:** `docs/CURRENT_STATE.md`, `docs/setup.md` (NibieRouter section), `AGENTS.md` NibieRouter bullet.
