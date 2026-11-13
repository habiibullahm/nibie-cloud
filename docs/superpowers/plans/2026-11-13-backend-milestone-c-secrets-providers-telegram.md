# Backend Milestone C (secrets, providers, Telegram) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (default) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer can attach an AI provider (BYOK, or NibieRouter attached by the operator) and a Telegram bot to an instance. Every credential is envelope-encrypted at rest, never returned after submission, never logged, never placed in a Redis job payload, and reaches the Hermes container only as environment at container creation. The customer can read redacted logs.

**Architecture:** A `SecretStore` (AES-256-GCM data key per secret, wrapped by a versioned key-encryption key from the environment) owns all ciphertext. Provider and Telegram services hold only `secretId` references. A single outbound guard (`safeFetch`) is the only way the control plane calls a customer-supplied URL. When a config changes, the instance's `configRevision` is bumped; the next restart notices `appliedRevision < configRevision` and recreates the container (volume kept) with the new environment. The worker reads secrets itself at run time, so job payloads stay ids only.

**Tech Stack:** Node `crypto` (no new crypto dependency), `undici` (already a Node 22 built-in dispatcher API; no new package if `fetch` with a custom `lookup` works, Task 4 decides), existing Fastify 5, Prisma 6, BullMQ, Vitest 3.

**Spec:** `docs/superpowers/specs/2026-11-12-backend-design.md` section 6 ("C"), PRD 7.3, 7.4, 8, 9, 15.4, 15.5.

## Facts about the Hermes image (read 2026-11-13 from the upstream repository, NOT yet verified against the pinned image)

