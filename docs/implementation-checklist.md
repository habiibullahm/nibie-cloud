# Implementation checklist — Milestone 1 (Hermes runtime foundation)

Legend: [x] done and covered by tests, [~] done with a documented limitation, [ ] not started (out of scope).
The original plan is [superpowers/plans/2026-11-11-hermes-runtime-foundation.md](superpowers/plans/2026-11-11-hermes-runtime-foundation.md).

## Plan tasks
- [x] 1. Scaffold, config, redacting logger
- [x] 2. Prisma schema + migrations (`init`, `add_stopping_status`, `add_operation_lease`)
- [x] 3. Image pin policy + container hardening builder
- [~] 4. Hermes stub image (stand-in only; real Hermes image **not** validated)
- [x] 5. `DockerRuntimeManager` (ensure/start/stop/restart/inspect/health/remove)
- [x] 6. Isolation + persistence tests
- [x] 7. State machine + `InstanceService`
- [x] 8. Reconciler + bounded recovery
- [x] 9. Operator REST API
- [x] 10. Demo, architecture, setup, ADRs

## Review round 1 (fresh-reviewer findings, all fixed test-first)
- [x] Crash loop that passes one health probe no longer restarts forever (stability window)
- [x] Reconciler claims the instance before acting (no race with user stop/delete)
- [x] Stale transitional states are resolved (reaper)
- [x] No `STOPPED` row with a running container after a Docker blip during start
- [x] Failed provisions stop their container
- [x] Non-vacuous 500/log-redaction tests; reconciler logs error class only

## Review round 2 ([review-fixes.md](review-fixes.md))
- [x] Idempotency key bound to request payload (409) + concurrent/mismatch tests
- [x] DB errors no longer swallowed (404 vs 503 `database_unavailable`) + DB-down tests
- [x] Operation lease + heartbeat; reaper only reaps expired leases + long-running/abandoned tests
- [x] Verification run (build, unit, integration, demo) — results in the thread report
- [x] Docs updated

## Deferred (not started; production blockers)
- [ ] Disk quota enforcement
- [ ] Network egress / SSRF controls
- [ ] Runtime isolation validation (gVisor / microVM, escape tests)
- [ ] Real Hermes image validation
- [ ] Customer auth + tenant membership, rate limits, audit log
- [ ] Job queue / outbox, multi-node scheduler, ingress/TLS
- [ ] Secrets management, backups, billing/subscription lifecycle, metrics/alerts
- [ ] Minor review items: no-op answer for retried stop/delete in flight; counters reset on degraded restart; exact dependency pins
