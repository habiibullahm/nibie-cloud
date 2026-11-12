# Current State — Hermes Cloud

Last updated: 2026-11-12 (design-foundation run)

## Current milestone

Milestone 2.2 — End-to-End Runtime Security Acceptance (validation): WS1–WS5 evidence collected;
documentation update owed. Design foundation (this run) is complete alongside it.

## Completed implementation

- Milestone 1: runtime foundation — src/ modules (instances, runtime, http, db), Prisma
  migrations, compose.yaml (postgres), vitest suite.
- RuntimeManager adapted to the official Hermes image contract (commits 7b17cda, 67b50f3, 760f361):
  `/opt/data` mount, port 8642, UID 10000 preserved, s6 capability baseline (8 caps), read-only
  rootfs + tmpfs, per-instance API_SERVER_KEY, runc/runsc selectable, Bearer-auth health checks.
- Live acceptance harness `test/validation/runtime-manager-live.ts`: 25/25 checks pass on runc
  and runsc against the real daemon and the pinned official image
  (digest sha256:276d44685c65c0cb2a25f190b63c65c8906f9dc76486fb1c05ae71b5826bda08, v0.23.1).
- Design foundation (2026-11-12): root `DESIGN.md` generated through
  https://design.dev/ai/design-md-generator (not hand-authored); shadcn/ui policy in `AGENTS.md`;
  see `docs/SESSION_HANDOFF.md` for validation evidence.

## Current branch and relevant commits

- Branch: `feat/official-image-compatibility`
- 760f361 fix(runtime): re-add s6 capabilities and read-only-rootfs tmpfs; add live acceptance harness
- 67b50f3 fix(hardening): inject API_SERVER_HOST=0.0.0.0 for container port forwarding
- 7b17cda feat(runtime): adapt RuntimeManager for official Hermes image with s6, port 8642, and gVisor

## Verified tests

- 67/67 unit tests pass (`vitest run`); `tsc --noEmit` clean.
- 25/25 live RuntimeManager checks (runc + runsc), real Docker daemon, pinned official image.
- DESIGN.md: `@google/design.md@0.4.0` lint → 0 errors, 0 warnings;
  `export --format css-tailwind` → valid Tailwind v4 `@theme` block.

## Known issues

- `npx @google/design.md ...` hangs (update-check network stall); invoke the local binary
  directly (`node <pkg>/dist/index.js ...`) or pin and install first.
- Docker-published ports bypass UFW on this host; egress policy lives in DOCKER-USER/INPUT
  (canary-validated; see docs/milestone-2-runtime-security.md).
- gVisor (runsc) is compatible but remains non-default; runc stays default.
- pnpm not installed on the local Windows workstation; corepack enable fails there
  (tests were run via direct node_modules invocation).

## Outstanding blockers

- Milestone 2.2 documentation: fold WS1–WS5 evidence into `docs/milestone-2-runtime-security.md`
  (doc exists remotely-side evidence is in session logs; needs consolidation).
- Live tenant-container hardening baseline (cap set, read-only rootfs, tmpfs) is validated in the
  harness only — not yet wired into the production provisioner path.
- gVisor egress-perf and database-benchmark evidence is partial (WS4 python3 harness bug in one
  benchmark; corrected WS4b ran; consolidated numbers owed to the doc).
- Frontend/dashboard work is explicitly out of scope until approved (see AGENTS.md).
