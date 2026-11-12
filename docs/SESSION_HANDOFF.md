# Session Handoff — 2026-11-12 (design foundation + runtime commit)

> **Historical record.** Entries below describe the repository as of each run, not today. Current status:
> [CURRENT_STATE.md](CURRENT_STATE.md). Entries that say work is "uncommitted" are out of date: it was
> committed in `aa9e2c8` and `ceba9cd`.

> **Superseded in part.** The current authoritative handoff is `docs/HANDOFF_TO_CLAUDE.md`
> (written 2026-11-12, handoff-to-Claude run). It contains the verified Git state, the reconciled
> decision set, and the next steps. The notes below are the historical record of the
> design-foundation run and are kept for traceability; where they disagree with
> `docs/HANDOFF_TO_CLAUDE.md`, the newer document wins.

## Update — hardening wiring run (2026-11-12, later still)

Spec and plan approved by Nash, then executed inline in a sandbox copy of the repo (the local
workstation has no `node_modules` or `pnpm`). Result applied to the working tree **uncommitted**.
Full description: `docs/CURRENT_STATE.md`, "Uncommitted work: hardening wiring".

- Done: key and runtime wiring, strict readiness, startup runsc check, stub rework, updated
  integration tests and demo, docs (architecture, setup, `.env.example`, ADR 0002 amendment), new
  `docs/milestone-2-runtime-security.md` (partial reconstruction).
- Verified in the sandbox (Docker 29.9, cgroup v1, runc only): tsc clean, 89 unit and 101 integration
  tests pass, harness runc checks pass against the official image, end-to-end provision and recovery
  on the official image works with the derived key.
- Not verified: gVisor, cgroup v2 / production host, the local Windows workstation.
- Next: Nash reviews and commits (or asks for changes); re-run the harness with gVisor and fill the
  "Verification run" section; check the new `.gitattributes` (stub files stay LF).

## Update — handoff-to-Claude run (2026-11-12, later same day)

Reconciliation pass. Read-only inspection of Git plus review of every document; no implementation
work, no dependency install, no provider or infrastructure change.

- Created `docs/HANDOFF_TO_CLAUDE.md` (section A overview, B approved decisions, C actual state,
  D current design task, E technical notes, F next steps, G discrepancies).
- Updated `docs/CURRENT_STATE.md` to match verified state.
- **Corrected:** the design files were committed as `b7bd10e`, not `34935be`. `34935be` was
  `commit --amend`ed into `b7bd10e` at 09:10:33 (visible in `git reflog`, not in `git log`).
- **Found:** `design-preview.html` already exists untracked (81,606 bytes, 1,333 lines, seven
  sections, written 14:58 today). It is a complete component specimen sheet, unreviewed and
  unapproved. Preserved untouched.
- **Found:** `docs/milestone-2-runtime-security.md` does not exist and was never committed, though
  both continuity docs referred to it. Milestone 2.2 evidence must be reconstructed.
- **Found:** `docs/architecture.md` "Image contract" still documents the stub contract
  (8080 / `/data` / uid 10001) rather than the implemented official-image contract
  (8642 / `/opt/data` / s6 uid 10000 + 8 caps). Flagged, not changed.
- **Found:** no `node_modules` and no `pnpm` on this workstation, so the documented test results
  could not be re-executed. They are now recorded as prior claims, not verified facts.
- Working tree at handoff: branch `feat/official-image-compatibility`, HEAD `b7bd10e`, one
  untracked file, nothing staged, no stashes, nothing committed by this run.

## Historical: design foundation run

## Work completed in this run

1. Committed the pending RuntimeManager hardening work as `760f361`
   (s6 capability baseline, read-only rootfs + tmpfs, live acceptance harness in
   `test/validation/runtime-manager-live.ts`). Removed the stray `package-lock.json`.
