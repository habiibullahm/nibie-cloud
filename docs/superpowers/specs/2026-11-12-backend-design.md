# Hermes Cloud backend: customer API, auth, async jobs, secrets and billing

Date: 2026-11-12
Status: draft for review (not approved, nothing implemented, nothing committed)
Source of truth for scope: [../../prd.md](../../prd.md). Builds on the runtime foundation on `main`
(`src/modules/instances`, `src/modules/runtime`, operator API in `src/http/server.ts`).

## 1. Problem

`main` has the data plane: provision, start, stop, restart, delete and automatic recovery of one
hardened container per instance. The control plane the PRD requires around it is missing:

- No customer identity. The only API is operator-only (one shared `ADMIN_TOKEN`, loopback, tenant id in
  the URL). The dashboard reaches it through a dev bridge that pins one tenant.
- No plans endpoint, no subscriptions or payments, so nothing gates who may create instances.
- Provisioning runs synchronously in the HTTP request (`InstanceService.provision`); there is no queue.
- No provider (NibieRouter/BYOK) or Telegram configuration, no secrets handling, no logs or usage.

This spec fixes the stack and the order of work. It is split into four milestones, each with its own
plan, so Nash can stop or re-order after any of them.

## 2. Decisions

Confirmed by Nash on 2026-11-12:

