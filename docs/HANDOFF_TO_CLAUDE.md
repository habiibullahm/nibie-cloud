# Handoff to Claude Code

> **Historical snapshot, taken at commit `b7bd10e` on 2026-11-12. Not current.** Since then the hardening
> wiring, the revised `DESIGN.md`, `design-preview.html` and the `apps/web` dashboard were committed
> (HEAD `6e5d644`), `milestone-2-runtime-security.md` was written, and `architecture.md` "Image
> contract" was corrected. Statements below that the repo is backend-only, that the working tree is
> clean except `design-preview.html`, that `origin` is a local bundle, or that those documents are
> missing or stale, no longer hold. Current status: [CURRENT_STATE.md](CURRENT_STATE.md).

**Prepared:** 2026-11-12
**Repository:** nibie-cloud (local path omitted)
**Purpose:** State transfer only. Nothing in this document authorizes new implementation work.

Everything below was verified against the working tree with real commands on 2026-11-12.
Where previous summaries disagreed with the repository, the repository wins and the
discrepancy is recorded in section G.

---

## A. Project Overview

**Product objective.** Hermes Cloud is a managed hosting service that lets a customer run their
own Hermes AI agent 24/7 without operating a VPS, Docker, or runtime maintenance. Each customer
gets a dedicated, isolated container plus persistent storage. Hermes Cloud owns the infrastructure
lifecycle: provisioning, health monitoring, recovery, backups, runtime upgrades, subscription
lifecycle and capacity scheduling. Source of truth: `docs/prd.md` (v1.0, approved for technical
specification, 11 Nov 2026).

**Target users (PRD 2.2).** AI enthusiasts who want Hermes without running servers; users who want
a persistent always-on personal agent; users who want real Hermes freedom — tools, custom skills and
a shell inside their own container. Launch is a private beta of 5–10 invited users; long-term
capacity target is 100 customers, reached by adding runtime nodes, not by overloading one host.

**Business model.** Hosting subscription only. AI usage is billed separately via NibieRouter (the
default provider) or the customer's own key (BYOK). No bundled or unlimited token allowance. Entry
price is deliberately undecided pending resource measurement and unit economics.

**Architecture (built).** A control-plane / data-plane split in one Node.js + TypeScript modular
monolith (ADR 0001: no orchestrator).

```
 operator (bearer token, loopback)
        │
   src/http  ──────────────►  src/modules/instances ──► PostgreSQL (Prisma)
  (Fastify, /api/v1)           InstanceService, Reconciler, lease, state-machine
                                       │
                                       ▼  RuntimeManager interface
                               src/modules/runtime ──► Docker Engine API (dockerode)
                                    docker-runtime-manager, hardening, image-policy
                                       └─ one container + one volume + one network per instance
```

Only `src/modules/runtime` talks to Docker. The Docker socket is available to the control plane and
is never mounted into or reachable from a tenant container.

**Technology stack actually in `package.json`.**

| Layer | Present in repo |
| --- | --- |
| Runtime | Node.js >= 22 (local workstation: v22.23.3), TypeScript 5.9.3, ESM (`"type": "module"`) |
| HTTP | Fastify 5, Zod 4 |
| DB | PostgreSQL 16 (via `compose.yaml`) + Prisma 6.19 |
| Container | dockerode 5 / Docker Engine API (local daemon: 28.1.1) |
| Logging | pino 10 with key-path redaction |
| Test | Vitest 3.2 |
| Package manager | pnpm 10.28.0 (`pnpm-lock.yaml` canonical) |

Not present and not installed: Redis/BullMQ, Next.js, Tailwind, shadcn/ui, any billing or auth
library. There is **no** `frontend/`, `app/` or `src/ui` directory. The repo is backend-only.

**Current milestone.** Milestone 1 (runtime foundation) is complete and committed. Milestone 2.2
(End-to-End Runtime Security Acceptance) is in progress at the *documentation* stage: runtime
hardening against the real official image is implemented and validated, but the consolidated
acceptance evidence document has not been written (see section C and G). A design-foundation
workstream was also completed on 2026-11-12 and is what the next deliverable follows from.

---

## B. Approved Decisions

These are settled. Do not relitigate them in code, docs, or comments without an explicit
human decision recorded in `DESIGN.md`, `AGENTS.md` or an ADR.

