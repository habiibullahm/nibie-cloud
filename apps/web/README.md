# Hermes Cloud dashboard (`apps/web`)

Customer dashboard for Hermes Cloud, built from `docs/prd.md` §4 and the root `DESIGN.md`.
Next.js (App Router) + TypeScript + Tailwind v4 + shadcn/ui (Radix, new-york style), Lucide icons,
TanStack Query. Dark-neutral theme only.

Status: **preview**. It runs fully on mock data, or against the backend's existing instance
endpoints in live mode. Customer sign-in uses Supabase Auth only when `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` are set (publishable key only); otherwise the auth screens stay a preview. Billing is a UI shell. The app is served under `basePath` `/dashboard`.

## Run

```bash
cd apps/web
pnpm install            # or: npx pnpm@10.28.0 install
pnpm dev                # http://localhost:3100/dashboard
```

Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.

Tips: `/instances?empty` shows the empty state, and adding `?fail` to any page makes every preview
endpoint fail so you can see the error states. Mock data lives in the browser and resets on reload
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

## Design read

Written down so each choice has a reason (antislop R-31, R-37). The full review is in
[`anti-slop/`](anti-slop/).

- **Job of the screens:** an operator-style console for one person's agents. The decision on most
  screens is "is my agent healthy, and what do I do next", so status and the next action lead.
- **Dials:** ENERGY 1 (quiet, neutral surfaces; terracotta only on the primary action, checked
  checkbox and switch-on), RHYTHM 2 (cards, tables and key-value lists vary by content; no repeated
  section template), MOTION 1 (hover and focus states only; spinners only while something is
  really in progress, and all motion stops under `prefers-reduced-motion`).
- **Kept on purpose:**
  - Lucide icons: AGENTS.md says "Prefer Lucide icons".
  - Uppercase tracked labels: DESIGN.md `label-caps`.
  - Dark-only: DESIGN.md defines one dark-neutral theme.
- **Button edges:** outline and secondary buttons use `border-strong` (4.09:1 on the page), so their
  boundary meets the 3:1 non-text contrast bar. Approved by Nash on 2026-11-12 and recorded in
  DESIGN.md.
- **Touch targets:** on coarse pointers every control gets at least a 44x44px hit area through the
  `hit-area` utility in `globals.css` (an invisible `::after`, so nothing moves on desktop). Text
  inputs grow to 44px on touch.
- **Honest placeholders:** there is no logo yet, so the brand is the product name as text. Sections
  without a backend carry a "Preview data" note (tap to read why); controls with no backend carry a
  "Coming soon" label and a `TODO` in code.

## Layout

```
src/app/(auth)/            sign-in, register, set-password, auth/confirm (email link landing; real when Supabase is configured)
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

## Deploy to Cloudflare (Worker)

The dashboard runs as a Cloudflare Worker (`nibie-cloud-web`) through the OpenNext adapter, at
`https://cloud.nibie.app/dashboard`. `wrangler.jsonc` and `open-next.config.ts` hold the setup.

```bash
pnpm cf:build      # Next build + Worker bundle in .open-next/
pnpm cf:preview    # same, then serves it locally with wrangler dev (workerd)
pnpm cf:deploy     # build + deploy (needs a logged-in wrangler or CLOUDFLARE_API_TOKEN)
```

`NEXT_PUBLIC_*` values are inlined at build time, so they must be set where the build runs (the
Workers Builds settings, or your shell for `cf:deploy`). Set `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; the publishable key is public, never use a secret key.
The Worker must be routed to `cloud.nibie.app/dashboard*` (Workers & Pages, the Worker, Settings,
Domains & Routes). Verified locally with `wrangler dev`; not yet deployed to a real account.

## Customer API mode

`NEXT_PUBLIC_HERMES_API_MODE=customer` talks to the backend customer API (`src/http/customer-routes.ts`)
straight from the browser, with the signed-in user's Supabase access token as a bearer header; the backend
derives the tenant from the token. Set `NEXT_PUBLIC_HERMES_API_URL` (public origin, no path) next to the two
Supabase variables, all at build time. Real: instance list, get, status, events, create, start, stop,
restart, delete, plus `/me` and `/plans`. Everything else is still preview data. Without the URL or the
Supabase variables the app falls back to labelled mock data. Backend prerequisites: `SUPABASE_URL`,
`DASHBOARD_ORIGIN` (exact origin, for CORS), `BETA_ALLOWED_EMAILS` (creation is refused with 403
`provisioning_not_enabled` for other accounts) and at least one active plan row.