- Telegram: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USERS` (comma-separated numeric user ids) are environment variables. The default transport is long polling; webhook mode only starts when `TELEGRAM_WEBHOOK_URL` is set. Polling needs outbound `api.telegram.org` only, no inbound port, which fits the tenant network.
- Provider: model and endpoint live in `/opt/data/config.yaml` (`model.provider`, `model.default`, `model.base_url`, `model.api_key` or `model.key_env`). `LLM_MODEL` in `.env` is removed. `OPENAI_BASE_URL` is honoured only for the `openai-api` provider. `hermes config set <dotted.key> <value>` edits `config.yaml`; `UPPER_SNAKE` names go to `/opt/data/.env`. The image seeds `config.yaml` and `.env` on first boot.
- Consequence: a provider cannot be delivered by environment alone unless the spike (Task 1) shows an env-only path. Task 1 decides between the two delivery variants below before any apply code is written.

## Decisions that differ from, or are not in, the spec text (confirm at review)

1. **Logs are in C, AI usage is not.** The spec lists "usage from Docker stats", but that is CPU and memory, not AI usage; PRD 8.1 says show AI usage only when upstream data is authoritative. AI usage waits for the NibieRouter usage API and is a later milestone.
2. **NibieRouter without a service account:** no per-tenant key minting. The operator creates a key in the SumoRouter dashboard (per-key credit limit and revocation exist there) and attaches it with an operator-only route. The customer only sees "NibieRouter, connected". A minting adapter comes when a service account exists.
3. **Telegram allowlist is mandatory.** `PUT telegram` requires at least one numeric `allowedUserIds`; an open bot is refused (PRD 9: allowlist as secure default).
4. **Config changes apply on the next restart, not live.** The response says `restartRequired: true`. This reuses the existing restart job; no new operation or state is added.
5. **One active provider config and one Telegram connection per instance** for the beta (unique on `instanceId`). The PRD's list endpoint returns an array so the API does not change later.
6. **`SECRETS_KEK` is a base64 32-byte env var** with `SECRETS_KEK_VERSION` (default `1`) and an optional `SECRETS_KEK_PREVIOUS` + `SECRETS_KEK_PREVIOUS_VERSION` for rotation. Required when `NODE_ENV=production`. When unset in development the secret routes answer `503 secrets_unavailable` and nothing else changes.
7. **Deleting an instance purges its secrets** (PRD 10: delete associated secrets), recorded as an audit event without values.

## Review Focus

1. Plaintext never appears: not in any HTTP response after submission, any log line (including error paths and `pino` redaction of `env.*`), any `InstanceEvent`, any Redis job, any Prisma row, or any thrown error message. A test greps all of those for a canary secret.
2. Cross-tenant: tenant B cannot read, replace, test or delete tenant A's provider or Telegram config, and a `secretId` taken from one tenant is rejected for another (AAD binds ciphertext to tenant and secret id).
3. SSRF: every way to reach loopback, private, link-local, CGNAT, metadata and reserved ranges is refused: literal IPs (decimal, octal, hex, IPv6, IPv4-mapped), a hostname resolving to such an address, DNS that changes between validation and connection (rebinding), redirects to such hosts, non-https schemes, userinfo in URLs, and oversized or slow responses.
4. Rotation: after changing `SECRETS_KEK`/version, old secrets still decrypt with the previous key, `rewrap` moves them to the new version, and a wrong or missing key fails closed with a generic error.
5. Apply path: a replaced token reaches a recreated container with the volume intact; a failed recreate leaves the instance in a state the reconciler and reaper already understand, and does not leave the old secret in a half-written state.
6. Provider outage is not a runtime failure: a failing `providers/test` never changes instance status or triggers a restart (PRD 8.3).

---

## File structure

- Create `src/modules/secrets/crypto.ts`: pure envelope encryption (`seal`, `open`, `rewrap`), key parsing.
- Create `src/modules/secrets/secret-store.ts`: `SecretStore` interface and Prisma implementation.
- Create `src/modules/net/safe-fetch.ts` and `src/modules/net/ip-ranges.ts`: outbound guard.
- Create `src/modules/integrations/telegram-service.ts`, `provider-service.ts`, `redact.ts`.
- Create `src/http/integration-routes.ts` (customer) and extend `operator-routes.ts` (NibieRouter attach, secrets health).
- Modify `prisma/schema.prisma` (+ one migration), `src/config/env.ts`, `src/modules/instances/instance-service.ts` (env builder, recreate on revision gap, purge on delete), `src/modules/runtime/types.ts` and `docker-runtime-manager.ts` (`recreate`, `logs`, and the delivery variant from Task 1), `src/http/server.ts`, `src/main.ts`.
- Docs: `docs/setup.md`, `docs/architecture.md`, `docs/CURRENT_STATE.md`, `AGENTS.md`, `docs/README.md`.

---

### Task 1: Spike: how Hermes receives provider and Telegram config

No production code. Output is `docs/adr/0003-hermes-config-delivery.md` with evidence.

- [ ] **Step 1:** Re-read the upstream docs listed under "Facts" and record the exact commit or release of the pinned image the facts apply to. If the pinned image digest differs from the docs, say so.
- [ ] **Step 2:** If a Docker daemon and the pinned image are reachable from the executing environment, run the image with only `TELEGRAM_BOT_TOKEN` (a dummy value), `TELEGRAM_ALLOWED_USERS`, `API_SERVER_KEY` and check: the gateway still boots, polling is attempted (expected log line, no inbound port), a bad token fails in a way that does not crash the API server. If the image is not reachable, write that in the ADR and mark the Telegram facts "docs only". Never use a real token.
- [ ] **Step 3:** Decide the provider delivery variant and write it in the ADR. **Variant 1 (preferred if possible):** an env-only path exists (for example `provider: auto` picking a provider from `OPENROUTER_API_KEY`, or `model.key_env` plus a seeded block) so everything is environment at creation. **Variant 2:** the control plane writes a managed `model:` block into `/opt/data/config.yaml` before first start through a new narrow `RuntimeManager.seedConfig(instanceId, text)` (fixed path, fixed owner uid 10000, only when absent or marked managed) and the key stays in env through `key_env`. A shell exec into tenant containers is not an acceptable variant (it widens the attack surface the architecture removed).
- [ ] **Step 4:** If the spike cannot decide (image unreachable and docs ambiguous), stop and ask the owner to run the listed commands on the VPS, as with earlier host checks. Tasks 2 to 7 do not depend on this and may proceed; Task 8 waits.
- [ ] **Step 5: Commit** `docs: record Hermes config delivery decision`.

### Task 2: Envelope encryption and configuration

**Files:** Create `src/modules/secrets/crypto.ts`; modify `src/config/env.ts`, `.env.example`; tests `test/unit/secrets-crypto.test.ts`, `test/unit/config.test.ts`.

**Interfaces:** Produces `Kek {version:number; key:Buffer}`, `Config.secrets: {current: Kek; previous: Kek|null} | null`, `seal(kek, plaintext, aad): SealedSecret`, `open(keks, sealed, aad): string`, `rewrap(keks, sealed, aad, to): SealedSecret`, `keyHint(plaintext): string` (last four characters, or `****` when the value is shorter than 12).

- [ ] **Step 1: Write failing tests:** round trip; two seals of one plaintext differ (random data key and iv); tampered ciphertext, wrapped key, iv, tag, version or AAD each fail with one generic `SecretDecryptError` whose message contains no plaintext, key or AAD; `open` picks the previous key by version; `rewrap` yields the new version and never exposes the plaintext to the caller; wrong-length key rejected at config parse naming `SECRETS_KEK` without echoing it; production without `SECRETS_KEK` throws; same version number with two different keys rejected.
- [ ] **Step 2: Run, watch them fail.** Expected: module not found.
- [ ] **Step 3: Implement** per-secret 32-byte data key, AES-256-GCM for the value, AES-256-GCM key wrap with the KEK, AAD = `tenantId:secretId:purpose`, all fields base64 in a small JSON-free struct. Add config parsing.
- [ ] **Step 4: Run** `pnpm build && pnpm vitest run test/unit`. Expected: clean and passing.
- [ ] **Step 5: Commit** `feat(secrets): envelope encryption and key config`.

### Task 3: Schema and SecretStore

**Files:** Modify `prisma/schema.prisma`, add migration; create `src/modules/secrets/secret-store.ts`; test `test/integration/secret-store.test.ts`.

**Interfaces:** Produces models `Secret {id, tenantId, purpose, ciphertext fields, kekVersion, keyHint, createdAt, rotatedAt?, revokedAt?}`, `ProviderConfig {id, instanceId unique, kind BYOK|NIBIEROUTER, baseUrl, model, secretId, status UNTESTED|OK|FAILED, lastTestedAt?, lastErrorCode?}`, `TelegramConnection {id, instanceId unique, secretId, botId, botUsername, allowedUserIds String[], status, verifiedAt?}`, `Instance.configRevision Int @default(0)`, `Instance.appliedRevision Int @default(0)`; and `SecretStore {put, get, replace, revoke, purgeForInstance, rewrapAll}`. `get` is documented worker-side only and is not imported by `src/http`.

- [ ] **Step 1: Write failing tests:** `put` returns an id and a `keyHint` and the row holds no plaintext (scan every column); `get` round-trips; `get` of a revoked secret throws `NotFoundError`; `replace` creates a new secret, revokes the old one in one transaction, and bumps `configRevision`; `get` with the wrong tenant fails; `rewrapAll` moves rows to a new KEK version and leaves ids stable; `purgeForInstance` deletes ciphertext (row removed, not only flagged) and leaves an `InstanceEvent` without values.
- [ ] **Step 2: Run, watch them fail,** add schema and migration (`pnpm db:migrate`), implement the store, run again.
- [ ] **Step 3: A source-grep unit test** asserts `src/http/**` does not import `secret-store` `get` (keeps the "worker-side only" rule honest) and that no module under `src/` logs a `Secret` row.
- [ ] **Step 4: Commit** `feat(secrets): secret store and integration schema`.

### Task 4: Outbound guard (`safeFetch`)

**Files:** Create `src/modules/net/ip-ranges.ts`, `src/modules/net/safe-fetch.ts`; tests `test/unit/ip-ranges.test.ts`, `test/integration/safe-fetch.test.ts` (local HTTP servers, injected resolver).

**Interfaces:** Produces `isForbiddenAddress(ip): boolean` and `safeFetch(url, {method, headers, body?, timeoutMs, maxBytes, resolver?, allowHosts?}): Promise<{status, headers, body: string}>`. It throws `OutboundBlockedError` (`outbound_blocked`) and `OutboundFailedError` (`outbound_failed`) with fixed messages that do not echo the URL, headers or any resolved address.

- [ ] **Step 1: Write failing tests** for every item in Review Focus 3: the full forbidden table (loopback, RFC1918, link-local including `169.254.169.254`, CGNAT `100.64/10`, `0.0.0.0/8`, multicast, reserved, IPv6 loopback/ULA/link-local, IPv4-mapped IPv6, plus the non-dotted-decimal spellings of 127.0.0.1); a hostname that resolves to a forbidden address; a resolver that returns a public address on the first call and a private one on the second (the connection must use the address validated once, so the test asserts the socket target, not the second lookup); a 302 to a forbidden host is not followed (redirects off); `http:` and URLs with userinfo refused; body larger than `maxBytes` aborts; slow body aborts at `timeoutMs`.
- [ ] **Step 2: Implement** with a custom `lookup` that resolves once, rejects if any answer is forbidden, and pins the connection to the validated address while keeping the original hostname for SNI and the `Host` header. If Node's built-in `fetch` cannot pin the address, use `undici`'s `Agent({connect:{lookup}})` and record the added dependency version in the ledger.
- [ ] **Step 3: Run** `pnpm vitest run test/unit/ip-ranges.test.ts test/integration/safe-fetch.test.ts`. Expected: passing.
- [ ] **Step 4: Commit** `feat(net): SSRF-safe outbound fetch`.

### Task 5: Telegram service

**Files:** Create `src/modules/integrations/telegram-service.ts`; test `test/integration/telegram-service.test.ts` (fake Telegram server injected as the API base; production base is the constant `https://api.telegram.org`, never user supplied).

**Interfaces:** Produces `TelegramService.put(tenantId, instanceId, {token, allowedUserIds})`, `.get`, `.verify`, `.remove`. Uses `SecretStore`, `safeFetch` with `allowHosts: ['api.telegram.org']`.

- [ ] **Step 1: Write failing tests:** `put` calls `getMe`, stores the token as a secret, saves `botId` and `botUsername`, bumps `configRevision`, returns a view with `keyHint` and no token; an invalid token (Telegram `401`/`ok:false`) returns `400 validation_error` with a fixed message and stores nothing; empty `allowedUserIds` or non-numeric ids rejected; the same bot token already used by another tenant is refused (one bot, one tenant, PRD 9); replacing revokes the old secret; `remove` revokes the secret, deletes the connection, bumps the revision; `verify` re-runs `getMe` and, when the customer's own allowed user id has started the bot, sends one fixed test message and sets `verifiedAt` (a Telegram `403` "bot can't initiate" becomes a clear `needs_start` status, not an error); a Telegram outage on `verify` never changes instance status.
- [ ] **Step 2: Implement.** The token appears only inside the request path to Telegram, built at the last moment, never in a thrown error or log (tests grep the logger stream and error `message` for the canary).
- [ ] **Step 3: Commit** `feat(telegram): validate, store, replace, revoke`.

### Task 6: Provider service

**Files:** Create `src/modules/integrations/provider-service.ts`; test `test/integration/provider-service.test.ts`.

**Interfaces:** Produces `ProviderService.put(tenantId, instanceId, {kind:'BYOK', baseUrl, model, apiKey})`, `.list`, `.test`, `.remove`, and `.attachNibieRouter(instanceId, {apiKey})` (operator only; base URL is the constant `https://router.nibie.app/v1`, which is public, not a secret).

- [ ] **Step 1: Write failing tests:** BYOK `baseUrl` must be `https`, no userinfo, no query, host not forbidden (checked at `put` for fast feedback and again at every `test`); `model` length and charset limits; `put` stores the key as a secret, status `UNTESTED`, bumps the revision; `test` calls `GET {baseUrl}/models` with the key through `safeFetch` and sets `OK` or `FAILED` plus a coarse `lastErrorCode` (`unauthorized`, `unreachable`, `blocked`, `timeout`) and never stores or returns the upstream body; `test` of a blocked URL returns `outbound_blocked` without a network call; replace and remove revoke the old secret; `attachNibieRouter` is rejected for a customer principal (route test in Task 7) and its listing shows `kind: NIBIEROUTER` without key or hint.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Commit** `feat(providers): BYOK config, test and NibieRouter attach`.

### Task 7: HTTP routes

**Files:** Create `src/http/integration-routes.ts`; modify `src/http/server.ts`, `operator-routes.ts`; test `test/integration/integration-routes.test.ts`.

**Interfaces (PRD 15.4, 15.5, customer API, tenant from the user's membership as in milestone A):** `GET|PUT /instances/:instanceId/providers`, `POST /instances/:instanceId/providers/test`, `DELETE /instances/:instanceId/providers/:providerConfigId`, `GET|PUT|DELETE /instances/:instanceId/telegram`, `POST /instances/:instanceId/telegram/verify`. Operator: `PUT /api/v1/tenants/:tenantId/instances/:instanceId/providers/nibierouter`, `GET /api/v1/secrets/health` (KEK version in use, count of secrets per version, never keys). Every write response includes `restartRequired: boolean`.

- [ ] **Step 1: Write failing tests:** unauthenticated 401; another tenant's instance is 404 (not 403); strict zod bodies (unknown fields rejected, sizes capped); responses carry `keyHint` and never the secret (canary grep over every response body, including error bodies); `503 secrets_unavailable` when no KEK is configured; `test` endpoints rate limited per instance (simple in-memory minimum interval, documented as per-replica); operator-only route refuses the customer token.
- [ ] **Step 2: Implement,** wire into `server.ts` only when both the customer API and the secrets config are present.
- [ ] **Step 3: Commit** `feat(http): provider and Telegram routes`.

### Task 8: Apply to the runtime (waits for Task 1)

**Files:** Modify `src/modules/instances/instance-service.ts`, `src/modules/runtime/types.ts`, `docker-runtime-manager.ts`; create `src/modules/integrations/runtime-env.ts`; tests `test/integration/config-apply.test.ts`, `test/unit/runtime-env.test.ts`.

**Interfaces:** Produces `buildRuntimeEnv(instanceId): Promise<Record<string,string>>` (reads secrets, returns `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`, and the provider variables chosen in Task 1), `RuntimeManager.recreate(spec)` (stop and remove the container, keep network and volume, then `ensure`), and in `InstanceService.restart` a branch: if `appliedRevision < configRevision` run recreate instead of a plain restart, then set `appliedRevision` in the same fenced transition that returns the instance to `ACTIVE`. If Task 1 chose Variant 2, add `seedConfig` here.

- [ ] **Step 1: Write failing tests:** env builder output contains the secrets only in memory and is passed through `RuntimeSpec.env` (already redacted by `env.*` in the logger); restart after a token replacement recreates the container, the new container's environment holds the new token (read with the Docker API in the integration test, stub image echoes env), the data volume file written before the restart is still there; restart with no config change still does a plain restart (container id unchanged); a failed recreate (daemon error injected) leaves the instance `DEGRADED` or `FAILED` through the existing handlers, `appliedRevision` unchanged, and a second restart retries; reconciler automatic restarts also recreate when the revision gap exists, so a crashed instance never comes back with a revoked token.
- [ ] **Step 2: Implement.** Plain `ensure` is untouched for the initial provision path, which also calls `buildRuntimeEnv`.
- [ ] **Step 3: Run the complete suite** (`pnpm test`) in the background with a log file. Expected: all milestone A and B tests still pass.
- [ ] **Step 4: Commit** `feat(runtime): apply provider and Telegram config on restart`.

### Task 9: Purge on delete, redacted logs

**Files:** Modify `instance-service.ts`, `runtime/types.ts`, `docker-runtime-manager.ts`, `integration-routes.ts`; create `src/modules/integrations/redact.ts`; tests `test/unit/redact.test.ts`, `test/integration/instance-logs.test.ts`.

**Interfaces:** `RuntimeManager.logs(instanceId, {tail}): Promise<string[]>` (tail capped at 500 lines, 64 KiB), `redact(lines, secretsToScrub): string[]`, `GET /instances/:instanceId/logs?tail=` (PRD 15.3). The redactor scrubs the instance's own current secret values and common token shapes (`sk-...`, `Bearer ...`, Telegram `\d+:[A-Za-z0-9_-]{30,}`, the instance API key).

- [ ] **Step 1: Write failing tests:** deleting an instance purges its secrets and leaves a value-free audit event (after the runtime removal succeeds, never before); logs endpoint scrubs a canary the stub image prints, including when the canary is split across a line wrap the Docker log driver introduced is out of scope and noted; tail and byte caps enforced; host paths and container ids never appear (the existing `guard()` sanitation applies).
- [ ] **Step 2: Implement and run** `pnpm test`.
- [ ] **Step 3: Commit** `feat(instances): purge secrets on delete and serve redacted logs`.

### Task 10: Documentation and final verification

- [ ] **Step 1:** Update `docs/setup.md` (KEK generation command, the backup rule: lose the KEK and every secret is unrecoverable, keep a copy in the password manager, rotation procedure), `docs/architecture.md` (secrets flow, delivery variant, remove the secrets gap, record what is still open), `docs/CURRENT_STATE.md`, `AGENTS.md` ("Last verified" line and a Secrets bullet), `docs/README.md`.
- [ ] **Step 2:** Run `pnpm build` and `pnpm test` (background, log file) and paste the real counts. Confirm no secret-shaped string or project URL is in the diff (`git diff | grep`).
- [ ] **Step 3:** Whole-branch review by one fresh reviewer (Review Focus as the brief), one fix pass test-first, ledger the minors.

---

## Self-review

- Spec C row is covered except AI usage (decision 1) and the NibieRouter minting adapter (decision 2).
- Task 2 produces what Task 3 consumes (`seal/open/rewrap`, `Config.secrets`); Task 3 produces `SecretStore` and the schema that Tasks 5, 6, 8, 9 consume; Task 4 produces `safeFetch` for Tasks 5 and 6; Task 8 consumes the Task 1 decision.
- Tasks 2 to 7 can run before the spike is answered; only Task 8 is gated.
- Known limits to state at the end: no real Hermes run with a real model or a real Telegram bot unless the spike could run one; per-replica rate limit; env is visible to anyone who can `docker inspect` on the host (same trust boundary as the Docker socket, documented).