2. Generated the root `DESIGN.md` **through the actual generator UI**
   (https://design.dev/ai/design-md-generator, browser-driven): system "Hermes Cloud",
   10 semantic colors, 4 typography styles (Bricolage Grotesque / Onest / system mono),
   8-level 4px-based spacing scale (xs…xl4), radii sm 4px / md 8px, 8 components
   (button primary/secondary/outline/destructive, card, input, muted-text, border-demo).
   Tokens were adjusted in the generator until its live linter reported **Valid**
   (0 errors / 0 warnings): terracotta #C66A4A→#AD5B3C and destructive #D96B6B→#B84A4A for
   WCAG AA on white foreground; spacing names 2xl/3xl/4xl→xl2/xl3/xl4 (token names must
   start with a letter).
3. Validated with the official CLI `@google/design.md@0.4.0`:
   - `lint DESIGN.md` → errors: 0, warnings: 0 (after quoting the YAML description value).
   - `export --format css-tailwind DESIGN.md` → valid Tailwind v4 `@theme` output
     (color/font/text/radius/spacing custom properties). NOT applied to any app — repo is
     backend-only, Tailwind is not a dependency; recorded for future frontend work.
4. Created `AGENTS.md`: UI & Design System section locks shadcn/ui as the exclusive component
   foundation, requires DESIGN.md-first token usage, bans competing component libraries and
   parallel design systems; Context Continuity Protocol section; build/test conventions.
5. Created `docs/CURRENT_STATE.md` and this handoff doc.

## Exact files changed

- `DESIGN.md` (new, repo root, 221 lines, generator output)
- `AGENTS.md` (new, 50 lines)
- `docs/CURRENT_STATE.md` (new)
- `docs/SESSION_HANDOFF.md` (new)
- Earlier in run: `src/modules/runtime/hardening.ts`,
  `test/unit/hardening.test.ts`, `test/validation/runtime-manager-live.ts` (commit 760f361)

All four files are committed as `b7bd10e` on `feat/official-image-compatibility`
(this commit was created as `34935be` and then `--amend`ed; `34935be` survives only in the reflog).

## Decisions established

- shadcn/ui = exclusive component foundation for all future Hermes Cloud UI (documented in AGENTS.md).
- DESIGN.md tokens are the only permitted values; extend tokens, never hard-code.
- Terracotta primary #AD5B3C and destructive #B84A4A (WCAG AA with white foreground).
- No frontend/Tailwind/shadcn installation until dashboard work is explicitly approved.

## Validation results

- `@google/design.md@0.4.0` lint: 0 errors, 0 warnings. Export css-tailwind: valid `@theme`.
- Generator live linter (site): "Valid" before export.
- Unit suite: 67/67 pass; `tsc --noEmit` clean (state before this run's doc-only changes).
- Live RuntimeManager harness: 25/25 checks on runc and runsc (commit 760f361).

## Local Hermes fallback / session recovery findings (read-only inspection)

- Installed local Hermes: v0.23.0 (2026.9.24) stable, install C:\hh\hermes-agent (git method),
  Python 3.14.9, OpenAI SDK 2.54.0. Active model config: single custom provider
  (`Stars.nibie.app` → https://stars.nibie.app/v1, default model per config.yaml).
- Automatic model fallback: **not configured.** config.yaml ships a `fallback_model:` block but
  it is fully commented out; no provider-priority chain exists. Gateway-side manual switches are
  how the model changed today; the on-disk profile config was not modified by those switches.
- Session continuity survives model switches — verified against the live state DB
  (C:\hh\state.db): sessions live in one `sessions` table keyed by `session_key` (17 rows);
  `session_model_usage` records the model per API call and shows a single session served by
  multiple different models over its life (e.g. this workstation's current session has usage
  rows under 'antigravity' and later models), i.e. history is model-independent.
- No configuration changes were made. No credentials were read, changed, or recorded here.

## Remaining work

- Write `docs/milestone-2-runtime-security.md` (it does not exist; create it) with the WS1–WS5
  Milestone 2.2 evidence (consolidated pass/fail + reproducible failure cases; WS4b benchmark numbers).
- Wire the validated hardening baseline (caps/read-only rootfs/tmpfs) into the provisioner path.
- Decide and document the frontend approval gate before any dashboard work.

## Next recommended task

**Present `design-preview.html` for human visual approval, then wait.** It already exists untracked
and needs review, not authoring. No dashboard work follows until that approval is explicit.

After approval, the Milestone 2.2 documentation consolidation
(`docs/milestone-2-runtime-security.md`, which must be written from scratch) is the honest next
piece of project work, followed by correcting the stale image contract in `docs/architecture.md`.
Do not start either automatically. Full ordering in `docs/HANDOFF_TO_CLAUDE.md` section F.
