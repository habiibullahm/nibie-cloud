# Architecture (Milestone 1: Hermes runtime foundation)

Source of truth: [prd.md](prd.md). This document records what is built, how it maps to the PRD,
and, importantly, what is **not** built yet.

## Overview

```
 operator (bearer token, loopback)
        |
   src/http  ──────────────►  src/modules/instances ──► PostgreSQL (Prisma)
  (Fastify, /api/v1)           InstanceService  Reconciler
                                       |
                                       ▼  RuntimeManager interface
                               src/modules/runtime ──► Docker Engine API (dockerode)
                                                          └─ one container + one volume + one network per instance
```

One Node/TypeScript modular monolith (ADR 0001). Only `src/modules/runtime` talks to Docker
(PRD 6.3). The Docker socket is used by the control plane only; it is never mounted into, or
reachable from, a tenant container.

## Data model (`prisma/schema.prisma`)

`Tenant`, `Plan` (resource limits only; pricing is unapproved), `RuntimeNode` (single `local` row
for now), `Instance`, `InstanceEvent` (append-only, pre-sanitized). UUID ids, UTC `timestamptz`.
`Instance` is unique on `(tenantId, idempotencyKey)`; foreign keys are `RESTRICT`, so history is
never cascaded away. Users, memberships, subscriptions, payments, secrets, backups: later milestones.

## Instance lifecycle

```
PENDING → PROVISIONING → CONFIGURING → STARTING → ACTIVE ⇄ DEGRADED
ACTIVE|DEGRADED → STOPPING → STOPPED → STARTING        (stop / start)
ACTIVE|DEGRADED → STARTING → ACTIVE|DEGRADED           (restart)
PROVISIONING|CONFIGURING|STARTING → FAILED → PROVISIONING   (retry with same idempotency key)
ACTIVE|DEGRADED|STOPPED|FAILED → DELETING → DELETED
```

Every transition is a database compare-and-set plus an event in one transaction; the loser of a
race gets `409`. `provision` is idempotent per `(tenant, idempotency key)`: the key is **bound to
its original request** (`name` + `planId`), so reusing it with a different payload answers
`409 Conflict` instead of silently returning the other instance. It runs synchronously
in-process today (the API still answers `202`).

**Operation leases.** Each transitional status (`PROVISIONING`, `CONFIGURING`, `STARTING`,
`STOPPING`, `DELETING`, and reconciler recovery) is owned by one operation: entering it writes
`operationOwner` + `leaseExpiresAt`, a heartbeat renews the lease every TTL/3 (default TTL 60 s)
while the operation runs, the operation's own writes are fenced on `operationOwner`, and entering
a stable status clears the lease. A heartbeat stops after `maxOperationMs` (10 min) so a hung
operation eventually becomes reapable.

**Database errors.** Tenant/plan lookups no longer swallow errors: malformed or unknown ids are
`404`; if Postgres is unreachable the API answers `503 database_unavailable` (sanitized body), never
"not found". Failure reasons stored are fixed codes
(`runtime_create_failed`, `health_check_timeout`, `runtime_unavailable`, …), never raw Docker errors.
If Docker is unreachable, existing instances are left untouched (state reverted/unchanged) and the
API answers `503`.

## Runtime hardening (PRD 7.1 baseline)

| Requirement | Implementation | Verified by |
| --- | --- | --- |
| Non-root | `User 10001:10001` | `isolation.test.ts` (`id -u`) |
| Not privileged / no host namespaces | `Privileged:false`, no `PidMode/IpcMode/NetworkMode host`, no devices | `hardening.test.ts`, `isolation.test.ts` |
| Drop capabilities, no-new-privileges | `CapDrop:[ALL]`, `no-new-privileges:true`; effective caps = 0 | `isolation.test.ts` |
| seccomp/AppArmor | Docker defaults retained, `unconfined` is never set | `hardening.test.ts` (config only) |
| CPU / RAM / PID limits | `NanoCpus`, `Memory` (= `MemorySwap`), `PidsLimit` from the plan | `isolation.test.ts` (fork bomb stopped, over-allocation killed) |
| No Docker socket, no broad host mounts | Only the tenant named volume at `/data` | `isolation.test.ts` |
| Read-only rootfs | `ReadonlyRootfs:true` + `/tmp` tmpfs (`noexec,nosuid,64m`) | `isolation.test.ts` |
| Pinned images | `assertPinnedImage` (no `latest`; digest required in production) | `image-policy.test.ts` |
| Dedicated volume per tenant | `hermes-data-<uuid>` | `persistence.test.ts` |
| Tenant network separation | one bridge per instance, ICC disabled, loopback-only port publish | `isolation.test.ts` (A cannot reach B) |
| Names never from customer text | all Docker names derive from UUIDs | `instance-service.test.ts` |