1. **Dedicated container per customer.** One tenant = one dedicated Hermes container + one
   dedicated persistent volume (PRD 3, 6.3). No shared-runtime multi-tenancy.
2. **Backend / runtime / security first.** Dashboard and customer-facing frontend are deferred.
   AGENTS.md: "This repository is currently backend-only... Do not initialize a frontend, install
   shadcn/ui, Tailwind, or any UI dependency until frontend implementation is explicitly approved."
3. **shadcn/ui is the exclusive component foundation.** Locked in `AGENTS.md` (UI & Design System).
   Ant Design, MUI, Chakra UI, Mantine, DaisyUI and any parallel custom design system are banned.
   Components are composed from shadcn/ui primitives via the official registry/CLI.
4. **Root `DESIGN.md` is the design source of truth.** It was produced by the design.dev generator
   (`https://design.dev/ai/design-md-generator`), not hand-authored, then validated with
   `@google/design.md@0.4.0`. Tokens are the only permitted values; a missing token is an explicit,
   approved extension to `DESIGN.md` — never a hard-coded value in a component.
5. **Neutral dashboard aesthetic: black, white, gray, clean and minimal.** Depth comes from tonal
   layering and 1px hairline borders, not shadows, glows, gradients or glassmorphism.
   Note the committed realization: `DESIGN.md` implements this as a *dark-neutral* system
   (page floor `#0B0D0F`, card `#14171A`, elevated `#1B1F23`, border `#2A2F34`) with neutral white
   `#F3F4F6` / gray `#9CA3AA` text and **one** restrained terracotta accent `#AD5B3C` reserved for
   the single primary action per screen. If strict black/white/gray with no accent is intended,
   that is an open design decision for human review — see section D.
6. **No dashboard implementation until explicitly authorized.** No routes, no app shell, no
   data-fetching layer, no auth screens. Design artifacts only.
7. **Personal ACI and business environments stay conceptually separate.** Personal ACI data,
   credentials and profile state must never be mixed into this repository, its container specs,
   or its seed/test data. AGENTS.md: never store provider credentials, API keys, tokens, or
   personal/ACI data in repository files.

Supporting decisions recorded elsewhere: images must be pinned (no `latest`, digest required in
production); `RestartPolicy: no` with recovery owned by the reconciler (ADR 0002); lifecycle runs
in-process now but is compare-and-set safe to move behind BullMQ later (ADR 0001).

---

## C. Actual Implementation State

### Git — verified state

- **Branch:** `feat/official-image-compatibility`
- **HEAD:** `b7bd10eb7203a728926d623a99f8cc5ca92295bf`
  — `docs(design): lock shadcn/ui policy, add generator-produced DESIGN.md and continuity docs`
  (2026-11-12 09:10:33 +0700)
- **Working tree:** one untracked file, `design-preview.html`. Nothing modified, nothing staged,
  nothing stashed (stash list is empty). **No tracked file has uncommitted changes.**
- **Other branch:** `feat/runtime-foundation` at `76402b0` (tracks `origin/feat/runtime-foundation`).
- **Remote:** `origin` is a local bundle — `C:/Users/muhammad.habiibullah/Downloads/hermes cloud/hermes-cloud.bundle`.
  There is no network remote. Do not assume you can fetch.

Latest commits:

```
b7bd10e docs(design): lock shadcn/ui policy, add generator-produced DESIGN.md and continuity docs
760f361 fix(runtime): re-add s6 capabilities and read-only-rootfs tmpfs; add live acceptance harness
67b50f3 fix(hardening): inject API_SERVER_HOST=0.0.0.0 for container port forwarding
7b17cda feat(runtime): adapt RuntimeManager for official Hermes image with s6, port 8642, and gVisor
76402b0 docs: review fixes, implementation checklist, lease and idempotency documentation
8810df2 fix: operation leases with heartbeat so the stale reaper only reaps abandoned operations
3cfb15b fix: bind idempotency keys to request payload; stop swallowing DB errors
6f6d350 fix: bound crash loops, claim instances during recovery, reap stale transitional states
```

### Code present

`src/` — 18 files:

