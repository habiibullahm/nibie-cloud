# Backend Milestone A: Supabase auth and customer API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (default) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customers sign in with Supabase and manage only their own instances through a public, tenant-scoped REST API, replacing the dashboard's dev bridge, with the existing operator API unchanged.

**Architecture:** A token verifier checks Supabase JWTs locally against the project's JWKS. An identity service maps the verified `sub` to a `User`, a personal `Tenant` and an `OWNER` membership, created lazily and race-safely. Customer routes live in their own Fastify plugin next to the untouched operator routes and call the existing `InstanceService` with the principal's tenant.

**Tech Stack:** Node >= 22, TypeScript ESM, Fastify 5, Prisma 6 + PostgreSQL, zod 4, Vitest 3. New dependencies: `jose`, `@fastify/cors`, `@fastify/rate-limit` (add with `pnpm add`, keep the exact resolved versions that `pnpm-lock.yaml` records; check each supports Fastify 5 and Node 22 before adding).

**Spec:** [../specs/2026-11-12-backend-design.md](../specs/2026-11-12-backend-design.md) (sections 5 and 8). Milestones B, C and D get their own plans after this one is approved.

## Global Constraints

- Operator API behaviour, paths and tests do not change: `/api/v1/tenants/:tenantId/instances...` with bearer `ADMIN_TOKEN`; `test/integration/api.test.ts` stays green without edits other than the `Config` literal.
- Customer routes accept Supabase tokens only; operator routes accept `ADMIN_TOKEN` only. Each is its own Fastify plugin so no hook crosses over.
- The tenant id never comes from the client. A foreign or malformed instance id is `404`, identical to a missing one.
- Auth failures are one opaque `401 { error: { code: 'unauthorized', message: 'Unauthorized' } }`. Error envelope is always `{ error: { code, message } }` with sanitized messages.
- Allowed JWT algorithms: `ES256`, `RS256`, `EdDSA`. Never `none` or `HS*`. `issuer = <SUPABASE_URL>/auth/v1`, `audience = 'authenticated'`, `sub` must be a UUID, `email` required.
- Docker names, container create path, `hardening.ts` and `docker-runtime-manager.ts` are not touched (owned by the disk-quota/egress thread).
- Secrets and personal data never go into repository files; the GitHub repository is public. `.env.example` holds placeholders only. Tokens never appear in logs (`req.headers.authorization` is already in `REDACT_PATHS`).
- Customer provisioning is fail-closed: empty or unset `BETA_ALLOWED_EMAILS` means nobody may provision.
- `MAX_INSTANCES_PER_TENANT` defaults to `1` and counts instances whose status is not `DELETED`.
- Pricing stays unapproved: `GET /plans` returns `monthlyPriceIdr: null`.
- Production data lives in Supabase Postgres, in schema `hermes` (`DATABASE_URL` ends in `?schema=hermes`; no model or code changes, Prisma creates its tables and `_prisma_migrations` there). Local development and tests keep using the compose Postgres on schema `public`. Migrations in production use a direct or session connection, not the transaction pooler.
- Node >= 22, `pnpm` (lockfile canonical). Update `docs/CURRENT_STATE.md` before finishing (AGENTS.md rule). No commit or push without Nash's go-ahead; the `Commit` steps below run only after that.

## Review Focus

Inputs and conditions the spec implies that no single task's happy path exercises (each has a test in the owning task):

1. A valid token for a user whose first two requests arrive concurrently: exactly one user, one tenant, one membership, both calls succeed (Task 4).
2. A token signed with `HS256` using the public key bytes as the secret, and an unsecured `alg: none` token: both `401` (Task 3).
3. A user token sent to an operator route and the admin token sent to a customer route: both `401` (Task 5).
4. A valid user asking for another user's instance on every verb (`GET`, `/status`, `/events`, `start`, `stop`, `restart`, `DELETE`): `404`, and the other instance is unchanged (Task 6).
5. A browser preflight from an origin other than `DASHBOARD_ORIGIN`, and a request with a very long or malformed `Authorization` header: no CORS grant, `401` without a stack or token echo (Task 5).

---

### Task 1: Configuration