| Topic | Decision |
| --- | --- |
| Auth | Supabase Auth. |
| Payments | Duitku (https://www.duitku.com/), product **Duitku POP** (hosted payment page, `createInvoice`). |
| Email | SumoPod SMTP (`smtp.sumopod.com`; replaced Resend on 2026-11-14). Sender must be on a domain verified in SumoPod (proposed `no-reply@nibie.app`, to confirm); Nash's business Gmail address is a Reply-To or support contact only and is not written in the repository. |
| Domain | `nibie.app`; the product lives under `cloud.nibie.app`; DNS and the dashboard run on Cloudflare. `cloud.nibie.app` is reserved for a future landing page; the customer dashboard is served at `cloud.nibie.app/dashboard`. |
| Queue | Redis + BullMQ (PRD 6.2). |
| Ingress | Reverse proxy with a subdomain per instance (PRD 6.2). |

Recommended defaults, **not yet confirmed**: see section 9. Anything marked "assumed" below depends on them.

Stack (PRD 6.2, unchanged): Node >= 22, TypeScript (ESM), Fastify 5 REST under `/api/v1`, PostgreSQL +
Prisma, Redis + BullMQ, Docker runtime nodes, pinned official Hermes image. The backend stays one
modular monolith (ADR 0001): one codebase, an API process and a worker process.

## 3. Architecture

```
 Browser (cloud.nibie.app/dashboard, Cloudflare)
   |  Supabase JS signs in, holds the session
   |  Authorization: Bearer <Supabase access token>, CORS allowlist = dashboard origin
   v
 api.cloud.nibie.app  (reverse proxy -> Fastify API, public)
   |  verifies the JWT locally (Supabase JWKS), maps sub -> User -> Tenant membership
   |  /api/v1/me, /plans, /instances...             (customer routes, section 5)
   |  /api/v1/webhooks/payments/duitku              (milestone D, signature-verified)
   |  /api/v1/tenants/:tenantId/instances...        (operator routes, admin bearer, unchanged)
   v
 InstanceService / Reconciler (existing)  <--- BullMQ worker (milestone B)
   v
 RuntimeManager interface -> Docker Engine (dockerode)      PostgreSQL, Redis
```

Principles carried over from the PRD and the existing code:

- **Tenant id is never taken from the client** (PRD 6.3). Customer routes resolve the tenant from the
  verified user's membership; a foreign or malformed id is a `404`, identical to a missing one
  (`findOwned` already behaves this way).
- **Two API surfaces, two auth schemes.** Customer routes accept Supabase tokens only; operator routes
  accept `ADMIN_TOKEN` only. They are registered in separate Fastify plugins so a hook of one cannot
  leak onto the other. The operator API keeps binding to loopback (assumed: the public reverse proxy
  does not route `/api/v1/tenants/*`; milestone A adds a test that the customer listener never serves
  operator paths, see the plan).
- **The runtime manager stays the only Docker client.** New read-only methods (logs, stats) go on the
  `RuntimeManager` interface in a separate file; the container create path (`hardening.ts`,
  `docker-runtime-manager.ts` `ensure`) belongs to the disk-quota/egress thread and is not touched.

## 4. Milestones

| | Scope | PRD references | Plan |
| --- | --- | --- | --- |
| **A** | Supabase token verification, `User` + `TenantMember`, personal tenant on first login, customer API (`/me`, `/plans`, `/instances...`), CORS, rate limits, beta provisioning gate, per-tenant instance cap, cross-tenant authorization tests | 6.3, 14, 15.1 (see 4.1), 15.3, 15.8 | [plan A](../plans/2026-11-12-backend-milestone-a-auth-customer-api.md) |
| **B** | Redis + BullMQ: provision/start/stop/restart/delete as jobs (`202` + job id), bounded retries with backoff and jitter, dead-letter queue, idempotent jobs, outbox for state events; reconciler loop moves to a repeatable job with a single-leader guarantee | 11, 13.2, 15.8 | after A is approved |
| **C** | `SecretStore` (envelope encryption, key version, never returned), provider config (NibieRouter placeholder, BYOK with SSRF-validated base URL), Telegram token validate/store/replace/revoke, read-only logs (redacted) and usage from Docker stats | 7.3, 7.4, 8, 9, 15.4, 15.5 | after B |
| **D** | Plans with prices, subscriptions, Duitku checkout and callback, payment events, grace/suspension/retention jobs, renewal, cancel | 5, 10, 11.3, 15.2 | after C |

Not in this spec (each needs its own spec because it is security-heavy or depends on another thread):
backups and restore, file manager, web console, operator console, custom domains, scheduler for more
than one node, container disk quota and egress (other thread).

### 4.1 Endpoint mapping to the dashboard contract

The dashboard's typed client lives in `apps/web/src/lib/api`. Mapping, by milestone:

| Frontend call | Backend | Milestone |
| --- | --- | --- |
| `instances.list/get/status/events/create/start/stop/restart/remove` | `GET/POST /instances`, `/instances/:id`, `/status`, `/events`, `/start|stop|restart`, `DELETE /instances/:id` (customer, tenant from session) | A |
| `preview.me` | `GET /me` | A |
| `preview.plans` | `GET /plans` | A |
| `preview.logs`, `preview.usage` | `GET /instances/:id/logs`, `/usage` | C |
| `preview.provider*`, `preview.telegram*` | PRD 15.4 and 15.5 routes | C |
| `preview.subscription`, checkout, cancel, renew, upgrade | PRD 15.2 routes | D |
| `preview.regions`, `meta`, `access`, `files`, `fileContent`, `backups`, `createBackup`, console | not backed by this spec | later |

Known contract gaps (to be fixed on one side or the other, not papered over):

- The dashboard's `Plan` type has `name`, `backupRetentionDays`, `customDomain`, `monthlyPriceIdr`. The
  database has no source for the first three and pricing is not approved. Milestone A adds `Plan.name`
  and returns `monthlyPriceIdr: null`; `backupRetentionDays` and `customDomain` are **omitted** and the
  dashboard type must make them optional (a small change in `apps/web`, owned by the frontend thread).
- The dashboard `Instance` type matches `InstanceView` today. `accessUrl` is `http://127.0.0.1:<port>`
  until the subdomain ingress exists; it must not be shown to customers as a real URL. Milestone A
  keeps it as is and flags it in the docs.
- Mutating customer routes return `202` with `{ instance }` (as the operator API does). Milestone B
  adds `jobId` to the body without removing `instance`.

## 5. Milestone A design

### 5.1 Verifying a Supabase session

Facts from the Supabase docs read on 2026-11-12 (https://supabase.com/docs/guides/auth/jwts,
`/signing-keys`, `/jwt-fields`):

- With asymmetric signing keys, tokens are verified against
  `GET <SUPABASE_URL>/auth/v1/.well-known/jwks.json`. The docs say it returns no keys for a project that
  does not use asymmetric signing keys, and recommend against verifying legacy HS256 tokens with the
  shared secret.
- Required claims include `iss`, `aud`, `exp`, `sub`, `role`, `email`, `session_id`; user tokens carry
  `"aud": "authenticated"`. `user_metadata` must not be used for authorization.
- The edge caches the JWKS for 10 minutes; the docs say not to cache it longer in the application.

Design:

- Library: `jose` (`createRemoteJWKSet` + `jwtVerify`), which the Supabase docs themselves use as the
  example. New module `src/modules/auth/token-verifier.ts` exposes
  `createTokenVerifier(opts): (token: string) => Promise<AuthClaims>` where
  `AuthClaims = { userId: string; email: string }`.
- Pinned checks: algorithm allowlist (asymmetric only: `ES256`, `RS256`, `EdDSA`; never `none` or
  `HS*`), `issuer = <SUPABASE_URL>/auth/v1`, `audience = "authenticated"`, `exp` enforced (small clock
  tolerance), `sub` must be a UUID, `email` required. Any failure is a single opaque `401 unauthorized`.
- Tests inject a local key resolver, so no network and no Supabase project are needed.
- **Email verification.** The docs say unverified users cannot sign in by default, and that
  `email_confirmed_at` is a user-object attribute; it is **not** in the JWT claims reference. The backend
  therefore cannot check it from the token. Requirement for Nash: keep "Confirm email" enabled in the
  Supabase project (recorded in `docs/setup.md`). If a hard guarantee is wanted, add a check through the
  Supabase admin API in a later change.
- **Revocation.** A deleted or signed-out user's access token stays valid until `exp`. Mutating routes
  accept this window; the access-token lifetime is a Supabase setting (record the value in setup docs).
  Account deletion is out of scope.
- No Supabase secret key is needed by the backend in milestone A. The dashboard only ever holds the
  publishable key. A secret (`sb_secret_...`) key, if added later, is server-only and never in the
  repository.

### 5.2 Users and tenants

New Prisma models (migration `add_users_and_membership`):

```prisma
model User {
  id        String   @id @db.Uuid          // = Supabase `sub`; not generated here
  email     String
  createdAt DateTime @default(now()) @db.Timestamptz(3)
  members   TenantMember[]
}

enum TenantRole { OWNER }                   // PRD 14 has roles; only OWNER exists in the beta

model TenantMember {
  tenantId String     @db.Uuid
  userId   String     @db.Uuid
  role     TenantRole @default(OWNER)
  tenant   Tenant     @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  user     User       @relation(fields: [userId], references: [id], onDelete: Restrict)
  @@id([tenantId, userId])
  @@unique([userId])                         // beta: one user = one tenant (assumed, see 9)
}
```

`Plan` gains `name String`. `Tenant` is unchanged.

Identity is created lazily by `IdentityService.resolve(claims)`: on the first verified request it
creates the `User`, a personal `Tenant` (named after the email local part is **not** done: the name is
`personal`, so no personal data lands in tenant names) and the `OWNER` membership in one transaction.
It is idempotent and race-safe: a unique-violation from a concurrent first request is caught and the
rows re-read. A database trigger on `auth.users` is rejected because a failing trigger blocks signups
(Supabase docs, "managing user data").

The email is stored only as a display convenience for `GET /me` and support lookups; it is refreshed
from the token on each login when it differs. It is never used for authorization.

### 5.3 Customer routes

All under `/api/v1`, Bearer Supabase token required, resolved principal `{ userId, tenantId }` attached
to the request.

| Route | Behaviour |
| --- | --- |
| `GET /me` | `{ id, email, tenantId }`. The dashboard `Account` type also has `name`; there is no source for it, so the dashboard shows the email (contract gap, section 4.1). |
| `GET /plans` | Plans where `active = true`, resource limits only plus `monthlyPriceIdr: null`. |
| `POST /instances` | `Idempotency-Key` required (existing rules); body `{ name, planId }` strict. Gated by 5.4. `202 { instance }`. |
| `GET /instances`, `GET /instances/:id`, `/status`, `/events` | Existing `InstanceService` calls with the principal's tenant. |
| `POST /instances/:id/start|stop|restart`, `DELETE /instances/:id` | Same, `202 { instance }`. |

Response shapes are exactly those of the operator API (`InstanceView`), so `apps/web` live mode only
changes its base URL and sends the token instead of using the dev bridge.

Cross-cutting: CORS allowlist from `DASHBOARD_ORIGIN` (exact match, no wildcard, bearer tokens only, no
cookies); per-principal rate limits (`@fastify/rate-limit`: provisioning is stricter than reads; the
exact numbers are in the plan); `Cache-Control: no-store`; errors keep the existing
`{ error: { code, message } }` envelope with sanitized messages.

### 5.4 Gate until payments exist (milestone D)

Without payments, any person who can sign up could create containers on the VPS. Until milestone D:

- `POST /instances` is allowed only when the user's email is in `BETA_ALLOWED_EMAILS` (comma-separated,
  case-insensitive, read from the environment, never committed). Empty or unset means nobody can
  provision (fail closed). Reads and the other actions stay open to the owner of the instance.
