# Documentation index

Start with [CURRENT_STATE.md](CURRENT_STATE.md). Where two documents disagree, the repository and
real tool output win, then CURRENT_STATE, then everything else.

## Living documents (keep up to date)

| Document | What it is |
| --- | --- |
| [prd.md](prd.md) | Product requirements v1.0, the source of truth for scope. Do not edit without the owner. |
| [CURRENT_STATE.md](CURRENT_STATE.md) | Verified status: commits, what was tested and where, known issues, open decisions. |
| [architecture.md](architecture.md) | What the backend builds today, the hardening table, the image contract, known gaps. |
| [setup.md](setup.md) | Prerequisites, first run, commands, configuration variables, operator API usage. |
| [milestone-2-runtime-security.md](milestone-2-runtime-security.md) | Milestone 2.2 runtime-security evidence. A partial reconstruction; each result is tagged re-run or reported. |
| [disk-quota-host-notes.md](disk-quota-host-notes.md) | What was and was not verified about Docker volume quotas on a real host. |
| [egress-host-notes.md](egress-host-notes.md) | What was and was not verified about the egress ruleset, bridge names and the canary. Nothing has seen tenant traffic yet. |
| [runbook-egress.md](runbook-egress.md) | Operator runbook: check the rules, add an exception, what to do when the canary or `network_policy_missing` fails. |
| [adr/](adr) | Architecture decision records: [0001](adr/0001-docker-direct-no-orchestrator.md), [0002](adr/0002-hardened-container-baseline.md), [0003](adr/0003-hermes-config-delivery.md). |

Also outside `docs/`: [../AGENTS.md](../AGENTS.md) (agent instructions), [../DESIGN.md](../DESIGN.md)
(design tokens and rules), [../design-preview.html](../design-preview.html) (specimen sheet for
DESIGN.md), [../apps/web/README.md](../apps/web/README.md) (dashboard).

## Historical records (do not update; kept for traceability)

| Document | What it records |
| --- | --- |
| [SESSION_HANDOFF.md](SESSION_HANDOFF.md) | Handoff entries from the 2026-11-12 design-foundation, handoff and hardening-wiring runs. |
| [HANDOFF_TO_CLAUDE.md](HANDOFF_TO_CLAUDE.md) | State-transfer snapshot taken at commit `b7bd10e`. Several statements in it are no longer true; see its banner. |
| [implementation-checklist.md](implementation-checklist.md) | Milestone 1 plan tasks and review rounds. |
| [review-fixes.md](review-fixes.md) | Milestone 1 review round 2 fixes. |
| [superpowers/plans/](superpowers/plans) | Implementation plans: runtime foundation (2026-11-11), hardening wiring, frontend dashboard, disk quota, egress controls and backend milestones A (2026-11-12), B and C (2026-11-13). |
| [superpowers/specs/](superpowers/specs) | Design specs: hardening wiring, disk quota and egress controls, and the backend design (customer API, jobs, secrets, billing; 2026-11-12, milestones B to D not built). |