**Files:**
- Modify: `src/config/env.ts`, `.env.example`, `scripts/demo.ts` (the `Config` literal), `test/integration/api.test.ts` (the two `Config` literals, lines ~28 and ~114)
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Produces: `Config` gains `supabaseUrl: string | null`, `dashboardOrigin: string | null`, `betaAllowedEmails: string[]`, `maxInstancesPerTenant: number`.

- [ ] **Step 1: Write failing tests** in `test/unit/config.test.ts`:
  - `SUPABASE_URL` and `DASHBOARD_ORIGIN` unset give `supabaseUrl === null` and `dashboardOrigin === null`.
  - `SUPABASE_URL=https://abcd.supabase.co/` yields `supabaseUrl === 'https://abcd.supabase.co'` (trailing slash stripped); `http://abcd.supabase.co` and `not a url` throw an error naming `SUPABASE_URL`.
  - `DASHBOARD_ORIGIN=https://cloud.nibie.app/dashboard` throws naming `DASHBOARD_ORIGIN` (must be an origin with no path); `https://cloud.nibie.app` is accepted.
  - `BETA_ALLOWED_EMAILS=' A@x.com, b@x.com ,'` yields `['a@x.com', 'b@x.com']`; unset or empty yields `[]`.
  - `MAX_INSTANCES_PER_TENANT` defaults to `1`; `0` and `abc` throw naming `MAX_INSTANCES_PER_TENANT`.
  - Error messages still never contain values (reuse the existing "does not echo" pattern for `SUPABASE_URL`).
- [ ] **Step 2: Run** `pnpm vitest run test/unit/config.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Extend `schema` and `loadConfig`** in `src/config/env.ts` with the four fields above. `SUPABASE_URL` must parse as an `https:` URL; store `new URL(v).origin` form without a trailing slash. `DASHBOARD_ORIGIN` must equal `new URL(v).origin`.
- [ ] **Step 4: Add the new fields to the three `Config` literals** (`supabaseUrl: null, dashboardOrigin: null, betaAllowedEmails: [], maxInstancesPerTenant: 1`) and add placeholder lines for the four variables to `.env.example` with one-line comments (no real values).
- [ ] **Step 5: Run** `pnpm build && pnpm test:unit`. Expected: `tsc` clean, unit tests pass.
- [ ] **Step 6: Commit** (after Nash approves) `feat(config): add Supabase, dashboard origin and beta gate settings`.

### Task 2: Schema, migration and test helpers

**Files:**
- Modify: `prisma/schema.prisma`, `test/helpers/db.ts`, `test/helpers/service-env.ts`, `test/integration/schema.test.ts` (check what it asserts and extend it)
- Create: `prisma/migrations/<timestamp>_add_users_and_membership/migration.sql` (generate with `pnpm prisma migrate dev --create-only --name add_users_and_membership`, then edit)
- Test: `test/integration/schema.test.ts`

**Interfaces:**
- Produces: Prisma models `User { id (uuid, not generated), email, createdAt }`, enum `TenantRole { OWNER }`, `TenantMember { tenantId, userId, role }` with `@@id([tenantId, userId])` and `@@unique([userId])`, and `Plan.name String` plus `Plan.active Boolean @default(true)`. `TEST_PLAN` in `service-env.ts` gains `name: 'Test small'`.

- [ ] **Step 1: Write failing tests** in `schema.test.ts`: a second `TenantMember` row for the same `userId` is rejected (unique violation); deleting a `Tenant` or `User` that has a membership is rejected (`RESTRICT`); `Plan` rows require `name`; `resetDb` leaves no `User` or `TenantMember` rows.
- [ ] **Step 2: Run** `pnpm test:integration -- schema` (or `pnpm vitest run test/integration/schema.test.ts`; needs Postgres on the `hermes_test` database, see `docs/setup.md`). Expected: FAIL.
- [ ] **Step 3: Edit `schema.prisma`** as in spec 5.2, and generate the migration with `--create-only`. Edit the SQL so existing `Plan` rows survive: add `name` nullable, `UPDATE "Plan" SET "name" = "slug"`, then `SET NOT NULL`.
- [ ] **Step 4: Update `resetDb`** to truncate `"TenantMember", "User"` as well, and `TEST_PLAN`.
- [ ] **Step 5: Apply and run** `pnpm db:migrate` (against the test database) then `pnpm test:integration`. Expected: all existing integration tests still pass (they use `seed()`), plus the new schema tests.
- [ ] **Step 6: Commit** (after approval) `feat(db): add users, tenant membership and plan name`.

### Task 3: Supabase token verifier

**Files:**
- Create: `src/modules/auth/token-verifier.ts`
- Modify: `src/shared/errors.ts` (add `UnauthorizedError`: status 401, code `unauthorized`, message `Unauthorized`), `package.json` (`jose`)
- Test: `test/unit/token-verifier.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AuthClaims { userId: string; email: string }
  export interface VerifierOptions {
    supabaseUrl: string;                 // no trailing slash
    keys?: JWTVerifyGetKey;              // default: createRemoteJWKSet(`${supabaseUrl}/auth/v1/.well-known/jwks.json`)
    clockToleranceSec?: number;          // default 5
  }
  export function createTokenVerifier(o: VerifierOptions): (token: string) => Promise<AuthClaims>;
  ```
  Every failure throws `UnauthorizedError` with no detail from the underlying library.

- [ ] **Step 1: Write failing tests** with a locally generated `ES256` key pair and `createLocalJWKSet` (no network). Names and assertions:
  - `accepts a valid token` returns `{ userId: <sub>, email }`.
  - `rejects expired`, `rejects wrong issuer`, `rejects wrong audience`, `rejects missing email`, `rejects non-uuid sub`, `rejects unknown kid`, `rejects garbage and empty strings` and a 10 000 character string: each rejects with `UnauthorizedError`.
  - `rejects alg none` (unsecured JWT) and `rejects HS256 signed with the public key bytes as secret`.
  - The thrown error's `message` never contains the token.
- [ ] **Step 2: Run** `pnpm vitest run test/unit/token-verifier.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: `pnpm add jose`, implement `createTokenVerifier`** with `jwtVerify(token, keys, { issuer, audience: 'authenticated', algorithms: ['ES256','RS256','EdDSA'], clockTolerance })`, then check `sub` against `isUuid` (`src/shared/uuid.ts`) and `email` is a non-empty string; wrap everything in one `try/catch` that rethrows `UnauthorizedError`.
- [ ] **Step 4: Run** the test file, then `pnpm build`. Expected: PASS, `tsc` clean.
- [ ] **Step 5: Commit** (after approval) `feat(auth): verify Supabase access tokens against the project JWKS`.

