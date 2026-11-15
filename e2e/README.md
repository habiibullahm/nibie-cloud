# Browser end-to-end tests (`e2e`)

Playwright tests that drive a real Chromium against the landing page, the dashboard and the backend.
Plan and reasoning (Indonesian): [`docs/superpowers/plans/2026-11-15-browser-automation-testing.md`](../docs/superpowers/plans/2026-11-15-browser-automation-testing.md). Standalone package (own `package.json` and lockfile).

| Tier | What runs | Secrets | Command |
| --- | --- | --- | --- |
| **T0** | Landing export + dashboard on mock data | none | `pnpm test:t0` |
| **T1** | Dashboard (customer mode) + real backend + Postgres + Redis + stub containers + a dedicated Supabase **test** project | yes | `pnpm stack:prep && pnpm test:t1` |
| **T2** | Read-only smoke test of production | smoke account only | `pnpm test:t2` |

## T0 (no secrets)

```bash
cd e2e && pnpm install
pnpm exec playwright install chromium     # once
pnpm build:t0                             # builds apps/landing (static export) and apps/web (mock mode)
pnpm test:t0
```

`playwright.config.ts` starts the servers itself: the landing export through `support/static-server.mjs` on 3300
(clean URLs and a 404 page, like Cloudflare) and `next start` for the dashboard on 3100. A server that already
runs on those ports is reused outside CI. Rebuild after changing app code; `pnpm build:t0` always rebuilds the
dashboard in mock mode, so run it again if `pnpm stack:prep` built the customer-mode variant last.

What T0 checks: every public page (status, title, heading, no console errors, no horizontal overflow at desktop and
phone width), the 404 page, the prices and plan links, the dashboard list, empty and error states, the deploy
flow, Stop / Start / Restart / Delete with their confirmations, keyboard behaviour, and axe accessibility (serious
and critical WCAG A/AA violations fail). Findings that were reported and are not fixed yet are listed in the spec
files (`KNOWN`, `test.fixme`) and show up as `known-a11y-issue` annotations in the report. When one is fixed the
test fails until its entry is removed.

## T1 (needs the Supabase test project)

1. Create a separate Supabase project for tests (never the customer project) and put its values in `e2e/.env.e2e`
   (copy `.env.e2e.example`). Use a long random `E2E_USER_PASSWORD`. In CI the same names are repository secrets
   (`E2E_SUPABASE_URL`, `E2E_SUPABASE_PUBLISHABLE_KEY`, `E2E_SUPABASE_SECRET_KEY`); the password is generated per run.
2. Docker must be running (Docker Desktop is fine), and `pnpm install` must have been run in the repository root and in `apps/web`.
3. `pnpm stack:prep` brings up Postgres and Redis (`compose.yaml`), creates and migrates the `hermes_e2e` database,
   seeds the `demo-small` plan and the `local` node, builds `hermes-stub:0.2.0` if missing and builds the dashboard
   in customer mode against `http://127.0.0.1:3000` and the test project.
4. `pnpm test:t1` starts the backend (`pnpm --dir .. dev`, development mode, no disk quota, no egress rules, no
   billing, no router) and the dashboard, then runs: sign-in setup, login/logout, the beta gate, and the real
   deploy -> Stop -> Start -> Restart -> Delete lifecycle with Docker checks (`hermes-<id>` container and
   `hermes-data-<id>` volume). The test users `e2e-lifecycle`, `e2e-outsider` and `e2e-login` are created by the
   setup project through the Supabase Admin API, already confirmed, so no email is sent.

Not covered yet: the Duitku checkout and callback (needs a billing-enabled backend and `https` return URL, see the
plan, section 7), provider and Telegram configuration, subscription grace and suspension.

## T2 (production, read-only)

Set `PROD_SMOKE_EMAIL` and `PROD_SMOKE_PASSWORD` (an account without instances that is not in
`BETA_ALLOWED_EMAILS`); without them the sign-in test is skipped. `PROD_BASE_URL` and `PROD_API_URL` default to
`https://cloud.nibie.app` and `https://api.cloud.nibie.app`. Nothing is created, changed or deleted.

## Rules

- No secret in the repository. `.env.e2e` and `.auth/` are git-ignored. The sign-in setup runs with trace, video and
  screenshots off, and so does everything in T1 and T2: the repository is public and CI artifacts can be downloaded.
- Locators use role and label only (`getByRole`, `getByLabel`), no CSS selectors, no `waitForTimeout`.
- T1 runs with one worker: one Docker daemon, one database, and the customer API rate limits creates (5 per 10 minutes).
- `pnpm typecheck` must pass before every commit.
