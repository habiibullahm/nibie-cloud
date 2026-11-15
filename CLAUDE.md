# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The project instructions live in `AGENTS.md` (shared with other coding agents). Read them first:

@AGENTS.md

## Pointers not covered in AGENTS.md

Do not copy content from these files here; read them when the task touches the area.

- **Reading order and precedence:** `docs/README.md` is the documentation index. The repository and
  real tool output win over `docs/CURRENT_STATE.md`, which wins over every other document. Files it
  lists under "Historical records" are not kept up to date.
- **Third package, `apps/docs`** (`@hermes-cloud/docs`): the customer documentation site (Fumadocs,
  Next.js 16, static export under `/docs`, content in Indonesian). Standalone like `apps/web`, with its
  own `package.json` and lockfile. Commands and content rules: `apps/docs/README.md`.
  `pnpm dev` there serves http://localhost:3200/docs; checks are `pnpm typecheck && pnpm lint`.
- **Fourth package, `apps/landing`** (`@hermes-cloud/landing`): the public landing page for `cloud.nibie.app`
  (static export, Cloudflare Worker with static assets, content in Indonesian, legal pages for Duitku KYC).
  Standalone with its own `package.json` and lockfile. Commands, the public-contact-email rule and the
  Cloudflare setup: `apps/landing/README.md`. `pnpm dev` there serves http://localhost:3300;
  checks are `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
- **Fifth package, `e2e`** (`@hermes-cloud/e2e`): Playwright browser tests for the landing page, the dashboard and the backend (T0 mock,
  T1 full stack, T2 production smoke). Standalone with its own `package.json` and lockfile. Setup, secrets rules and commands: `e2e/README.md`.
  `pnpm test:t0` there needs `pnpm build:t0` first; checks are `pnpm typecheck`.
- **Next.js 16 in `apps/web`, `apps/docs` and `apps/landing`:** its APIs and conventions differ from older versions.
  Read the relevant guide under that package's `node_modules/next/dist/docs/` before writing Next.js code.
- **Deployment** (`deploy/`: Compose, Caddy, Dockerfile for a single VPS): read `deploy/README.md` for
  the order of work and for what was and was not verified on a real host. Host addresses, contact
  emails and all secret values stay out of the repository; `.env.example` holds names and
  placeholders only.
- **Host-level controls** (`ops/egress/`, XFS volume quota): `docs/runbook-egress.md`,
  `docs/egress-host-notes.md`, `docs/disk-quota-host-notes.md`.
