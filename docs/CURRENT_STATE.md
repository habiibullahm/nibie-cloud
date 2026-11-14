# Current State — Hermes Cloud

Last updated: 2026-11-13 (milestone C deployed on the VPS, database backup, first gVisor attempt). Index of all docs: [README.md](README.md).

## Where things stand

- **Git.** `main` is at `6e5d644` and `origin/main` matches it (checked in a fresh clone on
  2026-11-12). Nothing from earlier "uncommitted" notes is still uncommitted. The earlier working
  branch `feat/official-image-compatibility` was reported at the same commit but is not part of
  that clone. `origin` is `https://github.com/habiibullahm/nibie-cloud` (public).
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
  auth and billing are UI shells. See [../apps/web/README.md](../apps/web/README.md).
  Branch `fix/web-antislop-review` (PR #2) applies an antislop review: audit and report in
  `apps/web/anti-slop/`, 45 dashboard tests. It also gives outline and secondary buttons
  `border-strong` edges (approved by Nash, recorded in `DESIGN.md`).

- **Backend milestone A (customer API).** On branch `claude/project-thread-b5f2bk`, rebased onto the egress controls merge
  (`a8d86fd`): Supabase token verification (`src/modules/auth`), `User` and `TenantMember`
  models with a new migration, a customer API next to the operator API (`src/http/customer-*.ts`),
  CORS, rate limits, a beta provisioning gate and a per-tenant instance cap. Spec:
  [superpowers/specs/2026-11-12-backend-design.md](superpowers/specs/2026-11-12-backend-design.md);
  plan: [superpowers/plans/2026-11-12-backend-milestone-a-auth-customer-api.md](superpowers/plans/2026-11-12-backend-milestone-a-auth-customer-api.md).
  Milestone D (Duitku POP billing) is designed in the spec only; nothing of it is built.
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
  password manager). Milestone D (Duitku POP billing) is next.
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
- **gVisor failed at the first step.** `runsc` itself runs on the host, but with `HERMES_RUNTIME=runsc` the
  backend exited at startup (`egress canary could not run`, `probe_failed`): the canary container's
  `PidsLimit: 32` is too low under gVisor, whose sandbox threads count against it (kernel log: `fork rejected by
  pids controller`). The same script passed by hand under `runsc` with a limit of 256. Production is back on
  `runc`. The limit is now 256 when the runtime is `runsc` (`egress-canary.ts`; not yet deployed or re-tested). No tenant instance
  has run under `runsc` on the VPS; plan `pids` values may need the same check.
- **Supabase Auth email does not go through a custom SMTP server yet.** The auth log of 2026-11-13 shows the
  confirmation email sent by Supabase's built-in sender, and requests came from `http://localhost:3000`. Custom
  SMTP (SumoPod, see the 2026-11-14 decision above), Site URL and Redirect URLs are set in the Supabase dashboard
  by the owner.

**Not verified, still open:** gVisor (`runsc`) with the official image (see the update above), backups of tenant
volumes (none exist), whether stale XFS project ids pile up after deletes, Redis AOF recovery after a crash,
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
- Not done: uncommitted until the owner approves; no Cloudflare route or deployment for `/docs*`;
  `@google/design.md` lint not run; fumadocs callout icon colours (blue, amber, red) are library
  defaults, not `DESIGN.md` tokens, and need an owner decision.
