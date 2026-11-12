# AGENTS.md — Hermes Cloud

Managed hosting for Hermes AI agents: one dedicated, isolated container plus one volume per customer.
Product source of truth: `docs/prd.md`. **Not production-ready** (open gaps: `docs/architecture.md`,
"Known gaps and deferred security work").

Two separate packages, no pnpm workspace:

| Package | Path | What it is |
| --- | --- | --- |
| Backend `hermes-cloud` | repo root (`src/`, `test/`, `prisma/`) | Fastify operator API + Docker runtime manager + reconciler (TypeScript, ESM) |
| Dashboard `@hermes-cloud/web` | `apps/web/` | Next.js 16 customer dashboard preview (mock data by default); its own `package.json` and lockfile |

## Working rules

- Read first: this file, `docs/CURRENT_STATE.md`, then the doc index `docs/README.md`.
  Verify branch, commits and test results yourself. The repository and real tool output are the
  source of truth, never an older summary or conversation history.
- Do not guess. If a fact is not in the repo or in tool output, say so and ask the owner.
- Do not commit or push unless the owner asks. Keep unrelated changes out of a change set.
- Before ending a task that changes behaviour or status, update `docs/CURRENT_STATE.md`
  (and `docs/SESSION_HANDOFF.md` if you start a new handoff entry).
- Never put provider credentials, API keys, tokens or personal data in repository files.
  The GitHub repository is public.

## Commands

Package manager is pnpm (`pnpm-lock.yaml` is canonical), Node >= 22.

Backend (repo root):

```bash
pnpm install                      # also runs `prisma generate`
docker compose up -d postgres     # dev DB on 127.0.0.1:5433
cp .env.example .env              # then set ADMIN_TOKEN (>= 24 chars) and HERMES_MASTER_KEY (>= 32 chars)
pnpm db:migrate                   # apply prisma migrations
pnpm dev                          # operator API on 127.0.0.1:$PORT (default 3000) + 15 s reconciler loop
pnpm build                        # type-check only (tsc --noEmit); there is no emitted build
pnpm test:unit                    # no Docker or DB needed
pnpm test:integration             # needs a Linux Docker daemon + Postgres; builds the stub image on first run
pnpm test                         # both
pnpm vitest run test/unit/hardening.test.ts            # single file
pnpm vitest run test/unit/hardening.test.ts -t "name"  # single test by name
pnpm demo [--keep]                # provision -> restart -> kill -> auto-recover, via the API, stub image
pnpm tsx test/validation/runtime-manager-live.ts       # live harness against the real daemon + official image
```

Integration tests use database `hermes_test` (see `docs/setup.md` for creating it) and run files
serially (`fileParallelism: false`) because they share one Docker daemon and one database.

Dashboard (`apps/web`):

```bash
cd apps/web
pnpm install
pnpm dev                          # http://localhost:3100
pnpm typecheck && pnpm lint && pnpm test    # also: pnpm build
pnpm vitest run test/status.test.ts         # single file
```

Last verified in a cloud sandbox on 2026-11-12: backend `tsc` clean and 209/209 unit tests, Postgres-only
integration files passing; dashboard `typecheck`, `lint` and 44/44 tests (earlier run). Docker-backed
integration tests were not re-run (Docker Hub rate limiting blocked the stub image build).

## Architecture (the parts that span files)

- **Control plane / data plane in one modular monolith** (ADR 0001, no orchestrator). Only
  `src/modules/runtime` talks to Docker, behind the `RuntimeManager` interface (`types.ts`);
  `src/modules/instances` depends only on that interface. The Docker socket is never mounted into a
  tenant container.
- **Docker names derive from instance UUIDs only** (`hermes-<id>`, `hermes-data-<id>`,
  `hermes-net-<id>`), never customer text. This is what makes every runtime call idempotent.
- **Lifecycle** (`state-machine.ts`, `instance-service.ts`): every status change is a database
  compare-and-set plus an `InstanceEvent` in one transaction; the loser of a race gets 409.
  Provisioning is idempotent per `(tenant, Idempotency-Key)` and the key is bound to `name` + `planId`.
  It runs synchronously in-process today.
- **Leases** (`lease.ts`): each transitional status is owned by one operation with a heartbeat-renewed
  lease; the operation's writes are fenced on `operationOwner`; the stale-operation reaper in
  `reconciler.ts` only touches expired leases.
