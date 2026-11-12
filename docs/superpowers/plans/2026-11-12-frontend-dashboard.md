# Hermes Cloud customer dashboard (frontend only) — implementation plan

Date: 2026-11-12
Status: approved to start by Nash ("build frontend only with specs prd and design"), built while Nash was away.
Scope owner: frontend thread. The backend, config, tests and existing docs are owned by a parallel thread
and are not touched by this plan.

**Goal:** a runnable customer dashboard that follows PRD §4 (journey, deployment page, instance dashboard,
statuses) and the root `DESIGN.md`, built on shadcn/ui + Tailwind v4, talking to the existing
`/api/v1` instance endpoints and mocking everything that does not exist yet.

**Architecture:** standalone Next.js (App Router, TypeScript) app in `apps/web/`, its own `package.json`
and lockfile, not wired into the root package (so the backend thread's root files stay untouched).
A typed `HermesApi` interface has two implementations: an in-memory mock (default) and a live client
that goes through a server-side Next route handler, which forwards only the allowlisted instance
endpoints to the backend. The operator `ADMIN_TOKEN` never reaches the browser.

**Tech:** Next.js 16, React 19, TypeScript strict, Tailwind v4, shadcn/ui (neutral base, official CLI
and registry, sources customized to DESIGN.md tokens), Lucide icons, TanStack Query for fetching and
status polling, Vitest for unit tests, Playwright (container only) for screenshots.

## Decisions made without Nash (recorded for review)

| # | Decision | Why |
|---|---|---|
| D1 | App lives in `apps/web/`, standalone package, no root workspace file | Parallel backend thread owns root `package.json`, `tsconfig.json`, `src/`, `test/`. Converting to a pnpm workspace is a later, one-line change. |
| D2 | Next.js App Router | PRD §6.2 proposes Next.js + TypeScript for the dashboard. |
| D3 | shadcn semantic variables mapped to DESIGN.md: `--primary` = tertiary terracotta (primary button fill, checked checkbox, switch-on only), `--foreground` = colors.primary, `--muted-foreground` = secondary, `--input` = border-strong, `--ring` = colors.primary, `--radius` = rounded.sm/md | Keeps shadcn component code conventional while the only terracotta uses are the three approved ones. |
| D4 | Hover/disabled tones derived with `color-mix()` from tokens, same formulas as the revised design-preview.html | No new hex values; matches the approved preview. |
| D5 | Dark theme only | DESIGN.md defines a single dark-neutral palette; no light tokens exist. |
| D6 | Default data mode is `mock`; `live` mode proxies only endpoints that exist today (instances list/get/status/events/create/start/stop/restart/delete) for one dev tenant from env | Backend API is operator-only (bearer ADMIN_TOKEN) with no customer auth yet. Sections without a backend endpoint (usage, logs, providers, Telegram, files, console, backups, plans, subscription, domain) always use mock data and say so in the UI. |
| D7 | Price is shown as "Not set yet" and checkout is a UI shell | PRD §5.2: entry pricing is not approved. No billing implementation. |
| D8 | Auth pages (sign in, register) are UI shells that route to the dashboard | Customer auth arrives in a later milestone; no auth implementation. |
| D9 | Backend statuses map to PRD §4.4 labels (`CONFIGURING` shows as Provisioning; `STOPPING`/`STOPPED` shown as Stopping/Stopped per the ADR); `Suspended` exists in the type for subscription state | Customer labels must follow PRD; internal states must not leak raw. |
| D10 | Monitor charts are drawn with plain SVG in neutral token colors | No chart library needed for the preview; avoids inventing a chart palette not in DESIGN.md. |

## Tasks

1. **Scaffold** `apps/web` with create-next-app (TS, Tailwind, ESLint, App Router, src dir), `shadcn init`
   (neutral), add the primitives needed: button, card, badge, input, label, textarea, select, checkbox,
   switch, tabs, table, dialog, alert-dialog, dropdown-menu, tooltip, popover, alert, separator, skeleton,
   sheet, sonner, radio-group, progress.
2. **Tokens**: rewrite `globals.css` theme from DESIGN.md (colors, four type styles, radii); fonts
   Bricolage Grotesque + Onest via `next/font`; focus ring = 2px neutral offset + 2px primary; tune
   component sources (button sizes/padding 10×16, input bg elevated + border-strong, switch off track
   border-strong, reduced motion).
3. **Data layer** (`src/lib/api`): types mirroring backend JSON, status mapping, `HermesApi` interface,
   mock store with simulated lifecycle transitions, live client, Next route handler proxy with path
   allowlist. Unit tests for mapping, mock transitions and the allowlist.
4. **Shell**: app layout with left nav (Instances, Deploy, Billing, Account), mobile sheet nav,
   preview-mode banner, sign-in/register shells.
5. **Screens**: instances list (+ empty state), deploy page (name, region, plan with CPU/RAM/storage/PIDs,
   billing cycle, summary, deploy), instance dashboard with sub-nav: Overview (status, reason, next action,
   restart/stop/start/delete, events), Access, Monitor, Logs, Configuration (NibieRouter/BYOK + Telegram),
   File Manager, Console, Backups, Upgrade & Renew, Custom Domain.
6. **Verify**: `tsc --noEmit`, `eslint`, `vitest run`, `next build`; Playwright screenshots at 1440 and
   390 widths; quick keyboard/focus check.
7. **Deliver**: copy `apps/web` source (no `node_modules`, no `.next`) and this plan into the repo,
   uncommitted; report.

## Out of scope

Backend changes, real auth, billing/payments, OpenAPI generation, operator console (PRD §16),
committing, root workspace wiring.
