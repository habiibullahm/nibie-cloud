# Current State — Hermes Cloud

Last updated: 2026-11-12 (documentation tidy). Index of all docs: [README.md](README.md).

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

## Verified tests

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

## Disk quota branch (`feat/disk-quota`)

Re-run in a cloud sandbox (Docker 29.9, ext4, Postgres 16): `pnpm build` clean; `pnpm test:unit`
128/128; integration files that need only Postgres (`disk-wiring`, `disk-monitor`, `key-wiring`,
`schema`) pass. Docker-backed integration tests could not run there because the stub image build was
blocked by Docker Hub rate limiting (HTTP 429), so the new `runtime-manager` integration test for the
unquotaed-volume refusal has not run; the same behaviour was checked once with a throwaway script
against the real daemon. Not verified: kernel enforcement on XFS, `runsc`, a live DiskMonitor run.

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
- Disk quota is implemented on branch `feat/disk-quota` (spec and plan under `docs/superpowers/`) and
  awaits review. Not verified on an XFS host: the plan's Task 1 (host spike) and Task 8 (live
  verification) are still open, see [disk-quota-host-notes.md](disk-quota-host-notes.md). Network
  egress controls are specified (spec and plan written) but not implemented.