- `config/env.ts`, `main.ts`, `http/server.ts`
- `db/client.ts`, `db/errors.ts`
- `modules/instances/`: `instance-service.ts`, `instance-repo.ts`, `state-machine.ts`,
  `reconciler.ts`, `lease.ts`
- `modules/runtime/`: `docker-runtime-manager.ts`, `hardening.ts`, `image-policy.ts`, `types.ts`
- `shared/`: `errors.ts`, `logger.ts`, `uuid.ts`

`prisma/` schema + three migrations (`init`, `add_stopping_status`, `add_operation_lease`).
Supporting: `compose.yaml` (postgres), `scripts/demo.ts`, `vitest.config.ts`, `tsconfig.json`,
`.env.example` (keys only: `NODE_ENV`, `DATABASE_URL`, `HERMES_IMAGE`, `ADMIN_TOKEN`, `PORT`,
`DOCKER_SOCKET_PATH`).

### Important modules — what they actually do

- **`modules/runtime/hardening.ts`** is the security core. Verified contents:
  - `CONTAINER_PORT = 8642`, `DATA_MOUNT = '/opt/data'` (official Hermes image contract).
  - `S6_REQUIRED_CAPS` — eight capabilities re-added on top of `CapDrop: ['ALL']`:
    `SETUID, SETGID, CHOWN, DAC_OVERRIDE, FOWNER, KILL, AUDIT_WRITE, SETFCAP`. The code comment
    records that removing any of SETUID/SETGID/CHOWN/DAC_OVERRIDE/FOWNER breaks boot, and that the
    set was determined empirically on the nibie-cloud canary matrix.
  - `S6_TMPFS` — `/run` rw,exec,nosuid,64m; `/tmp` rw,noexec,nosuid,64m; `/var/run` rw,exec,nosuid,16m.
  - `Privileged: false`, `SecurityOpt: ['no-new-privileges:true']`, `ReadonlyRootfs: true`.
  - Container user is **not pinned** — the s6 entrypoint drops to `hermes` (10000) itself
    (`test/unit/hardening.test.ts` asserts this deliberately).
  - Docker resource names derive from instance UUIDs only, never customer text.
- **`modules/runtime/docker-runtime-manager.ts`** — idempotent ensure/start/stop/restart/inspect/
  health/remove against the Docker Engine API via dockerode.
- **`modules/instances/state-machine.ts`** — `PENDING → PROVISIONING → CONFIGURING → STARTING →
  ACTIVE ⇄ DEGRADED`, plus `STOPPING → STOPPED → STARTING`, `FAILED → PROVISIONING` retry, and
  `→ DELETING → DELETED`. Every transition is a DB compare-and-set plus an event in one transaction.
- **`modules/instances/lease.ts` + `reconciler.ts`** — operation leases with heartbeat (TTL 60 s,
  renewed at TTL/3, hard cap `maxOperationMs` 10 min), fenced writes, and a stale-operation reaper
  that only touches expired leases. Reconciler recovers `ACTIVE`/`DEGRADED` instances with at most
  3 attempts, exponential backoff with jitter (2 s × 2ⁿ, cap 60 s) and a 5-minute stability window.
- **`http/server.ts`** — Fastify operator REST API under `/api/v1`, single shared bearer token,
  loopback-bound.

### Tests present (not re-executed in this handoff run)

`test/unit/` (7 files) — backoff, config, errors, hardening, image-policy, logger, state-machine.
`test/integration/` (8 files) — api, instance-service, isolation, lease, persistence, recovery,
runtime-manager, schema. `test/validation/runtime-manager-live.ts` — live acceptance harness against
a real daemon. `test/fixtures/hermes-stub/` — Alpine stand-in image.

### Tests actually executed

**In this handoff run: none, and this is deliberate.** The working tree has **no `node_modules`**,
`pnpm` is **not installed** on this workstation, and `corepack enable` fails here. Therefore the
documented results below could not be independently reproduced right now and are reported as
**prior claims**, not verified facts:

- 67/67 unit tests pass; `tsc --noEmit` clean (claimed from the Milestone 1/review rounds).
- 25/25 live RuntimeManager checks on both runc and runsc against the real Docker daemon and the
  pinned image `nousresearch/hermes-agent@sha256:276d44685c65c0cb2a25f190b63c65c8906f9dc76486fb1c05ae71b5826bda08`
  (v0.23.1) — commit `760f361`.
