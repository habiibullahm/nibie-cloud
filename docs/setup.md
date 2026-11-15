# Setup

## Prerequisites

- Node.js 22+, pnpm 10
- A **Linux Docker daemon** reachable at `/var/run/docker.sock` (Docker Engine, or Docker Desktop with Linux containers)
- PostgreSQL 16 and Redis 7 (both provided by `compose.yaml`; Redis is optional in development, see Job queue)
- For production-like runs with `HERMES_DISK_QUOTA=enforce` (the default): Docker's data root on **XFS mounted with project quotas** (see below)

## First run

```bash
pnpm install                          # also runs `prisma generate`
docker compose up -d postgres redis   # Postgres 127.0.0.1:5433, Redis 127.0.0.1:6380, dev credentials only
cp .env.example .env                  # git-ignored; set ADMIN_TOKEN (>= 24 chars): openssl rand -hex 24
                                      # and HERMES_MASTER_KEY (>= 32 chars): openssl rand -hex 32
pnpm db:migrate                       # applies prisma/migrations to DATABASE_URL
```

Tests use a separate database:

```bash
docker compose exec postgres psql -U hermes -d hermes -c "CREATE DATABASE hermes_test"
DATABASE_URL=postgresql://hermes:hermes_dev_only@127.0.0.1:5433/hermes_test pnpm db:migrate
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm build` | Type-check (no emit) |
| `pnpm test:unit` | Pure logic tests (no Docker/DB) |
| `pnpm test:integration` | Real Postgres, Docker and Redis (builds the stub image on first run). Set `REDIS_URL` for the job tests; they fail loudly without it |
| `pnpm test` | Everything. Integration tests clean up the containers/volumes/networks they create |
| `pnpm demo [--keep]` | End-to-end proof run through the API using the stub image |
| `pnpm dev` | Starts the operator API on `127.0.0.1:$PORT` and the reconciler (15 s loop; a scheduled job when `REDIS_URL` is set) |

