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
| Backend API + reconciler | root | `PORT=3400 DASHBOARD_ORIGIN=http://localhost:3500 pnpm dev` (after `pnpm install`, `.env`, `pnpm db:migrate`) | 127.0.0.1:3400 |
| Dashboard | `apps/web` | `pnpm install && pnpm exec next dev --port 3500` | http://localhost:3500/dashboard |
| Docs site | `apps/docs` | `pnpm install && pnpm exec next dev --port 3800` | http://localhost:3800/docs |
| Landing | `apps/landing` | `pnpm install && pnpm exec next dev --port 3300` | http://localhost:3300 |
| E2E (optional) | `e2e` | `pnpm build:t0 && pnpm test:t0` | n/a |

Notes:

- Node >= 22. Each app has its own lockfile, so run `pnpm install` in each directory.
- Root `.env` (from `.env.example`) needs `ADMIN_TOKEN` (>= 24 chars) and `HERMES_MASTER_KEY` (>= 32 chars). Never commit values.
- The dashboard runs on mock data by default. To use the real backend set
  `NEXT_PUBLIC_HERMES_API_MODE=customer` and `NEXT_PUBLIC_HERMES_API_URL`.
- Local ports: backend 3400, dashboard 3500, docs 3800, landing 3300. Ports 3000, 3100, 3200, 3600, 3700 and
  4200 are reserved for other projects on this machine, so do not use them. The `package.json` dev scripts
  still default to 3100, 3200 and 3300, which is why the commands above pass the port explicitly. If a port is
  busy, stop the process holding it (`netstat -ano | findstr :3500` on Windows).
- More detail: [docs/setup.md](docs/setup.md).
