# Documentation index

Start with [CURRENT_STATE.md](CURRENT_STATE.md). Where two documents disagree, the repository and
real tool output win, then CURRENT_STATE, then everything else.

## Living documents (keep up to date)

| Document | What it is |
| --- | --- |
| [prd.md](prd.md) | Product requirements v1.0, the source of truth for scope. Do not edit without the owner. |
| [CURRENT_STATE.md](CURRENT_STATE.md) | Verified status: commits, what was tested and where, known issues, open decisions. |
| [HANDOFF.md](HANDOFF.md) | Single-page handoff for a new person or session: architecture, repo map, deploy, env names, status per PR, working rules, prioritised to-do (2026-11-17). |
| [START_PROMPT.md](START_PROMPT.md) | Paste-ready opening prompt (Indonesian) for a new session. |
| [architecture.md](architecture.md) | What the backend builds today, the hardening table, the image contract, known gaps (refreshed 2026-11-18). |
| [capacity.md](capacity.md) | Per-container RAM/CPU usage log and when the VPS must grow. |
| [setup.md](setup.md) | Prerequisites, first run, commands, configuration variables, operator API usage. |
| [milestone-2-runtime-security.md](milestone-2-runtime-security.md) | Milestone 2.2 runtime-security evidence. A partial reconstruction; each result is tagged re-run or reported. |
| [disk-quota-host-notes.md](disk-quota-host-notes.md) | What was and was not verified about Docker volume quotas on a real host. |
| [egress-host-notes.md](egress-host-notes.md) | What was and was not verified about the egress ruleset, bridge names and the canary. Its "no tenant traffic yet" notes are superseded by the VPS checks in CURRENT_STATE. |
| [runbook-egress.md](runbook-egress.md) | Operator runbook: check the rules, add an exception, what to do when the canary or `network_policy_missing` fails. |
| [runbook-payments.md](runbook-payments.md) | Operator runbook for SumoPod payments: daily check, resending webhooks, what each webhook outcome means, settings that must not change. |
| [runbook-restore.md](runbook-restore.md) | Database backups: what runs when, the daily check, a safe restore test, and restoring the production `hermes` schema (not rehearsed). |
| [billing-go-live.md](billing-go-live.md) | Setting up or switching the SumoPod gateway: variables, VPS steps, sandbox to production, rollback. |
| [../deploy/README.md](../deploy/README.md) | Single-VPS production deployment (Compose, Caddy, XFS quota, egress): order of work, what was verified on a real host and what was not. |
| [adr/](adr) | Architecture decision records: [0001](adr/0001-docker-direct-no-orchestrator.md), [0002](adr/0002-hardened-container-baseline.md), [0003](adr/0003-hermes-config-delivery.md). |

Also outside `docs/`: [../AGENTS.md](../AGENTS.md) (agent instructions shared by every coding agent;
`CLAUDE.md` only loads it), [../DESIGN.md](../DESIGN.md) (design tokens and rules),
[../design-preview.html](../design-preview.html) (specimen sheet for DESIGN.md), and the package READMEs:
[dashboard](../apps/web/README.md), [docs site](../apps/docs/README.md), [landing](../apps/landing/README.md),
[e2e](../e2e/README.md).

## Historical records (do not update; kept for traceability)

| Document | What it records |
| --- | --- |
| [SESSION_HANDOFF.md](SESSION_HANDOFF.md) | Handoff entries from the 2026-11-12 design-foundation, handoff and hardening-wiring runs. |
| [HANDOFF_TO_CLAUDE.md](HANDOFF_TO_CLAUDE.md) | State-transfer snapshot taken at commit `b7bd10e`. Several statements in it are no longer true; see its banner. |
| [implementation-checklist.md](implementation-checklist.md) | Milestone 1 plan tasks and review rounds. |
| [review-fixes.md](review-fixes.md) | Milestone 1 review round 2 fixes. |
| [superpowers/plans/](superpowers/plans) | Implementation plans: runtime foundation (2026-11-11), hardening wiring, frontend dashboard, disk quota, egress controls and backend milestones A (2026-11-12), B and C (2026-11-13). |
| [superpowers/specs/](superpowers/specs) | Design specs: hardening wiring, disk quota and egress controls, and the backend design (customer API, jobs, secrets, billing; 2026-11-12, milestones B to D not built). Also [instance self-management](superpowers/specs/2026-11-19-instance-self-management-design.md) (web shell, file manager, config editor, self-recovery; 2026-11-19, not built). |
