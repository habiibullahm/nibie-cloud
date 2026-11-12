# Hermes Cloud dashboard (`apps/web`)

Customer dashboard for Hermes Cloud, built from `docs/prd.md` §4 and the root `DESIGN.md`.
Next.js (App Router) + TypeScript + Tailwind v4 + shadcn/ui (Radix, new-york style), Lucide icons,
TanStack Query. Dark-neutral theme only.

Status: **preview**. It runs fully on mock data, or against the backend's existing instance
endpoints in live mode. There is no customer auth and no billing; those screens are UI shells.

## Run

```bash
cd apps/web
pnpm install            # or: npx pnpm@10.28.0 install
pnpm dev                # http://localhost:3100
```

Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.

Tips: `/instances?empty` shows the empty state. Mock data lives in the browser and resets on reload
(the three seeded instances keep fixed ids so deep links work; instances you deploy do not).

## Data modes

Set `NEXT_PUBLIC_HERMES_API_MODE` in `.env.local` (see `.env.example`).

| Mode | Instances (list, get, status, events, create, start, stop, restart, delete) | Everything else |
| --- | --- | --- |
| `mock` (default) | In-browser mock (`src/lib/api/mock.ts`) that follows the backend's action guards | Mock |
| `live` | Backend `/api/v1/tenants/:tenantId/instances…` via the dev bridge | Mock, labelled "Preview data" |

The **dev bridge** (`src/app/api/hermes/[...path]/route.ts`) keeps `HERMES_ADMIN_TOKEN` on the
server, pins one tenant from `HERMES_DEV_TENANT_ID`, and forwards only the allowlisted method/path
pairs in `src/lib/api/proxy-rules.ts` (UUID ids only). It refuses to run in a production build
unless `HERMES_ALLOW_DEV_BRIDGE=1`. It exists because the backend API is operator-only today; it
must be replaced by the customer API once auth exists.

Sections without a backend endpoint yet (PRD §15): plans, regions, usage, logs, provider config,
Telegram, files, console, backups, subscription, custom domain, account. Each is marked with a
"Preview data" tag in the UI.

## Design system mapping

`src/app/globals.css` maps DESIGN.md tokens onto shadcn's semantic variables:

| shadcn | DESIGN.md |
| --- | --- |
| `--background` / `--foreground` | `neutral` / `primary` |
| `--card` / `--popover` | `card-bg` / `elevated` |
| `--primary` / `--primary-foreground` | `tertiary` (terracotta) / `on-tertiary` |
| `--secondary`, `--muted`, `--accent` | `secondary-surface` |
| `--muted-foreground` | `secondary` |
| `--border` / `--input` | `border` / `border-strong` |
| `--ring` | `primary` (neutral focus ring, 2px on a 2px page-floor offset) |
| `--destructive` | `destructive` |

- Terracotta appears only on the primary button fill, the checked checkbox and the switch-on track.
  Radio buttons, progress and selection use neutral tokens.
- Radii: Tailwind `rounded-sm` = `rounded.sm` (4px), `rounded-md` = `rounded.md` (8px); `lg`/`xl` are
  pinned to 8px so no other radius can appear.
- Type: exactly the four DESIGN.md styles (`.type-h1`, `.type-label`, body, `.type-mono`). Fonts load
  through `next/font` (Bricolage Grotesque 600/700, Onest 400).
- Hover/disabled tones use the same `color-mix()` formulas as the approved `design-preview.html`.
- Spacing stays on the 4px scale; the 10px vertical control padding is DESIGN.md's component padding.

shadcn components in `src/components/ui` are the official new-york-v4 sources, customized in place to
the tokens above. They were copied from the shadcn/ui repository because the shadcn CLI registry
(ui.shadcn.com) was not reachable from the build sandbox; `components.json` is set up so
`pnpm dlx shadcn@latest add <component>` works normally from a machine with access.

## Layout

```
src/app/(auth)/            sign-in, register (UI shells)
src/app/(app)/instances/   list, and [id]/ with overview, access, monitor, logs, configuration,
                           files, console, backups, billing (Upgrade & Renew), domain
src/app/(app)/deploy/      deployment page (PRD §4.2)
src/app/(app)/account/     account shell
src/app/api/hermes/        dev bridge to the backend
src/components/ui/         shadcn/ui primitives
src/components/app/        domain components (status badge, actions, progress, chart…)
src/lib/api/               types, status mapping, mock, live client, proxy rules
src/hooks/use-hermes.ts    TanStack Query hooks
test/                      Vitest unit tests
```
