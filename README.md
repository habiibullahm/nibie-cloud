# Nibie Cloud

Managed hosting for Hermes AI agents. The repository holds two packages:

- **Backend** (repo root): the Hermes runtime foundation. Operator API, Docker runtime manager with
  the hardening baseline for the official Hermes image, and the reconciler. No customer auth,
  billing or scheduler yet.
- **Dashboard** ([apps/web](apps/web/README.md)): customer dashboard preview (Next.js, shadcn/ui).
  Mock data by default; auth and billing are UI shells.

> **Status: NOT production-ready.** Disk quota enforcement, network egress controls and
> runtime-isolation validation are incomplete (see [Known gaps](docs/architecture.md#known-gaps-and-deferred-security-work)).
> The pinned official Hermes image boots under the hardened baseline in the live harness, but only
> partly validated (see [docs/milestone-2-runtime-security.md](docs/milestone-2-runtime-security.md)).
> Integration tests run against a stand-in stub image.

- Current status and open decisions: [docs/CURRENT_STATE.md](docs/CURRENT_STATE.md)
- All documentation: [docs/README.md](docs/README.md)
- Source of truth for scope: [docs/prd.md](docs/prd.md)
- Setup and running: [docs/setup.md](docs/setup.md)
- Agent instructions: [AGENTS.md](AGENTS.md) · design rules: [DESIGN.md](DESIGN.md)

Quick start:

```bash
pnpm install
docker compose up -d postgres
cp .env.example .env            # then set ADMIN_TOKEN and HERMES_MASTER_KEY
pnpm db:migrate
pnpm test                       # needs a running Docker daemon and the test DB (docs/setup.md)
pnpm demo                       # provision -> restart -> kill -> auto-recover
```

Dashboard preview (separate package): `cd apps/web && pnpm install && pnpm dev` (http://localhost:3100).

## Running all servers

| Service | Dir | Command | URL |
| --- | --- | --- | --- |
| Postgres (5433) + Redis (6380) | root | `docker compose up -d postgres redis` | 127.0.0.1 |
| Backend API + reconciler | root | `pnpm dev` (after `pnpm install`, `.env`, `pnpm db:migrate`) | 127.0.0.1:3000 (`PORT`) |
| Dashboard | `apps/web` | `pnpm install && pnpm dev` | http://localhost:3100/dashboard |
| Docs site | `apps/docs` | `pnpm install && pnpm dev` | http://localhost:3200/docs |
| Landing | `apps/landing` | `pnpm install && pnpm dev` | http://localhost:3300 |
| E2E (optional) | `e2e` | `pnpm build:t0 && pnpm test:t0` | n/a |

Notes:

- Node >= 22. Each app has its own lockfile, so run `pnpm install` in each directory.
- Root `.env` (from `.env.example`) needs `ADMIN_TOKEN` (>= 24 chars) and `HERMES_MASTER_KEY` (>= 32 chars). Never commit values.
- The dashboard runs on mock data by default. To use the real backend set
  `NEXT_PUBLIC_HERMES_API_MODE=customer` and `NEXT_PUBLIC_HERMES_API_URL`.
- Ports are fixed: the dashboard, docs and landing scripts pin `--port` to 3100, 3200 and 3300, and the
  backend uses `PORT` (default 3000). Do not change them: the Supabase redirect, `DASHBOARD_ORIGIN` and the
  e2e tests expect these values. If a port is busy, stop the process holding it instead of picking another
  (check with `netstat -ano | findstr :3100` on Windows).
- More detail: [docs/setup.md](docs/setup.md).