### Task 4: Identity service

**Files:**
- Create: `src/modules/auth/identity-service.ts`
- Test: `test/integration/identity-service.test.ts` (Postgres only, no Docker)

**Interfaces:**
- Consumes: `AuthClaims` from Task 3; models from Task 2.
- Produces:
  ```ts
  export interface Principal { userId: string; tenantId: string; email: string }
  export class IdentityService {
    constructor(deps: { prisma: PrismaClient });
    resolve(claims: AuthClaims): Promise<Principal>;
  }
  ```

- [ ] **Step 1: Write failing tests**: first `resolve` creates one `User` (id = `userId`), one `Tenant` named `personal`, one `OWNER` `TenantMember`; second call returns the same `tenantId` and creates nothing; `Promise.all` of 10 concurrent calls for a new user leaves exactly one of each row and every call resolves with the same principal; a changed `email` in the claims updates `User.email`; two different users get different tenants.
- [ ] **Step 2: Run** `pnpm vitest run test/integration/identity-service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `resolve`**: look up the membership by `userId`; if absent, create user, tenant and membership in one transaction; on unique-violation (`P2002`) from a concurrent winner, re-read and return. Do not put the email in the tenant name. Update `email` only when it differs.
- [ ] **Step 4: Run** the test file. Expected: PASS.
- [ ] **Step 5: Commit** (after approval) `feat(auth): create user and personal tenant on first login`.

### Task 5: Server split, auth hook, CORS and rate limits

**Files:**
- Create: `src/http/operator-routes.ts` (the existing route block moved verbatim), `src/http/customer-auth.ts`
- Modify: `src/http/server.ts`, `package.json` (`@fastify/cors`, `@fastify/rate-limit`), `src/main.ts`
- Test: `test/integration/customer-auth.test.ts` (Postgres only; `FakeRuntime` from `test/helpers/fake-runtime.ts`)

**Interfaces:**
- Consumes: `createTokenVerifier`, `IdentityService`, `UnauthorizedError`.
- Produces:
  ```ts
  export interface CustomerAuthDeps { verify: (token: string) => Promise<AuthClaims>; identity: IdentityService }
  // buildServer deps gain: customer?: CustomerAuthDeps   (routes registered only when present)
  declare module 'fastify' { interface FastifyRequest { principal?: Principal } }
  export function registerCustomerAuth(app: FastifyInstance, deps: CustomerAuthDeps): void; // onRequest hook inside the customer plugin
  ```
  `main.ts` builds `customer` only when `config.supabaseUrl` is set; without it, customer routes do not exist (`404`).

- [ ] **Step 1: Write failing tests** (a test helper signs tokens with a local key and passes `keys` into `createTokenVerifier`): a stub customer route `GET /api/v1/me` returns `401` without a header, with `Basic ...`, with a 5 000 character header, with an expired token; returns `200` with a valid token. The `401` body equals `{ error: { code: 'unauthorized', message: 'Unauthorized' } }` and never contains the token. The admin token on `/api/v1/me` is `401`; a valid user token on `/api/v1/tenants/<id>/instances` is `401`. A request with `Origin: https://evil.example` gets no `access-control-allow-origin`; `Origin: https://cloud.nibie.app` (config `dashboardOrigin`) gets it and a preflight for `authorization, content-type, idempotency-key` succeeds. Log output captured from a failing request does not contain the token.
- [ ] **Step 2: Run** `pnpm vitest run test/integration/customer-auth.test.ts` and `pnpm vitest run test/integration/api.test.ts`. Expected: new tests FAIL; the operator tests PASS (baseline).
- [ ] **Step 3: Move the operator routes** into `registerOperatorRoutes(app, { service, config })` inside `server.ts`, keeping the `/api/v1` prefix and the admin `onRequest` hook scoped to that plugin; no behaviour change.
- [ ] **Step 4: Implement `registerCustomerAuth`** (parses `Bearer <token>` with a length cap, calls `verify` then `identity.resolve`, sets `request.principal`; any failure replies the opaque `401`). Register `@fastify/cors` with `origin: [config.dashboardOrigin]` (exact match, `credentials: false`; no CORS plugin when `dashboardOrigin` is null) and `@fastify/rate-limit` keyed by `principal.userId` (fall back to IP before auth), default 120 requests per minute. Set `Cache-Control: no-store` on customer responses.
- [ ] **Step 5: Wire `main.ts`**: build the verifier and identity service when `supabaseUrl` is set; log at startup (info) whether the customer API is enabled, never the URL's query or any key.
- [ ] **Step 6: Run** `pnpm build`, `pnpm vitest run test/integration/customer-auth.test.ts test/integration/api.test.ts`. Expected: all PASS.
- [ ] **Step 7: Commit** (after approval) `feat(http): add the customer auth surface next to the operator API`.