- `MAX_INSTANCES_PER_TENANT` (default `1`) caps non-`DELETED` instances; over the cap is `409`.
- Supabase email signups should also be restricted to invited users in the Supabase project settings
  (recorded in setup docs; not enforceable from this backend).

Milestone D replaces the allowlist with "active paid subscription".

## 6. Milestone B, C, D design notes (decided at design level, detailed in their own plans)

**B (jobs).** One BullMQ queue `instance-ops` with job types `provision|start|stop|restart|delete`, job id
`<instanceId>:<op>:<idempotencyKey|attempt>`, payload = ids only (no secrets, PRD 7.4). The worker calls the
existing `InstanceService` steps, which already provide leases, fencing and compare-and-set transitions;
the queue adds retry (bounded, exponential backoff with jitter), a dead-letter queue and operator retry.
An outbox table publishes critical events. The reconciler becomes a repeatable job guarded by a Redis
lock so several API replicas are safe. Redis settings: AOF persistence, `maxmemory-policy noeviction`
(BullMQ requirement). Existing integration tests stay green; the HTTP contract gains `jobId`.

**C (secrets, providers, Telegram).** `SecretStore` interface: `put(plaintext) -> secretRef`,
`get(secretRef)` (worker-side only), `rotate`, `revoke`. Envelope encryption: a per-secret data key
(AES-256-GCM) wrapped by a key-encryption key identified by a version; ciphertext, wrapped key and
version are stored, never plaintext. KEK source for the beta: an environment variable outside the
database (assumed; a KMS/Vault adapter later). API responses expose a `keyHint` (last four characters)
at most. Provider base URLs are validated (https only, DNS resolved at connection time, loopback,
private, link-local, reserved and metadata ranges refused); network-level egress policy belongs to the
other thread. Logs are served from the runtime manager with a redaction pass. NibieRouter: no API
facts exist in the repository, so only BYOK is built until Nash supplies them. Telegram: validate the
token with Telegram's bot identity endpoint, store it as a secret, inject it into the instance on the
next container creation; transport polling or webhook depends on what the pinned Hermes image supports
(to be checked before the plan).