- `@google/design.md@0.4.0` `lint DESIGN.md` → 0 errors, 0 warnings; `export --format css-tailwind`
  → valid Tailwind v4 `@theme` block (commit `b7bd10e`).

To reproduce, someone must first `pnpm install` (or an equivalent install restoring `node_modules`)
and have Docker 28.1.1 available — the daemon *is* present on this machine.

### Known issues and production blockers

Carried forward from `docs/architecture.md` ("Known gaps", items 1–11) and still open:

1. **Disk quota not enforced.** Named volumes have no size limit; `Plan.storageMb` is stored and
   never applied. Log growth is unbounded.
2. **No network egress controls / SSRF defence (PRD 7.3).** Tenants are isolated from each other but
   can reach the internet, the host's bridge gateway, host services and cloud metadata addresses.
3. **gVisor is compatible but non-default.** `runsc` is selectable and validated in the harness;
   `runc` remains the default. Escape/kernel-exposure testing is not done.
4. **Hardening baseline is validated in the harness only** — not yet wired into the production
   provisioner path.
5. **Operator API only.** Single shared bearer token; no users, memberships, rate limits, CSRF or
   audit log.
6. **Synchronous in-process provisioning.** No job queue, no outbox, no leader election; a
   control-plane crash is cleaned up by the lease reaper (≤ 60 s TTL) but the operation is not
   resumed.
7. **Single node.** No scheduler or capacity reservation; random loopback port, no ingress or TLS.
8. **No secrets management.** Envelope encryption, rotation and revocation all absent.
9. **No backups/restore, shell/file broker, metrics, or suspend/grace/retention lifecycle.**
10. `STOPPED`/`STOPPING` are not in PRD 10.2 (documented in ADR 0001); `Plan` has no pricing by design.
11. PID/OOM behaviour was verified on a cgroup v1 dev sandbox; re-verify on the production
    host kernel / cgroup v2.

Additional environmental issues observed:

- `npx @google/design.md ...` hangs on the update check. Invoke the local binary directly
  (`node <pkg>/dist/index.js ...`) or pin and install it first.
- Docker-published ports bypass UFW on this host; egress policy lives in `DOCKER-USER`/`INPUT`.
- **`docs/architecture.md` "Image contract" section is stale.** It still says the image must listen
  on `8080`, keep state under `/data`, and run as uid `10001` — that describes the stub fixture
  contract, not what `hardening.ts` now enforces for the official image (port `8642`, mount
  `/opt/data`, s6 dropping to uid `10000`, eight re-added capabilities). Do not trust that section
  as the current contract; the code and the `760f361` comments are authoritative. Correcting it is
  outstanding documentation work, not an approved code task.

---

## D. Current Design Task

**What is committed.** `DESIGN.md` at the repository root is generated, validated and committed in
`b7bd10e`. It defines: 10 semantic colors, 4 typography tokens (Bricolage Grotesque headings,
Onest body, system mono), an 8-step 4px spacing scale (`xs`…`xl4`), radii `sm` 4px / `md` 8px, and
8 components (button primary/secondary/outline/destructive, card, input, muted-text, border-demo).
`AGENTS.md` locks shadcn/ui alongside it.

**What this task assumed vs. what exists.** This handoff was commissioned on the premise that
`design-preview.html` is "the next expected deliverable". **It already exists in the working tree**
as an untracked file — 81,606 bytes, 1,333 lines, mtime 2026-11-12 14:58:50 +0700. It is not
committed and not referenced by any `.md` file in the repo. It has **not** been human-reviewed or
approved, and its presence should not be read as authorization to move on to dashboard work.

**What the existing preview contains** (verified by inspecting the file): a self-contained HTML
specimen sheet with an inline token block transcribed from `DESIGN.md` only, Google-hosted
Bricolage Grotesque + Onest, and a seven-nav-rail layout:

1. Brand & design direction — surface hierarchy, palette
2. Typography — heading hierarchy, token specimens, labels & muted text
3. Color tokens — token reference, borders & focus
4. Spacing & shape — spacing scale, radius
5. Component showcase — buttons, inputs & textarea, select, checkbox & switch, badges, cards,
   tabs, table, dialog, tooltip & popover, alerts & status, state matrix
6. Interaction states
7. Accessibility — measured findings

