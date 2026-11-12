# Current State — Hermes Cloud

Last updated: 2026-11-12 (hardening wiring run; uncommitted, see the section below)

> **Read first:** `docs/HANDOFF_TO_CLAUDE.md` — the authoritative state transfer for the next
> implementing agent. It supersedes any older summary where they disagree.

## Current milestone

Milestone 1 (runtime foundation) is complete and committed. Milestone 2.2 — End-to-End Runtime
Security Acceptance — is **partly done**: the hardening baseline is applied by the production
provisioning path (derived per-instance API key, runtime selection, strict readiness; uncommitted
change set, see "Uncommitted work"), and `docs/milestone-2-runtime-security.md` now exists as a
reconstruction that is **incomplete** (WS1-WS4 contents and the benchmark numbers are not
recoverable; gVisor was not re-run). The design foundation is complete as *committed documentation*; its expected
`design-preview.html` deliverable exists on disk but is untracked and **not yet human-approved**.

## Completed implementation

- Milestone 1: runtime foundation — src/ modules (instances, runtime, http, db), Prisma
  migrations, compose.yaml (postgres), vitest suite.
- RuntimeManager adapted to the official Hermes image contract (commits 7b17cda, 67b50f3, 760f361):
  `/opt/data` mount, port 8642, container user not pinned (s6 entrypoint drops to uid 10000),
  s6 capability baseline (8 caps re-added on top of `CapDrop ALL`), read-only rootfs with
  `/run`, `/tmp`, `/var/run` tmpfs, per-instance API_SERVER_KEY, runc/runsc selectable,
  Bearer-auth health checks.
- Live acceptance harness `test/validation/runtime-manager-live.ts`: reported 25/25 checks on runc
  and runsc against the real daemon and the pinned official image
  (digest sha256:276d44685c65c0cb2a25f190b63c65c8906f9dc76486fb1c05ae71b5826bda08, v0.23.1).
- Design foundation (2026-11-12): root `DESIGN.md` generated through
  https://design.dev/ai/design-md-generator (not hand-authored), validated with
  `@google/design.md@0.4.0`; shadcn/ui policy locked in `AGENTS.md`.
- `design-preview.html` (untracked, 1,333 lines): a seven-section component specimen sheet built
  from `DESIGN.md` tokens only. **Unreviewed and unapproved.** It raises two open accessibility
  findings that need a human design decision — border contrast 1.33–1.44:1 vs WCAG 1.4.11, and
  terracotta below 4.5:1 as text.

## Uncommitted work: hardening wiring (2026-11-12)

Spec `docs/superpowers/specs/2026-11-12-hardening-wiring-design.md`, plan
`docs/superpowers/plans/2026-11-12-hardening-wiring.md`. Nothing from this change set is committed.

- New required env `HERMES_MASTER_KEY` (>= 32 chars) and `HERMES_RUNTIME` (`runc` default, `runsc`).
- `deriveApiKey()` (`src/modules/runtime/api-key.ts`): HMAC-SHA256 of the master key and instance
  id; `InstanceService` and `Reconciler` pass it, and the runtime, to every `ensure()` and probe.
- `checkHealth()` with a key requires an authenticated 200 (401 = "auth rejected").
- `assertRuntimeAvailable()` fails startup when `HERMES_RUNTIME=runsc` is not installed.
- `test/fixtures/hermes-stub` reworked to the official contract (tag `hermes-stub:0.2.0`, 8642,
  `/opt/data`, Bearer `/api/sessions`, drops to uid 10000 via busybox `su`); `HERMES_STUB_BASE` lets
  the build use a mirror of the same alpine digest when Docker Hub returns 429.
- Integration tests, `scripts/demo.ts`, `.env.example`, `docs/setup.md`, `docs/architecture.md` and
  ADR 0002 (amendment) updated to the official contract.
- Line endings: the working tree is CRLF; the stub files (`test/fixtures/hermes-stub/*`) are written
  LF because they run inside Linux containers. A root `.gitattributes` (`test/fixtures/hermes-stub/* text eol=lf`) was added so Git never turns them into CRLF.

## Current branch and relevant commits

- Branch: `feat/official-image-compatibility`
- HEAD: `b7bd10e` docs(design): lock shadcn/ui policy, add generator-produced DESIGN.md and continuity docs
- 760f361 fix(runtime): re-add s6 capabilities and read-only-rootfs tmpfs; add live acceptance harness
- 67b50f3 fix(hardening): inject API_SERVER_HOST=0.0.0.0 for container port forwarding
- 7b17cda feat(runtime): adapt RuntimeManager for official Hermes image with s6, port 8642, and gVisor

Working tree: `design-preview.html` untracked; no tracked file modified, nothing staged, no stashes.
`origin` is a local bundle file, not a network remote.

## Verified tests

Re-run 2026-11-12 on a cloud sandbox copy (Docker 29.9 cgroup v1, Postgres 16, runc only), **not**
on the local Windows workstation, which still has no `node_modules` or `pnpm`:

- `tsc --noEmit` clean; 89/89 unit tests; 101/101 integration tests (real Docker, stub image).
- Live harness against the official image on runc: the 21 checks before the runsc step pass; the
  runsc checks could not run (gVisor not installed). Two of the 25 harness checks cannot fail (see
  `docs/milestone-2-runtime-security.md`).
- One-off end-to-end run on the official image: ACTIVE with strict readiness, derived key accepted
  (200) and rejected without it (401), key unchanged after Reconciler recreation.

Prior claims still not re-executed:

- 25/25 live RuntimeManager checks on runsc.
- Test counts on the local workstation.
- DESIGN.md: `@google/design.md@0.4.0` lint → 0 errors, 0 warnings;
  `export --format css-tailwind` → valid Tailwind v4 `@theme` block.

## Known issues

- `docs/milestone-2-runtime-security.md` is a partial reconstruction: WS1-WS3 contents and the WS4b
  benchmark numbers are unrecoverable from the repository.
- The stub returns 401 for everything when no `API_SERVER_KEY` is set; the official image's behaviour
  without a key is unchecked.
- Rotating `HERMES_MASTER_KEY` invalidates running instances' keys until they are recreated.
- `npx @google/design.md ...` hangs (update-check network stall); invoke the local binary
  directly (`node <pkg>/dist/index.js ...`) or pin and install first.
- Docker-published ports bypass UFW on this host; egress policy lives in DOCKER-USER/INPUT.
- gVisor (runsc) is compatible but remains non-default; runc stays default.
- pnpm not installed on the local Windows workstation; corepack enable fails there
  (tests were run via direct node_modules invocation).
- Observed and unresolved: HTTP 400 rejection of a `c:`-prefixed URL on the provider/tool path.
  Not diagnosed, not reproduced minimally, not fixed. Do not claim otherwise.

## Outstanding blockers

- Milestone 2.2 evidence: re-run the live harness on a host with gVisor (and ideally cgroup v2) and
  record it in the "Verification run" section of `docs/milestone-2-runtime-security.md`.
- The hardening-wiring change set is uncommitted and awaiting Nash's go-ahead.
- gVisor egress-perf and database-benchmark evidence is partial (WS4 python3 harness bug in one
  benchmark; corrected WS4b ran; consolidated numbers are not recoverable).
- `design-preview.html` awaits human visual approval before any dashboard work is considered.
- Frontend/dashboard work is explicitly out of scope until approved (see AGENTS.md and
  `docs/HANDOFF_TO_CLAUDE.md` section F).