**D (Duitku).** Facts from https://docs.duitku.com/pop/id/ and https://docs.duitku.com/api/id/ (read
2026-11-12; the docs mix Indonesian and English and contradict themselves in places, so every item is
verified against the sandbox before relying on it):

- Two products exist: Duitku POP (`createInvoice`, hosted page) and the V2 API (`inquiry`, custom page).
  Their endpoints and request signatures differ. **Nash chose POP** (2026-11-12); V2 details are not used.
- POP create: `POST https://api-sandbox.duitku.com/api/merchant/createInvoice` (production
  `https://api-prod.duitku.com/api/merchant/createInvoice`), headers `x-duitku-signature`,
  `x-duitku-timestamp`, `x-duitku-merchantcode`; signature = HMAC-SHA256 over `merchantCode + timestamp`
  with the API key, lowercase hex. `merchantOrderId` max 50 chars, new for every transaction.
- Callback: `POST`, `application/x-www-form-urlencoded`, public URL on port 80/443. Verify
  `HMAC-SHA256(merchantCode + amount + merchantOrderId, apiKey)` against `signature` with a constant-time
  comparison. Respond `200`; Duitku retries and emails after five failures. **No unique event id** is
  documented, so idempotency keys on `(merchantOrderId, reference, resultCode)` in a unique constraint on
  `PaymentEvent`. The docs list the failure `resultCode` as `01` in one table and `02` in another.
