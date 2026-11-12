# ADR 0002: Hardened container baseline and Reconciler-owned restarts

**Status:** accepted (Milestone 1). Not a substitute for the isolation review in PRD 7.2.

**Decision.** Every tenant container: uid/gid 10001, read-only root filesystem with a small
`noexec` tmpfs at `/tmp`, one named volume at `/data`, `CapDrop ALL`, `no-new-privileges`,
Docker's default seccomp/AppArmor profiles (never `unconfined`), not privileged, no host
network/PID/IPC, no devices, memory limit with swap disabled, CPU quota, PID limit, `init: true`,
a dedicated bridge network per tenant with inter-container communication disabled, and ports
published to `127.0.0.1` only. Env keys starting with `DOCKER_` are refused. Images must be pinned.

`RestartPolicy` is `no`: crash recovery belongs to the Reconciler (bounded attempts, exponential
backoff with jitter, then `DEGRADED` + `recovery.exhausted` for an operator) so that failures stay
visible and a crash loop cannot spin forever. Only gateway readiness is probed, so an upstream
model-provider outage never causes a restart (PRD 8.3, 13.2).

**Consequences.** Hermes must work with a read-only root and non-root user (image contract in
architecture.md). A real Hermes image may need adjustments (extra tmpfs paths, seccomp tuning);
record them here when validated.

## Amendment 2026-11-12: official image contract

Validating the official `nousresearch/hermes-agent` image changed parts of the decision above; the
current values are in [architecture.md](../architecture.md#image-contract). Superseded: uid/gid
10001 (the container user is not pinned; the image's s6-overlay init drops to `hermes` 10000:10000),
volume at `/data` (now `/opt/data`), `CapDrop ALL` alone (now `ALL` plus eight re-added caps),
`/tmp`-only tmpfs (now `/run`, `/tmp`, `/var/run`) and `init: true` (now `Init: false`: the image is
PID 1 with its own s6 dispatcher). Unchanged: read-only root, `no-new-privileges`, default
seccomp/AppArmor, not privileged, resource limits, per-tenant bridge with ICC disabled, loopback-only
publishing, `RestartPolicy: no` with Reconciler-owned recovery.