## Recovery (`Reconciler`)

Every 15 s (and on demand) for `ACTIVE`/`DEGRADED` instances: a missing/exited container is re-`ensure`d
(same volume) and started, with at most 3 attempts and exponential backoff with jitter
(2 s × 2ⁿ, cap 60 s). Before touching Docker the reconciler *claims* the instance
(`→ STARTING`), so a concurrent user stop/delete/restart gets `409` instead of racing it.
Recovery attempts are only forgiven after the restarted container has stayed up for a stability
window (default 5 min), so a container that passes one health check and then crashes again still
exhausts its attempts; after that the instance stays `DEGRADED` (`recovery_exhausted`) with a single
`recovery.exhausted` event and no further restarts until an operator restarts it. A running but
unhealthy container is marked `DEGRADED` and restarted only after 3 consecutive failed probes.
Docker outages cause `skipped`, never state changes or burned attempts. `STOPPED` instances are
never restarted.

Abandoned operations (control-plane crash, DB blip) are resolved by `reapStale()`. An operation
counts as abandoned **only when its lease has expired**; a live operation keeps renewing its lease,
however long it takes, and is never touched. (Rows with no lease fall back to "no update for 5 min".)
Every reaper write is fenced on the lease still being expired, so a renewal that lands after the scan
wins. Resolutions: `PENDING/PROVISIONING/CONFIGURING → FAILED(stalled)` (retry with the same
idempotency key), `STARTING → DEGRADED(stalled)` (normal recovery follows), `STOPPING → STOPPED` and
`DELETING → DELETED` (the reaper first takes over the lease, then finishes the job). A zombie
operation that lost its lease cannot overwrite the outcome (its writes are fenced), and only stops
the container if the instance is still `FAILED`.

## Image contract

The runtime image must: listen on `8080`; answer `GET /healthz` 200 when the gateway is ready;
keep all state under `/data` (pre-created, owned by `10001:10001` in the image so new volumes
inherit ownership); run as uid `10001`; work with a read-only root filesystem, writable
`/tmp` and `/data`; and not need extra capabilities. `test/fixtures/hermes-stub` meets this and is
**only a stand-in**: compatibility with the real Hermes image is unverified.

## Known gaps and deferred security work

This system is **not production-ready**. Open items, none of which are mitigated yet:

1. **Disk quota not enforced.** Named volumes have no size limit (`Plan.storageMb` is stored, not enforced). Needs xfs project quotas or per-tenant quota-capable storage. A tenant can fill the node's disk; log growth is also unbounded.
2. **No network egress controls / SSRF defence (PRD 7.3).** Tenants are isolated from each other, but containers can still reach the internet, the host's bridge gateway, other host services and cloud metadata addresses. Requires host firewall rules (nftables/iptables on `DOCKER-USER`), validated custom URLs and DNS rebinding defence.
3. **Runtime isolation not validated (PRD 7.2).** Standard hardened `runc` containers only. No gVisor/microVM evaluation, no escape or kernel-exposure testing, seccomp/AppArmor not verified on target hosts (the dev sandbox uses cgroup v1).
4. **Real Hermes image unvalidated** (read-only root, uid, ports, health endpoint, telegram transport).
5. **Operator API only.** Single shared bearer token; no users, tenant membership, rate limits, CSRF or audit log. Never expose it publicly; it binds to loopback.
6. **Provisioning is synchronous and in-process;** no job queue, dead-letter queue or outbox. A control-plane crash mid-operation is cleaned up by the lease-based reaper after the lease expires (≤ TTL, 60 s by default): it fails or finishes the operation but does not resume it. Several control-plane replicas are unsupported: the lease protects individual operations, but there is no leader election for the reconciler loop, and clock skew between replicas/DB is not handled. A Docker call that hangs without erroring holds its lease until `maxOperationMs`.
7. **Single node, no scheduler or capacity reservation;** the host port is a random loopback port, with no ingress or TLS.
8. **No secrets management** (envelope encryption, rotation) — no secrets are stored yet; log redaction is by key path only, so free-text secrets in messages would not be caught.
9. **No backups/restore, customer shell/file broker, metrics, or suspend/grace/retention lifecycle.**
10. `STOPPED`/`STOPPING` are not in PRD 10.2 (ADR 0001); `Plan` has no pricing by design.
11. The PID/OOM behaviour was verified on the dev sandbox kernel (cgroup v1); re-verify on the production host kernel/cgroup v2.