- Never trust the browser redirect or JS callback (the docs say so too); activation only from a verified
  callback or a status check. The status-check endpoint is documented for V2 only; whether POP merchants
  can use it is unconfirmed.
- Amounts are integer IDR, minimum 10000 IDR (error text in the docs), QRIS invoices expire in at most 60
  minutes. Duitku publishes IP addresses for callbacks; allowlisting them is an option, not a substitute
  for signature verification.
- **No recurring billing is documented** (subscription fields were added and then removed in the V2
  changelog). Design: each renewal is a new invoice created ahead of expiry, with reminders sent over SumoPod SMTP
  email; the grace period (3 days) and retention (30 days) are PRD 10.1.
- Money is stored as integer rupiah (PRD 14.1). Pricing stays `null` until Nash approves it (PRD 5.2);
  the sandbox uses a clearly marked test price and production checkout stays disabled.

## 7. Configuration (new environment variables)

| Variable | Milestone | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | A | Required for the customer API. `https://<project-ref>.supabase.co`. |
| `DASHBOARD_ORIGIN` | A | Exact origin, no path: `https://cloud.nibie.app` (the `/dashboard` path does not change the origin). |
| `BETA_ALLOWED_EMAILS` | A | Comma-separated; unset means nobody may provision. |
| `MAX_INSTANCES_PER_TENANT` | A | Default `1`. |
| `REDIS_URL` | B | |
| `SECRETS_KEK` (+ version) | C | >= 32 bytes, outside the database. |
| `SUMOPOD_SMTP_HOST`, `SUMOPOD_SMTP_PORT`, `SUMOPOD_SMTP_USER`, `SUMOPOD_SMTP_PASS`, `MAIL_FROM` | D | SumoPod SMTP replaced Resend on 2026-11-14. All five or none; parsed already, first used in D. Secrets live in the host environment, never the repo. |
| `DUITKU_MERCHANT_CODE`, `DUITKU_API_KEY`, `DUITKU_ENV` | D | `sandbox` or `production`. |

`.env.example` gets placeholders only. The repository is public: no real value is ever committed.

## 8. Security and testing

- Every customer route has a cross-tenant test (user A gets `404` for user B's instance ids, for each
  verb). This is the PRD 19 P0 item "tenant authorization is tested for every customer-facing endpoint".
- Token tests: missing, malformed, expired, wrong issuer, wrong audience, wrong algorithm (`none`,
  `HS256` signed with the public key), unknown `kid`, non-UUID `sub`.
- Operator and customer surfaces are tested against each other: an admin token on a customer route, and a
  user token on an operator route, are both `401`.
- Logs: the `Authorization` header is already in `REDACT_PATHS`; tests assert that a token never appears
  in log output. Responses never contain host paths, container ids or secrets.
- Unit tests need no Docker or database. Integration tests keep using Postgres and the stub image;
  milestone B adds Redis to the integration environment and to `compose.yaml`.

## 9. Open decisions for Nash (not invented; recommended default in brackets)

1. VPS: **known** from read-only checks Nash ran on 2026-11-12 (no IP recorded here): Tencent Cloud,
   Jakarta, KVM guest, Ubuntu 24.04.4 LTS, kernel 6.8.0-138-generic, 4 vCPU, about 16 GB RAM, 2 GB swap,
   one ext4 root partition of 217 GB (`/var/lib/docker` on it, no XFS or project quota), cgroup v2 with
   the systemd driver, Docker 29.9.3 (storage `overlayfs`) with runtimes `runc` and `runsc` registered
   (gVisor release-20261109.0), `ufw` active with only SSH (22) allowed, no Postgres, Redis, Caddy, nginx
   or Traefik installed. One container named `hermes-agent` already exists (purpose not yet confirmed
   with Nash). Plan: one VPS for the beta running API, worker, Redis, a reverse proxy and the first
   runtime node; `RuntimeNode` rows ready for more. Consequences: ports 80 and 443 must be opened in
   `ufw` and in the provider's own firewall; earlier runtime tests ran on cgroup v1, so the isolation
   checks need a re-run on this host (other thread); the deploy user needs Docker access through a
   dedicated service user, not the interactive `ubuntu` login.
