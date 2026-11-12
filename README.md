# Hermes Cloud

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
