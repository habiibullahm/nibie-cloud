# Hermes Cloud

Managed hosting for Hermes AI agents. This repository currently contains **Milestone 1: the
Hermes runtime foundation** (backend only: no dashboard, billing, auth or scheduler yet).

> **Status: NOT production-ready.** Disk quota enforcement, network egress controls and
> runtime-isolation validation are incomplete (see [Known gaps](docs/architecture.md#known-gaps-and-deferred-security-work)).
> Compatibility with the real Hermes image has **not** been validated; everything is tested
> against a stand-in stub image.

- Source of truth: [docs/prd.md](docs/prd.md)
- Architecture and decisions: [docs/architecture.md](docs/architecture.md), [docs/adr/](docs/adr)
- Setup and running: [docs/setup.md](docs/setup.md)
- Review fixes: [docs/review-fixes.md](docs/review-fixes.md) · checklist: [docs/implementation-checklist.md](docs/implementation-checklist.md)
- Implementation plan: [docs/superpowers/plans/](docs/superpowers/plans)

Quick start:

```bash
pnpm install
docker compose up -d postgres
cp .env.example .env            # then set ADMIN_TOKEN
pnpm db:migrate
pnpm test                       # needs a running Docker daemon
pnpm demo                       # provision -> restart -> kill -> auto-recover
```