2. Where Postgres runs: **Supabase managed Postgres, decided** (Nash, 2026-11-12: "all managed by
   supa"). App tables go in a dedicated schema (`hermes`, via `?schema=hermes` on `DATABASE_URL`), not
   `public`, because the Supabase Data API exposes `public` by default (to be verified in the project's
   API settings); RLS is also enabled on those tables as defense in depth. Open checks: the Supabase
   region relative to the VPS, Prisma through the pooler (migrations need a direct or session
   connection), and the plan's limits. Local development and CI keep using the Postgres container from
   `compose.yaml`.
3. Public URL layout. Decided: `cloud.nibie.app` is the future landing page and the dashboard is at
   `cloud.nibie.app/dashboard`; the API and the Duitku callback are at `api.cloud.nibie.app` (Nash,
   2026-11-12). Still to confirm: [`<short-id>.cloud.nibie.app` for instances with reserved names such as
   `api` and `www`.]
   Cloudflare's free Universal certificate covers one subdomain level only (to be verified), so proxying
   deeper names needs a paid certificate or DNS-only records with certificates issued on the VPS via the
   DNS API. Consequences of the `/dashboard` path: `apps/web` needs a Next.js `basePath` of `/dashboard`
   (a frontend-thread change; today its routes are at the root), the Supabase redirect URLs must include
   `https://cloud.nibie.app/dashboard/...`, and the Cloudflare route for `/dashboard*` must point at the
   dashboard while `/` stays free for the landing page.
4. Whether the Supabase project uses asymmetric signing keys (required by section 5.1) and where it is
   hosted.
5. One user = one tenant for the beta, several instances per tenant allowed but capped by
   `MAX_INSTANCES_PER_TENANT`. [Yes, default cap 1.]
6. The beta provisioning gate in 5.4 (email allowlist). [Yes.]
7. Duitku: POP is decided. Still open: whether a sandbox merchant account exists, who owns production
   onboarding, and whether POP merchants can call the status-check endpoint (documented for V2 only).
8. NibieRouter API facts. Nash said (2026-11-12) NibieRouter exists but has no docs, and pointed at
   https://docs.sumorouter.com/introduction as the reference. **Confirmed by Nash (2026-11-12):**
   NibieRouter is a SumoRouter instance at `https://router.nibie.app/v1`, running on a separate server
   from the Nibie Cloud VPS. From those docs: OpenAI/Anthropic-compatible `https://<host>/v1`;
   `sk-...` keys with per-key credit limit, model allowlist, expiry and rpm, revocable; keys created via
   the dashboard or `POST /api/keys` with a session JWT (`POST /api/auth/login`, 7-day validity); usage
   via `/api/usage/*` filterable by key (nano-USD); sub-accounts and a balance endpoint were not found.
   Design idea for milestone C (unverified): one NibieRouter key per tenant created from a service
   account, usage attributed by key. Still needed: a service account for Hermes Cloud. [BYOK first; NibieRouter adapter after confirmation.]
13. Documentation site: Nash decided Hermes Cloud product docs are a separate site at
    `cloud.nibie.app/docs`, built after the backend (not part of the dashboard or milestone A).
9. Backups object storage: **Cloudflare R2, decided** (Nash, 2026-11-12). Key source for secrets still
   open. [Environment KEK for the beta.]
10. CI/CD and monitoring. [GitHub Actions with Postgres and Redis services; pino JSON logs plus a
    `/metrics` endpoint, Prometheus and Grafana once there is a node.]
11. Telegram transport. [Polling, subject to what the pinned Hermes image supports.]
12. Pricing. Stays unset (PRD 5.2); sandbox test price only.

## 10. Out of scope and coordination

- Disk quota, egress controls, gVisor validation: the "Spec disk quota and egress controls" thread owns
  `hardening.ts` and the container create path. This spec only adds read-only runtime methods in a new file.
- No frontend change is made by this spec. The two contract gaps in 4.1 are reported to the frontend thread.
- Nothing here is production-ready on its own; the known gaps in `docs/architecture.md` that this spec does
  not address (isolation, quota, egress, backups, multi-node) remain open.