Requirements that remain in force for it:

- It must stay a **component specimen sheet** — a catalogue of tokens and primitive states — not a
  mock dashboard.
- It must use `DESIGN.md` tokens only. No hex literal outside the token set; interaction states
  derive via `color-mix()`, never new literals. The file's own header comment states this rule.
- Neutral direction per section B.5.
- No real dashboard, no application routes, no frontend scaffolding, no build step, no
  `package.json` change, no framework import. It stays a single standalone file.
- It is for **human visual approval** and nothing else.

**Two open findings the file itself raises** — these are design decisions for the human, and the
file correctly refuses to invent token values to resolve them:

- **Border contrast (`border #2A2F34`).** 1.44:1 on `neutral`, 1.33:1 on `card-bg`. WCAG 1.4.11
  wants 3:1 on interactive component boundaries, so a border alone is not a compliant affordance.
  Options recorded: (a) accept and rely on the tertiary focus ring plus elevated fill, documenting
  the exception; or (b) approve a new `border-strong` token near 3:1 for form controls only. The
  file prefers (b).
- **Terracotta as text (`tertiary #AD5B3C`).** 4.02:1 on `neutral`, 3.72:1 on `card-bg` — below
  4.5:1 for body text. `DESIGN.md` already forbids it as a text color; use it for fills and focus
  rings only.

Passing measurements recorded in the file: primary foreground 17.69:1 on the page floor and
13.33:1 on the lightest surface; muted foreground ≥ 5.75:1; white on terracotta 4.84:1; white on
destructive 5.10:1; focus ring 4.02:1.

**The next required action is not authoring.** It is presenting the existing preview to the human
for visual approval, and holding.

---

## E. Technical Notes

- **Local Hermes version: v0.23.0** (build 2026.9.24 stable). Install at `C:\hh\hermes-agent` (git
  method), Python 3.14.9, OpenAI SDK 2.54.0. This is the tooling that has been driving the session;
  it is unrelated to the container image pin (`hermes-agent` v0.23.1 digest, used by the live
  harness). Two different version numbers, two different things — do not conflate them.
- **Automatic fallback is not configured.** `config.yaml` ships a `fallback_model:` block but it is
  fully commented out; there is no provider-priority chain. Model changes have been manual,
  gateway-side switches, which do not modify the on-disk profile config.
- **Session continuity across model switches is verified.** Sessions live in one `sessions` table
  keyed by `session_key` in `C:\hh\state.db`; `session_model_usage` records the model per API call,
  and a single session shows usage rows under multiple different models over its life. History is
  therefore model-independent and survives a switch. Verified against the live state DB.
- **Recorded, unresolved: HTTP 400 rejection of `c:`-style URLs.** A request using a `c:`-prefixed
  URL was rejected by the provider/tool path with HTTP 400. This is logged here as an **observed
  provider/tool integration issue**. It is **not** diagnosed, **not** reproduced under a minimal
  test, and **not** fixed. Do not describe it as resolved, worked around, or understood, and do not
  add speculative handling for it without a reproducing case. If it resurfaces, capture the exact
  request, the provider, and the full response body first.

No credentials, tokens or API keys are reproduced in this document or anywhere else in the repo.
No provider configuration was read, changed or recorded.

---

## F. Next Steps

1. **Claude Code reads all project instructions and handoff documents first:**
   `AGENTS.md`, `DESIGN.md`, `docs/CURRENT_STATE.md`, `docs/SESSION_HANDOFF.md`,
   this file, `docs/prd.md`, `docs/architecture.md`, `docs/adr/0001`, `docs/adr/0002`,
   `docs/implementation-checklist.md`, `docs/review-fixes.md`. Treat the repo, not these summaries,
   as the source of truth.
2. **Verify Git state before editing.** Expect branch `feat/official-image-compatibility` at
   `b7bd10e` with exactly one untracked file (`design-preview.html`). If anything differs, stop and
   report rather than resetting, stashing or discarding — there are no backups of the untracked file.
3. **Complete `design-preview.html`.** It already exists and is substantially complete. Treat it as
   work in progress needing review, not a greenfield build: audit it against `DESIGN.md` token by
   token, confirm no hex literal exists outside the token block, confirm it remains a specimen sheet
   and not a dashboard, and resolve or explicitly leave the two accessibility findings in section D.
   Do not add a build step, framework, dependency or route.