### Task 6: Customer routes and the provisioning gate

**Files:**
- Create: `src/http/customer-routes.ts`
- Modify: `src/http/server.ts` (register the plugin), `src/modules/instances/instance-service.ts` (`provision` accepts an optional `maxInstances` check, see Step 3)
- Test: `test/integration/customer-api.test.ts` (Postgres only, `FakeRuntime`)

**Interfaces:**
- Consumes: `request.principal` (Task 5), `InstanceService` (`provision`, `list`, `get`, `events`, `start`, `stop`, `restart`, `delete`).
- Produces routes under `/api/v1`: `GET /me` → `{ id, email, tenantId }`; `GET /plans` → `{ plans: [{ id, slug, name, cpuMillis, memoryMb, storageMb, pids, monthlyPriceIdr: null }] }` (active plans, ordered by `cpuMillis` then `slug`); `POST /instances` (body `{ name, planId }` strict, `Idempotency-Key` 1-128 chars) → `202 { instance }`; `GET /instances`, `GET /instances/:id`, `GET /instances/:id/status`, `GET /instances/:id/events`; `POST /instances/:id/start|stop|restart` and `DELETE /instances/:id` → `202 { instance }`. Response shapes equal the operator API's `InstanceView`.
  Gate: `POST /instances` is `403 { error: { code: 'provisioning_not_enabled', ... } }` unless the principal's email is in `config.betaAllowedEmails`; over `config.maxInstancesPerTenant` non-`DELETED` instances (an idempotent replay of an existing key does not count) is `409`. Provisioning is rate limited to 5 requests per 10 minutes per user.