## Configuration

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `HERMES_IMAGE` | Pinned image. Tag != `latest` in dev/test; `name@sha256:<digest>` required when `NODE_ENV=production`. Startup fails otherwise |
| `ADMIN_TOKEN` | Bearer token for the operator API (>= 24 chars). Never logged |
| `PORT` | Default 3000. The API always binds `127.0.0.1` |
| `DOCKER_SOCKET_PATH` | Default `/var/run/docker.sock` |
| `HERMES_MASTER_KEY` | Required, at least 32 characters (`openssl rand -hex 32`). Every instance's `API_SERVER_KEY` is derived from it (HMAC-SHA256 with the instance id); it is never stored or logged. Changing it makes running instances reject the new keys: the Reconciler marks them `DEGRADED` (`auth_rejected`) without restarting them, and they stay that way until their containers are recreated (see below) |
| `HERMES_DISK_QUOTA` | `enforce` (default) or `off`. `enforce` creates every tenant volume with `Plan.storageMb` as its size limit and refuses to run a volume that has none. `off` is rejected when `NODE_ENV=production` |
| `HERMES_DISK_CHECK_INTERVAL_MS` | Default `300000` (5 minutes), minimum `1000`. How often the DiskMonitor reads volume usage and records `disk.warning`, `disk.full` and `disk.ok` events |
| `HERMES_EGRESS_POLICY` | `enforce` (default) or `off`. `enforce` names every tenant bridge `hn<12 hex>`, refuses a network without that name (`network_policy_missing`) and runs the startup canary. `off` is rejected when `NODE_ENV=production` |
| `HERMES_CANARY_IMAGE` | Required when `HERMES_EGRESS_POLICY=enforce` **or `HERMES_RUNTIME=runsc`**: an image with `sh` and `nc`, pinned as `name@sha256:<64 hex>` (a tag is rejected). Under `runsc` it is also used to seed the tenant `resolv.conf` volume (see `HERMES_DNS_RESOLVERS` below). It is not pulled for you: `docker pull` it first |
| `HERMES_CANARY_PRIVATE_IP` | Optional IPv4 address of this host. If set, the canary also checks that a tenant cannot reach it |
| `SUPABASE_URL` | Optional. `https://<project-ref>.supabase.co` (https, no path). Enables the customer API; unset means the customer routes do not exist |
| `DASHBOARD_ORIGIN` | Optional. Exact browser origin of the dashboard, no path (`https://cloud.nibie.app`, even though the dashboard is served under `/dashboard`). The only origin granted CORS; unset sends no CORS headers |
| `BETA_ALLOWED_EMAILS` | Comma-separated emails allowed to create instances until payments exist. Empty or unset: nobody can (fail closed). Set it in the host environment only, never in the repository |
| `MAX_INSTANCES_PER_TENANT` | Default `1`. Non-deleted instances a tenant may hold through the customer API (the operator API has no cap) |
| `HERMES_RUNTIME` | `runc` (default) or `runsc` (gVisor). With `runsc`, startup fails if the Docker daemon does not list that runtime. Applies only to containers created from now on |
| `HERMES_DNS_RESOLVERS` | Space- or comma-separated IPv4 DNS resolvers for every tenant container. **Required when `HERMES_RUNTIME=runsc`**: Docker's own embedded resolver is not reachable from inside a gVisor sandbox, and giving it only as Docker `Dns` is not enough either (verified on a real host, 2026-11-13 and 2026-11-14: `Dns` only changes what the embedded resolver forwards to, not what the container itself queries). At startup, `HERMES_CANARY_IMAGE` seeds a shared Docker volume (`hermes-dns-resolv-conf`) with these resolvers, and every `runsc` tenant container bind-mounts that one file over its own `/etc/resolv.conf`, bypassing the embedded resolver entirely. Under `runc` the resolvers are only given as Docker `Dns` (harmless, reachable there); unset keeps the embedded resolver. A resolver on a private address also needs a matching entry in `ops/egress/egress.conf`'s `RESOLVERS`, or the host ruleset blocks it. Applies only to containers created from now on, like `HERMES_RUNTIME` |
| `SECRETS_KEK` | Base64 of exactly 32 random bytes (`openssl rand -base64 32`). The key-encryption key for customer credentials (provider API keys, Telegram bot tokens). Required when `NODE_ENV=production`; without it the credential routes answer `503 secrets_unavailable` and no instance gets a credential. Host environment only, never the repository. See [Secrets](#secrets-provider-keys-and-telegram) |
| `SECRETS_KEK_VERSION` | Positive integer, default `1`. The version number stored beside every secret sealed with `SECRETS_KEK` |
| `SUMOPOD_SMTP_HOST`, `SUMOPOD_SMTP_PORT`, `SUMOPOD_SMTP_USER`, `SUMOPOD_SMTP_PASS`, `MAIL_FROM` | All five or none. SumoPod SMTP for the billing emails (port 465 uses implicit TLS, any other port STARTTLS). Unset: the backend sends no email; billing still works and the notice is retried once mail is configured |
| `DUITKU_MERCHANT_CODE`, `DUITKU_API_KEY`, `DUITKU_CALLBACK_URL` | All three or none (billing off: checkout, the billing routes and the callback answer 404). Needs `DASHBOARD_ORIGIN` too (the invoice's return URL). Host environment only, never the repository. See [Billing](#billing-duitku-pop) |
| `NIBIEROUTER_ADMIN_KEY`, `NIBIEROUTER_DEFAULT_MODEL` | Both or neither. Turns on the NibieRouter user, per-instance key and one-time credit for paid instances (needs `SECRETS_KEK`). Host environment only. See [NibieRouter](#nibierouter-key-and-credit) |
| `NIBIEROUTER_API_URL`, `NIBIEROUTER_USER_EMAIL_DOMAIN` | Optional. Router origin (https, default `https://router.nibie.app`) and the domain of the synthetic per-tenant router user address (default `cloud.nibie.app`) |
| `DUITKU_ENV` | `sandbox` (default) or `production`. `production` is refused unless `NODE_ENV=production` |
| `SECRETS_KEK_PREVIOUS`, `SECRETS_KEK_PREVIOUS_VERSION` | Only during a KEK rotation: the old key and its version (both required together, and the version must differ from the current one) |

## Job queue (Redis and BullMQ)

With `REDIS_URL` set, create/start/stop/restart/delete are BullMQ jobs: the API answers `202` with the
instance and a `jobId`, a worker in the same process runs the operation, and the reconciler plus a
sweeper for stranded `PENDING` instances run as a scheduled job guarded by a Redis lock (several API
replicas are safe). Without `REDIS_URL` everything runs inline in the request as before (`jobId` is
`null`); `REDIS_URL` is **required when `NODE_ENV=production`**.

- Redis settings the queue needs: AOF (`--appendonly yes`) and `--maxmemory-policy noeviction`; bind it to
  loopback and set a password (`redis://:<password>@127.0.0.1:6380`). `compose.yaml` does this for development.
- Retries: up to 4 attempts with exponential backoff and jitter (2 s × 2ⁿ, cap 60 s) for transient errors
  (runtime or database outages); wrong-state, missing-row and malformed jobs fail at once. Exhausted jobs stay
  in the failed set for 7 days: `GET /api/v1/jobs/failed` and `POST /api/v1/jobs/failed/:jobId/retry`
  (operator API; reasons are error class names, never messages).
- Redis down: stop/start/restart/delete answer `503 queue_unavailable` and change nothing; creating an
  instance still answers `202` with `jobId: null` and the sweeper enqueues it when Redis is back.
- If Redis loses its data, the schedule is re-registered within 60 s and the sweeper re-enqueues `PENDING`
  instances; jobs that were only in Redis (not yet started) are lost, and the user can repeat the action.
- While Redis is unreachable the scheduled ticks cannot run, so each process reconciles on its own timer
  (recovery and lease reaping never depend on Redis). Each tick sweeps `PENDING` rows first and the
  reaper leaves `PENDING` rows to the sweeper when a queue is configured.
- A job whose worker lost its lock (crash, or a Redis blip longer than 30 s) is not redelivered: it lands in
  the failed set as `JobStalled`, because a repeated restart would restart the instance twice. The lease
  reaper resolves what the crashed operation left behind.
- Shutdown (SIGTERM) waits at most 10 s per component for running jobs and the process exits within 30 s
  even if Redis is down.

## Secrets (provider keys and Telegram)

Customers attach an AI provider (their own key, or NibieRouter attached by the operator) and a Telegram
bot to an instance. The credentials are encrypted at rest (envelope encryption: a random data key per
secret, wrapped by `SECRETS_KEK`), are never returned by any endpoint after they are submitted, never
appear in logs or in Redis job payloads, and reach the container only as environment variables at
container creation (plus a managed `model:` block in the instance's `config.yaml`, which holds no key;
see [ADR 0003](adr/0003-hermes-config-delivery.md)). A change takes effect at the next start or restart,
which recreates the container (the volume is kept).

- **Generate the key once:** `openssl rand -base64 32`. Put it in the host environment and keep a copy in
  the password manager (Bitwarden). **If the key is lost, every stored secret is unrecoverable** and
  customers must submit their credentials again. Never commit it.
- **Rotate the key:** generate a new key; set `SECRETS_KEK` to the new key with `SECRETS_KEK_VERSION` one
  higher, and move the old key to `SECRETS_KEK_PREVIOUS` with its old `SECRETS_KEK_PREVIOUS_VERSION`;
  restart the API; call `POST /api/v1/secrets/rewrap` (operator API) until `GET /api/v1/secrets/health`
  shows no secret on the old version; then remove the `PREVIOUS` variables and restart again. Keep the old
  key in the password manager until then.
- **Egress:** the Hermes Telegram adapter polls `api.telegram.org` and also uses fixed Telegram IP
  addresses and DNS-over-HTTPS as fallbacks. With the egress ruleset applied, the tenant bridge must be
  allowed to reach those, or the bot stays silent. This is not verified on a real host (see
  [egress-host-notes.md](egress-host-notes.md)).
- **Outbound calls from the control plane** (Telegram `getMe`/test message, provider `/models` test) go
  through `safeFetch`: https only, no redirects, every resolved address must be public, the connection is
  pinned to the validated address, with a timeout and a size cap.

## Billing (Duitku POP)

Plan: [superpowers/plans/2026-11-14-backend-milestone-d-duitku-billing.md](superpowers/plans/2026-11-14-backend-milestone-d-duitku-billing.md).

- **Customer routes** (token required, only when billing is configured): `GET /subscriptions`,
  `GET /subscriptions/:id`, `POST /subscriptions/checkout` (`Idempotency-Key`, body `{ planId, name }`, answers `201`
  `{ subscription, payment }` with the Duitku `paymentUrl`), `POST /subscriptions/:id/renew`,
  `POST /subscriptions/:id/cancel`, `GET /payments/:id`. `GET /plans` shows `monthlyPriceIdr`; `null` means the plan is not
  for sale and checkout answers `409 plan_not_for_sale`.
- **Public callback:** `POST /api/v1/billing/duitku/callback` (form body). The HMAC signature is the authentication and
  is checked before any database access: bad signature `400`, everything else `200`. Set the same URL as
  `DUITKU_CALLBACK_URL`; Duitku needs it on port 443. `deploy/Caddyfile` forwards it and the customer billing paths.
- **Test price:** prices are an operator step, never a migration. List plans with
  `pnpm tsx scripts/seed-sandbox-plans.ts`, set a sandbox price with `pnpm tsx scripts/seed-sandbox-plans.ts <slug> 10000`
  (minimum 10000; refused when `NODE_ENV` or `DUITKU_ENV` is production).
- **Check the credentials against the real sandbox** (Task 0, cannot run from the cloud sandbox because Duitku is
  not reachable there): `DUITKU_MERCHANT_CODE=... DUITKU_API_KEY=... pnpm tsx test/validation/duitku-sandbox-live.ts --email <address> [--raw]`
  creates one Rp 10.000 sandbox invoice and prints its reference and payment URL. Pay it with the Duitku sandbox
  simulators (VA demo page, QRIS simulator), then confirm in the backend log that a `duitku callback processed` line with
  `outcome: activated` appears and the instance reaches `ACTIVE`.
- **Lifecycle:** 30-day periods; at the end 3 days of grace (the instance keeps running), then suspension (instance
  stopped, volume kept, customer start/restart answers `409 subscription_suspended`), then 30 days of retention, then
  the instance is deleted. A verified renewal at any point before deletion reinstates the subscription and restarts the
  instance. Cancel only sets non-renewal. Deleting the instance by hand ends the subscription without refund.
- **Emails** (Indonesian, via SumoPod): receipt, reminders 7/3/1 days before the end, grace started, a day before
  suspension, suspended, a week before deletion, deleted. One per kind per period; after downtime only the current
  one is sent. A mail failure never blocks a payment or a transition; the notice is retried on the next tick.
- **Billing tick:** runs inside the existing locked maintenance job (at most once per 5 minutes per process), or on its
  own timer without Redis. It expires unpaid invoices, closes purchases nobody paid for after 7 days, advances the
  lifecycle and repairs a paid subscription whose instance was never created or restarted (a crash after the
  payment commit).

## Disk quota host setup (XFS)

Tenant volumes are size-limited with XFS project quotas, so Docker's data root (default
`/var/lib/docker`) must live on an XFS filesystem mounted with `prjquota` (also written `pquota`).

1. Create or mount an XFS filesystem (a dedicated disk is simplest), with the `prjquota` mount option.
2. Point Docker's `data-root` at it (`/etc/docker/daemon.json`), stop Docker, move or recreate the data,
   and start Docker. Doing this on a host that already runs containers is disruptive.
3. Check: `findmnt -T /var/lib/docker -o TARGET,FSTYPE,OPTIONS` shows `xfs` and `prjquota`/`pquota`.
4. Start the control plane. With `HERMES_DISK_QUOTA=enforce` it creates and removes a small probe volume
   and exits with a message naming `HERMES_DISK_QUOTA` if Docker refuses the size option.

On a filesystem without quota support (for example ext4) Docker refuses to create a sized volume
(HTTP 400, "quota size requested but no quota support"). Use `HERMES_DISK_QUOTA=off` only for local
development and tests; it is rejected when `NODE_ENV=production`. What has and has not been checked
on a real host is in [disk-quota-host-notes.md](disk-quota-host-notes.md).

## Egress ruleset host setup

Tenant networks are filtered by one iptables chain that must be loaded on every runtime host
(`HERMES_EGRESS_POLICY=enforce` exits at startup if it is not). Steps (Debian or Ubuntu with
`iptables`; the unit assumes the repository is at `/opt/hermes-cloud`, adjust the paths otherwise):

1. `sudo install -d /etc/hermes-egress && sudo cp ops/egress/egress.conf.example /etc/hermes-egress/egress.conf`
2. Edit `RESOLVERS` (the upstream DNS servers Docker forwards to; a private resolver must be listed),
   leave `EXCEPTIONS` empty unless a single `ip:port` must stay reachable, and review `NEW_CONN_RATE`
   (a placeholder until measured).
3. Review without changing anything: `ops/egress/hermes-egress.sh apply --dry-run --config /etc/hermes-egress/egress.conf`
4. `sudo cp ops/egress/hermes-egress.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now hermes-egress.service`
   (after config changes use `systemctl reload hermes-egress.service`; the unit never removes the rules
   on stop or restart)
5. `sudo ops/egress/hermes-egress.sh status` must exit 0.
6. Pull the canary image by digest (it needs `sh` and a busybox-compatible `nc`, for example busybox;
   a build without `-z`/`-w`/`-l -p` is reported as `nc_unusable`), set `HERMES_CANARY_IMAGE` (and optionally `HERMES_CANARY_PRIVATE_IP`),
   and start the control plane.

What was and was not verified, and how to operate and debug the rules:
[egress-host-notes.md](egress-host-notes.md), [runbook-egress.md](runbook-egress.md). Existing tenant
networks created before this policy have no `hn` name and must be deleted and reprovisioned.

## Recreating an existing instance's container

A new `HERMES_MASTER_KEY`, `HERMES_RUNTIME` or `HERMES_DNS_RESOLVERS` applies only to containers created
after the change; existing tenants keep their old key, runtime and DNS setting, including after a
restart or crash recovery of the same container. To move an instance, remove its container and keep the
volume: `docker rm -f hermes-<instance-id>`. The Reconciler then recreates it (same volume) with the
current key, runtime and resolvers. There is no API for this yet.

## Operator API (development only)

Do **not** expose this API publicly: it has a single shared bearer token and no customer auth.
It listens on loopback only; reach it through an SSH tunnel if needed.

```bash
H="Authorization: Bearer $ADMIN_TOKEN"
curl -H "$H" -H "Idempotency-Key: $(uuidgen)" -H 'content-type: application/json' \
  -d '{"name":"my agent","planId":"<plan-uuid>"}' \
  http://127.0.0.1:3000/api/v1/tenants/<tenant-uuid>/instances
# Reusing an Idempotency-Key with a different name/planId -> 409. Unknown or malformed tenant/plan -> 404.
# Postgres unreachable -> 503 {error.code: database_unavailable}. Docker unreachable -> 503 runtime_unavailable.
# GET  /api/v1/tenants/:t/instances[/:i[/status|/events]]
# POST /api/v1/tenants/:t/instances/:i/{start,stop,restart}      DELETE /api/v1/tenants/:t/instances/:i
# These answer 202 {instance, jobId}; with a job queue the instance shows its new status once the worker picks the job up.
```

There is no endpoint to create tenants/plans/nodes yet; seed rows directly (see `scripts/demo.ts`).

## Customer API (Supabase auth)

Enabled when `SUPABASE_URL` is set. Customers send `Authorization: Bearer <Supabase access token>`;
the backend verifies it locally against `<SUPABASE_URL>/auth/v1/.well-known/jwks.json` (asymmetric
algorithms only) and derives the tenant from the user's membership. Routes, all under `/api/v1`:
`GET /me`, `GET /plans`, `POST /instances` (needs `Idempotency-Key`), `GET /instances[/:id[/status|/events]]`,
`POST /instances/:id/{start,stop,restart}`, `DELETE /instances/:id`, and per instance (when `SECRETS_KEK` is set):
`GET|PUT /instances/:id/providers`, `POST .../providers/test`, `DELETE .../providers/:providerConfigId`,
`GET|PUT|DELETE .../telegram`, `POST .../telegram/verify`, `GET .../logs?tail=` (redacted, at most 500 lines).
The test and verify routes are limited to 5 per minute. Operator-only: `PUT /api/v1/tenants/:t/instances/:i/providers/nibierouter`,
`GET /api/v1/secrets/health`, `POST /api/v1/secrets/rewrap`. Limits: 120 requests per minute
per user, 5 provisioning requests per 10 minutes per user.

Supabase project checklist (settings live in the Supabase dashboard, not in this repository; none of
this has been run against a real project yet):

- JWT signing keys must be asymmetric. `GET <SUPABASE_URL>/auth/v1/.well-known/jwks.json` must list
  keys; an empty list means legacy HS256, which this backend rejects.
- Keep "Confirm email" enabled. `email_confirmed_at` is not a token claim, so the backend cannot check it.
- Restrict signups to invited users for the beta. `BETA_ALLOWED_EMAILS` gates instance creation, not signup.
- Add the dashboard's redirect URLs under `https://cloud.nibie.app/dashboard/`.
- Note the access-token lifetime: a signed-out or deleted user's token stays valid until it expires.
- The dashboard only ever holds the publishable key. A secret (`sb_secret_...`) key is not needed by
  this backend today and must never be committed.

### Supabase Postgres (production database)

- `DATABASE_URL` points at the Supabase database with `?schema=hermes`, so the tables and
  `_prisma_migrations` live in schema `hermes`, not in `public` (Supabase's Data API exposes `public`
  by default; confirm `hermes` is not in the exposed schemas). No code or model change is involved.
- Run `pnpm db:migrate` over a direct or session-mode connection, not the transaction pooler.
- Use a dedicated database role for the backend rather than the `postgres` superuser, and enable RLS
  on the `hermes` tables as defense in depth. Role names and passwords stay out of the repository.
- Not verified yet: no migration has been run against Supabase. Local development and tests use the
  compose Postgres on schema `public`.

### Public exposure

The process still binds `127.0.0.1` and serves both API surfaces on one port. A reverse proxy that
publishes `api.cloud.nibie.app` must forward only the customer paths (`/api/v1/me`, `/api/v1/plans`,
`/api/v1/instances*`) and must **not** forward `/api/v1/tenants/*` (the operator API). The proxy must
also apply its own request limits: the application's rate limit only counts authenticated users.

## Sandboxes and CI without a Docker service

If the daemon is not running, start it in the background (`dockerd &`) and wait for
`docker info` to succeed. Docker Hub rate limits (HTTP 429) can block pulls; the stub image is
built from a digest-pinned `alpine` layer that is usually already cached. If the pull is still
rate-limited, point the build at a mirror of the same digest with
`HERMES_STUB_BASE=<mirror>/library/alpine@sha256:<same digest>` (read by `test/helpers/stub-image.ts`).

## Using the real Hermes image

The pinned official image is supported and was exercised by the live acceptance harness; see
[milestone-2-runtime-security.md](milestone-2-runtime-security.md) for what was and was not
verified. Point `HERMES_IMAGE` at `nousresearch/hermes-agent@sha256:276d44685c65c0cb2a25f190b63c65c8906f9dc76486fb1c05ae71b5826bda08`
(required form in production) and read the image contract in
[architecture.md](architecture.md#image-contract). To re-run the harness against the real image on
a Docker host: `pnpm tsx test/validation/runtime-manager-live.ts` (the runsc checks need a daemon
with gVisor installed).

## NibieRouter key and credit

Milestone E. After the first verified payment creates an instance, the control plane (a) creates one NibieRouter user
per tenant (synthetic address `t-<tenantId>@<NIBIEROUTER_USER_EMAIL_DOMAIN>`, random password that is not kept, the
customer never signs in there), (b) creates one API key per instance and attaches it as the instance's
`NIBIEROUTER` provider (encrypted, then the instance is restarted so it picks it up), and (c) for a plan with
`Plan.includedCreditNano` grants that credit once. Failures never touch the payment: the row in `RouterProvisioning`
stays `PENDING` with a short code (`router_unreachable`, `router_rejected`, `router_unexpected`, `orphan_key`) and the
billing tick retries every 5 minutes, up to 24 attempts.

- **Turn it on:** put `NIBIEROUTER_ADMIN_KEY` and `NIBIEROUTER_DEFAULT_MODEL` in the backend environment on the host
  (the admin key is created in the NibieRouter admin dashboard, restricted to the VPS address, kept in the password
  manager). Without them nothing changes. `SECRETS_KEK` must be set too.
- **Check the real router first** (the admin "create key for a user" call is not described in the SumoRouter docs, so
  the client's request shape is a guess until this passes): on the VPS,
  `NIBIEROUTER_ADMIN_KEY=... pnpm tsx test/validation/nibierouter-live.ts` creates one throwaway user and tries
  create key, list keys, a US$0.01 credit and the balance history. It prints only OK/FAILED and field names.
- **Plan prices and credit** are set by hand (SQL), never by a migration, for example the two beta plans:
  `UPDATE hermes."Plan" SET "monthlyPriceIdr" = 25000 WHERE slug = '<hosting slug>';` and
  `UPDATE hermes."Plan" SET "monthlyPriceIdr" = 50000, "includedCreditNano" = 2000000000 WHERE slug = '<hosting+credit slug>';`
  (US$1 = 1_000_000_000 nano; `GET /plans` shows it as `includedCreditUsd`). Put the credit plan on sale only after the
  live check above passed.
- **Stuck row:** `SELECT * FROM hermes."RouterProvisioning" WHERE status = 'PENDING';`. `orphan_key` means a key named
  `inst-<instanceId>` exists at the router but no secret is stored here (the router shows a secret once): revoke that key
  in the NibieRouter dashboard and the next tick creates a new one.
- **Credit is exactly once:** `CreditGrant` (unique per subscription) is the guard because the router has no
  idempotency; after an ambiguous failure the retry looks for the note `nibie-cloud credit <subscriptionId>` in the
  user's balance history before posting again. If that history cannot be read it stays `PENDING` instead of risking a
  second grant.
- **Not covered yet:** instances created through the beta path (no payment) get no router key; usage is not shown in the
  dashboard; a customer who already has their own provider keeps it (the credit is still granted to their router user).
