# AGENTS.md — Hermes Cloud

Managed Hermes hosting platform: one dedicated, isolated container per customer.
Backend/runtime/security first. Dashboard and customer-facing frontend are deferred.

## Context Continuity Protocol

Before every task, read: `AGENTS.md`, `docs/CURRENT_STATE.md`, `docs/SESSION_HANDOFF.md`,
relevant `docs/` milestone/ADR docs. Verify actual branch, commits, and test results —
treat repository state and real tool output as the source of truth, never conversation history.

Before ending every task, update `docs/CURRENT_STATE.md` and `docs/SESSION_HANDOFF.md`.

Never store provider credentials, API keys, tokens, or personal/ACI data in repository files.

## UI & Design System

**Decision: shadcn/ui (https://ui.shadcn.com/) is the exclusive component foundation for all
future Hermes Cloud frontend work.**

All future UI work MUST follow the root `DESIGN.md` and use shadcn/ui as the component foundation.

Rules:

- Read `DESIGN.md` before any UI implementation.
- Use shadcn/ui components as the default UI primitives, via the official shadcn registry and CLI.
- Use Tailwind CSS for styling, following the project's adopted Tailwind version at that time.
- Prefer Lucide icons.
- Create domain-specific components by composing shadcn/ui primitives; keep component APIs consistent.
- Customize the copied shadcn component source when necessary; do not fork or wrap it into a parallel system.
- Do not introduce Ant Design, MUI, Chakra UI, Mantine, DaisyUI, or any competing component system.
- Do not create a parallel custom design system.
- Do not invent colors, typography, spacing, radii, or component styles outside `DESIGN.md` tokens.
  If a needed token is missing, extend `DESIGN.md` as an explicit approved decision — never hard-code values.
- Update `DESIGN.md` when an approved design-system decision changes; validate with the official CLI
  (`@google/design.md` lint / export) before committing UI-affecting changes.
- Status is never communicated by color alone; pair badges/borders with text labels.
- All text meets WCAG AA contrast; visible focus states, keyboard navigation, reduced-motion respected.

This repository is currently backend-only (TypeScript runtime/orchestration service; no frontend app).
Do not initialize a frontend, install shadcn/ui, Tailwind, or any UI dependency until frontend
implementation is explicitly approved. The Tailwind v4 token export from `DESIGN.md`
(`@google/design.md export --format css-tailwind`) is recorded in `docs/CURRENT_STATE.md` for that
future work. Dashboard implementation is not authorized yet.

## Build & Test

- Package manager: pnpm (pnpm-lock.yaml is canonical). Node 22.
- Run unit tests: `pnpm vitest run` (or `npx vitest run`). Type-check: `npx tsc --noEmit`.
- Keep changes on feature branches; do not commit unrelated changes.