- [ ] **Step 1: Write failing tests**:
  - `GET /me` returns the principal; `GET /plans` returns only active plans and never `price` fields other than `monthlyPriceIdr: null`.
  - Happy path with `FakeRuntime`: allowed user provisions (`202`), lists one instance, reads `/status` and `/events`, restarts, stops, starts, deletes.
  - Gate: a user not in `betaAllowedEmails` gets `403 provisioning_not_enabled`; an empty allowlist denies everyone (fail closed); a second instance over the default cap of 1 is `409`; replaying the same `Idempotency-Key` returns the original instance and is not blocked by the cap; reuse with another body is `409`.
  - Validation: missing `Idempotency-Key`, body `{ name: 1 }`, extra body fields, and a non-UUID `planId` are `400`.
  - **Cross-tenant matrix (Review Focus 4):** user B calls `GET /instances/:idOfA`, `/status`, `/events`, `POST start|stop|restart`, `DELETE` and gets `404` each time, user A's instance status is unchanged, and user B's `GET /instances` does not list it. A malformed id is `404`, not `400`.
  - The sixth provisioning request within 10 minutes is `429`.
- [ ] **Step 2: Run** `pnpm vitest run test/integration/customer-api.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `registerCustomerRoutes(app, { service, prisma, config })`.** The cap check counts `instance.count({ where: { tenantId, status: { not: 'DELETED' } } })` in the route, before `service.provision`, and skips the check when `prisma.instance.findFirst({ where: { tenantId, idempotencyKey } })` already exists, so replays stay idempotent. No change to `InstanceService` is needed unless the replay check proves racy in tests; if it does, move both checks into `provision` behind an optional `maxInstances` argument and keep the operator API's behaviour unchanged (no cap).
- [ ] **Step 4: Run** `pnpm build` and `pnpm test:integration`. Expected: all PASS, including the untouched operator and Docker tests.
- [ ] **Step 5: Commit** (after approval) `feat(http): add tenant-scoped customer API for instances, plans and account`.

### Task 7: Documentation and handoff

**Files:**
- Modify: `docs/architecture.md` (API surfaces, data model, known gaps 5 and 10), `docs/setup.md` (new variables; Supabase project checklist: asymmetric signing keys, "Confirm email" enabled, restrict signups to invited users, access-token lifetime, redirect URLs including `https://cloud.nibie.app/dashboard/...`), `docs/CURRENT_STATE.md`, `docs/README.md` (index the new spec and plan), `AGENTS.md` only if the commands or architecture summary change
- Test: none (docs); run the full suite as verification.

- [ ] **Step 1: Update the docs** above, including a "Supabase Postgres" section in `docs/setup.md`: connection string with `?schema=hermes`, direct or session connection for `pnpm db:migrate`, RLS enabled on the `hermes` tables, confirm `hermes` is not in the Data API's exposed schemas, and a dedicated database role for the backend instead of the `postgres` superuser (role name and password are never written in the repository). State plainly what is verified (unit and integration runs with the exact counts from this task's runs), what is not (no real Supabase project was used: tokens in tests are signed locally; no run on the production VPS), and the contract gaps from spec 4.1 so the frontend thread can act on them.
- [ ] **Step 2: Run** `pnpm build && pnpm test`. Expected: `tsc` clean; all unit and integration tests pass. Record the numbers in `docs/CURRENT_STATE.md`.
- [ ] **Step 3: Commit** (after approval) `docs: record milestone A in architecture, setup and current state`.