- **Reconciler** (`reconciler.ts`): recovers `ACTIVE`/`DEGRADED` instances (max 3 attempts, backoff with
  jitter, stability window), claims the instance before touching Docker, never restarts `STOPPED`.
- **Hardening baseline** (`runtime/hardening.ts`): constants for the official Hermes image contract
  (port 8642, data at `/opt/data`, s6 init that drops to uid 10000, eight re-added capabilities,
  read-only rootfs with tmpfs). The container `User` is deliberately not pinned. Details and the
  evidence behind each setting: `docs/architecture.md`, `docs/adr/0002-...`,
  `docs/milestone-2-runtime-security.md`.
- **Per-instance API key** (`runtime/api-key.ts`): `API_SERVER_KEY` = HMAC-SHA256 of `HERMES_MASTER_KEY`
  and the instance id; never stored or logged. Readiness requires an authenticated 200 on
  `/api/sessions`; a 401 marks the instance `DEGRADED` (`auth_rejected`) without a restart.
  `HERMES_MASTER_KEY` and `HERMES_RUNTIME` (`runc` default, `runsc` for gVisor) only apply to
  containers created afterwards.
- **Disk quota and egress** (`runtime/volume-quota.ts`, `runtime/egress-canary.ts`, `ops/egress/`):
  `HERMES_DISK_QUOTA` and `HERMES_EGRESS_POLICY` are `enforce|off` (`off` refused in production). Tenant
  volumes carry a size quota from `Plan.storageMb` and tenant bridges are named `hn<12 hex>` so one host
  iptables chain can filter them; the control plane refuses unquotaed volumes and unnamed networks
  (`volume_quota_missing`, `network_policy_missing`) and runs an egress canary at startup. Neither the XFS
  kernel quota nor the egress rules have been verified on a real host: see `docs/disk-quota-host-notes.md`
  and `docs/egress-host-notes.md`.
- **Images must be pinned:** no `latest` in any environment, `name@sha256:<digest>` when
  `NODE_ENV=production` (`runtime/image-policy.ts`). `test/fixtures/hermes-stub` is a stand-in that
  mimics the official contract; `test/fixtures/hermes-stub/*` must stay LF (`.gitattributes`).
- **Operator API** (`src/http/server.ts`, `/api/v1`): one shared bearer `ADMIN_TOKEN`, binds
  `127.0.0.1` only, no customer auth. No endpoint creates tenants or plans; seed rows directly
  (see `scripts/demo.ts`).
- **Dashboard data layer** (`apps/web/src/lib/api`): a typed `HermesApi` with an in-browser mock
  (default, `NEXT_PUBLIC_HERMES_API_MODE=mock`) and a live client. Live mode goes through the dev
  bridge `apps/web/src/app/api/hermes/[...path]/route.ts`, which keeps `HERMES_ADMIN_TOKEN` server-side
  and forwards only the allowlisted instance endpoints in `proxy-rules.ts`. Everything without a
  backend endpoint (plans, usage, logs, files, console, backups, billing, domain, account) is mock
  data and is labelled "Preview data". Auth and billing screens are UI shells. Mapping details:
  `apps/web/README.md`.

## UI and design system

shadcn/ui is the exclusive component foundation for Hermes Cloud frontend work, and the root
`DESIGN.md` is the design source of truth.

- Read `DESIGN.md` before any UI change. Use shadcn/ui primitives (official registry and CLI),
  Tailwind CSS and Lucide icons. Customize the copied component source in place; do not wrap or fork it
  into a parallel system.
- Do not add Ant Design, MUI, Chakra UI, Mantine, DaisyUI or any competing component system.
- Do not invent colors, type, spacing, radii or component styles outside `DESIGN.md` tokens. If a token
  is missing, extend `DESIGN.md` as an explicit approved decision; never hard-code values.
- Update `DESIGN.md` when an approved design decision changes and validate it with the official CLI
  (`@google/design.md` lint / export) before committing UI-affecting changes.
- Status is never conveyed by color alone. Text meets WCAG AA contrast; visible focus states, keyboard
  navigation and reduced motion are required.
- Terracotta (`tertiary`) is used only for the primary button fill, the checked checkbox and the
  switch-on track. `border-strong` is only for form-control boundaries and the edges of outline and
  secondary buttons.
