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
- **Next.js 16 in `apps/web` and `apps/docs`:** its APIs and conventions differ from older versions.
  Read the relevant guide under that package's `node_modules/next/dist/docs/` before writing Next.js code.
- **Deployment** (`deploy/`: Compose, Caddy, Dockerfile for a single VPS): read `deploy/README.md` for
  the order of work and for what was and was not verified on a real host. Host addresses, contact
  emails and all secret values stay out of the repository; `.env.example` holds names and
  placeholders only.
- **Host-level controls** (`ops/egress/`, XFS volume quota): `docs/runbook-egress.md`,
  `docs/egress-host-notes.md`, `docs/disk-quota-host-notes.md`.