4. **Present the visual preview for approval.** Show it to the human and stop. Do not self-approve.
5. **Wait for approval before starting dashboard work.** No scaffold, no shadcn/ui install, no
   Tailwind, no routes, no `app/` directory, until that approval is explicit and recorded.
6. **Resume Milestone 2.2 only per project priorities and explicit authorization.** The honest
   ordering is documentation first: write the consolidated acceptance evidence document
   (`docs/milestone-2-runtime-security.md`, which does not yet exist — see G), then correct the stale
   image contract in `docs/architecture.md`, then consider wiring the validated hardening baseline
   into the provisioner. All three need sign-off before work starts.

Explicitly out of scope for the next run: dashboard implementation, frontend dependencies, provider
configuration changes, production Hermes infrastructure changes, anything touching the personal ACI
profile, dependency installs beyond what a test run requires, and commits without stated justification.

---

## G. Discrepancies Found While Reconciling

Recorded so they are not silently inherited. Each was checked against the filesystem, not taken
from a summary.

1. **`docs/milestone-2-runtime-security.md` does not exist.** Both `docs/CURRENT_STATE.md` (line 43,
   50) and `docs/SESSION_HANDOFF.md` (line 69, 77) reference it as an existing or to-be-updated
   document, and the task brief listed it under required reading. `ls docs/` shows no such file and
   no other file by that name. It was never committed (`git log -- docs/milestone-2-runtime-security.md`
   is empty). Its content — the WS1–WS5 evidence — cannot be recovered from the repository. It must
   be re-derived or reconstructed from session records. **This is the single largest gap in the
   Milestone 2.2 story.**
2. **`design-preview.html` already exists** (81,606 bytes, 1,333 lines, untracked, written today at
   14:58). The task brief described it as the next expected deliverable. Reality: substantial work
   is on disk and unreviewed. It is preserved untouched by this handoff run.
3. **Stale commit reference in `docs/SESSION_HANDOFF.md`.** It stated the four design files were
   "committed as `34935be`". `34935be` exists only in the reflog — it was `commit --amend`ed into
   `b7bd10e` at 09:10:33. Corrected in this run.
4. **`docs/architecture.md` image contract is stale** (port `8080` / `/data` / uid `10001`) versus the
   implemented official-image contract (port `8642` / `/opt/data` / s6 uid `10000` + 8 caps). Not
   corrected here — documentation correction is not authorized by this task beyond the continuity
   documents — but flagged for the next documentation pass.
5. **Milestone status wording overstates progress.** `docs/CURRENT_STATE.md` called the design
   foundation "complete" while its expected `design-preview.html` deliverable is unapproved, and
   labeled Milestone 2.2 as "WS1–WS5 evidence collected" while the document that would hold that
   evidence does not exist. Softened in this run to reflect verifiable state.
6. **`.env.example` still pins the stub image** (`HERMES_IMAGE=hermes-stub:0.1.0`) while the
   validation harness defaults to the official pinned digest. Not a bug — the stub is the safe
   local default — but a reader can easily mistake the stub for the production image. Noted, not changed.
7. **`pnpm` is missing and `corepack` is broken on this workstation**, so the repo's documented test
   workflow cannot run as written. `node` v22.23.3 and Docker 28.1.1 are available. Anything
   claiming "tests pass" must first re-establish `node_modules`.

---

## Appendix: Files this handoff run created or modified

- `docs/HANDOFF_TO_CLAUDE.md` — **created** (this file).
- `docs/CURRENT_STATE.md` — **updated**: references this handoff, corrects milestone wording, records
  the missing Milestone 2.2 document and the unreviewed preview.
- `docs/SESSION_HANDOFF.md` — **updated**: references this handoff, corrects `34935be` → `b7bd10e`,
  records the untracked preview.

Untouched, deliberately: all `src/`, all `test/`, `prisma/`, `package.json`, `pnpm-lock.yaml`,
`compose.yaml`, `AGENTS.md`, `DESIGN.md`, `design-preview.html`, `.env.example`, every ADR and every
other document. No dependency installed. No Git operation performed other than read-only inspection:
no commit, no stage, no stash, no reset, no checkout, no branch change.
