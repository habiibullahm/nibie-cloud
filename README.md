# Nibie Cloud

Managed hosting for Hermes AI agents: one dedicated, isolated container plus one volume per customer.
The repository holds five standalone packages (no pnpm workspace):

- **Backend** (repo root): Fastify customer, admin and operator APIs, Docker runtime manager with the
  hardening baseline for the official Hermes image, reconciler, BullMQ jobs, encrypted secrets, billing
  (SumoPod by default, Duitku optional), NibieRouter provisioning and the free beta waiting list.
- **Dashboard** ([apps/web](apps/web/README.md)): customer dashboard and admin panel (Next.js 16, shadcn/ui).
  Mock data by default; real data with `NEXT_PUBLIC_HERMES_API_MODE=customer`.
- **Docs** ([apps/docs](apps/docs/README.md)): customer documentation site (Fumadocs, Indonesian).
- **Landing** ([apps/landing](apps/landing/README.md)): public landing page for `cloud.nibie.app` (Indonesian).
- **E2E** ([e2e](e2e/README.md)): Playwright browser tests (T0 mock, T1 full stack, T2 production smoke).

> **Status: free beta, NOT production-ready.** The backend runs on one VPS (gVisor runtime, XFS quota and
> egress rules verified there); the free beta is open and paid checkout is closed until a real-money
> payment has worked. Open security and verification gaps:
> [Known gaps](docs/architecture.md#known-gaps-and-deferred-security-work). Integration tests run against
> a stand-in stub image.

- Current status and open decisions: [docs/CURRENT_STATE.md](docs/CURRENT_STATE.md)
- Handoff for a new person or session: [docs/HANDOFF.md](docs/HANDOFF.md)
- All documentation: [docs/README.md](docs/README.md)
- Source of truth for scope: [docs/prd.md](docs/prd.md)
- Setup and running: [docs/setup.md](docs/setup.md) · deployment: [deploy/README.md](deploy/README.md)
- Agent instructions: [AGENTS.md](AGENTS.md) · design rules: [DESIGN.md](DESIGN.md)

Quick start (backend):

```bash
pnpm install
docker compose up -d postgres redis
cp .env.example .env            # then set ADMIN_TOKEN and HERMES_MASTER_KEY
pnpm db:migrate
pnpm test                       # needs a running Docker daemon and the test DB (docs/setup.md)
pnpm demo                       # provision -> restart -> kill -> auto-recover
```

Each app is its own package: `cd apps/web && pnpm install && pnpm dev` (http://localhost:3100); commands for
the others are in their READMEs and in [AGENTS.md](AGENTS.md).
