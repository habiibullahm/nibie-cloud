# ADR 0001: Drive Docker directly from a modular monolith; no orchestrator

**Status:** accepted (Milestone 1)

**Context.** PRD 6.2 asks for a simple MVP, a runtime manager as the only component allowed to
touch containers (6.3), and no Kubernetes without demonstrated need. Private beta is 5–10 tenants.

**Decision.** A single Node/TypeScript service. The `runtime` module wraps the Docker Engine API
(`dockerode`) behind a `RuntimeManager` interface; `instances` depends only on that interface.
Docker resources are named from instance UUIDs (`hermes-<id>`, `hermes-data-<id>`, `hermes-net-<id>`)
so every operation is idempotent and retries cannot create duplicates. Lifecycle calls run
in-process for now; their compare-and-set status transitions make them safe to move behind
BullMQ later.

**Consequences.** Simple to operate and test. A second node needs a remote-capable
`RuntimeManager` (Docker over TLS/SSH or an agent) plus the scheduler. Revisit orchestration only
when measured complexity demands it.

**Related decision: `STOPPING`/`STOPPED` statuses.** Not in PRD 10.2, but customer stop/start
needs them; `STOPPING` is transitional so a concurrent restart/delete is rejected (409) instead
of interleaving with an in-flight stop. Map them to customer-facing statuses when the dashboard exists.
