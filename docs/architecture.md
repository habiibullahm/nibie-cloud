# Architecture (runtime foundation and official-image hardening)

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
| Non-root | `User` is deliberately **not pinned**: the official image's s6-overlay entrypoint starts as root, then drops to `hermes` (10000:10000) | `hardening.test.ts`; `isolation.test.ts` (gateway process runs as `hermes`); live harness against the official image |
| Not privileged / no host namespaces | `Privileged:false`, no `PidMode/IpcMode/NetworkMode host`, no devices | `hardening.test.ts`, `isolation.test.ts` |
| Drop capabilities, no-new-privileges | `CapDrop:[ALL]` then `CapAdd` of exactly eight caps the s6 init needs (`SETUID SETGID CHOWN DAC_OVERRIDE FOWNER KILL AUDIT_WRITE SETFCAP`); `no-new-privileges:true`; the gateway process has no effective caps after the privilege drop | `hardening.test.ts`; `isolation.test.ts`; live harness |
| seccomp/AppArmor | Docker defaults retained, `unconfined` is never set | `hardening.test.ts` (config only) |
| CPU / RAM / PID limits | `NanoCpus`, `Memory` (= `MemorySwap`), `PidsLimit` from the plan | `isolation.test.ts` (fork bomb stopped, over-allocation killed) |
| No Docker socket, no broad host mounts | Only the tenant named volume at `/opt/data` | `isolation.test.ts`; live harness |
| Read-only rootfs | `ReadonlyRootfs:true` + tmpfs `/run` (`rw,exec,nosuid,64m`), `/tmp` (`rw,noexec,nosuid,64m`) and `/var/run` (`rw,exec,nosuid,16m`); s6-overlay cannot boot without them | `hardening.test.ts`; `isolation.test.ts`; live harness |
| Pinned images | `assertPinnedImage` (no `latest`; digest required in production) | `image-policy.test.ts` |
| Dedicated volume per tenant | `hermes-data-<uuid>` | `persistence.test.ts` |
| Tenant network separation | one bridge per instance, ICC disabled, loopback-only port publish | `isolation.test.ts` (A cannot reach B) |
| Names never from customer text | all Docker names derive from UUIDs | `instance-service.test.ts` |
| Per-instance API key | `API_SERVER_KEY` derived as HMAC-SHA256 of `HERMES_MASTER_KEY` and the instance id; never stored, logged or returned | `api-key.test.ts`; `key-wiring.test.ts`; live harness |
| Strict readiness | with a key, only an authenticated HTTP 200 on `/api/sessions` is ready; 401 means the key was rejected | `runtime-health.test.ts`; `key-wiring.test.ts` |
| Runtime selection | `HERMES_RUNTIME` (`runc` default, `runsc` for gVisor), checked against the daemon at startup | `runtime-availability.test.ts`; live harness (runc re-run, runsc reported) |

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

Implemented for the official `nousresearch/hermes-agent` image (pinned by digest; v0.23.1 is
`sha256:276d44685c65c0cb2a25f190b63c65c8906f9dc76486fb1c05ae71b5826bda08`). The constants live in
`src/modules/runtime/hardening.ts`.

- **Port and data.** The gateway listens on `8642` (`API_SERVER_PORT`; `API_SERVER_HOST=0.0.0.0` is
  injected so Docker's loopback port publish can reach it). All state lives under `/opt/data`, mounted
  from the tenant's named volume. The command is `gateway run`.
- **User.** The container user is not pinned. The image's s6-overlay init starts as root, creates
  `/run/hermes-service`, chowns the data volume and drops to `hermes` (10000:10000).
- **Capabilities.** `CapDrop: [ALL]` alone makes the init exit-loop. Exactly eight are re-added:
  `SETUID SETGID CHOWN DAC_OVERRIDE FOWNER KILL AUDIT_WRITE SETFCAP`. The set comes from the
  Milestone 2.2 canary matrix ([milestone-2-runtime-security.md](milestone-2-runtime-security.md)).
- **Root filesystem.** Read-only, with tmpfs at `/run`, `/tmp` and `/var/run` (see the hardening table).
- **Init.** `Init: false`: the image is PID 1 with its own s6 dispatcher.
- **Authentication and readiness.** The control plane gives each instance an `API_SERVER_KEY`
  derived from `HERMES_MASTER_KEY` and the instance id, so the Reconciler can recreate a container
  with the key it had. The key is baked into the container environment at creation: rotating the
  master key requires recreating instances. An instance is ready only when `GET /api/sessions`
  answers 200 with that key. If a running container answers 401 to its key, the Reconciler marks it
  `DEGRADED` with reason `auth_rejected` straight away and does not restart it (a restart keeps the old key). Without a key, 200 or 401 still proves the daemon is alive.
- **Runtime.** `HERMES_RUNTIME=runc` (default) or `runsc` (gVisor). Like the key, it applies only to
  containers created from now on; see "Recreating an existing instance's container" in [setup.md](setup.md).

`test/fixtures/hermes-stub` (`hermes-stub:0.2.0`) follows this contract closely enough to fail the
same way when the hardening is wrong: it starts as root, needs CHOWN, SETUID and SETGID to drop to
uid 10000, serves a Bearer-protected `/api/sessions` on 8642 and keeps state in `/opt/data`. It is
**only a stand-in**; the live harness against the pinned official image is the source of truth.

## Known gaps and deferred security work

This system is **not production-ready**. Open items, none of which are mitigated yet:

1. **Disk quota not enforced.** Named volumes have no size limit (`Plan.storageMb` is stored, not enforced). Needs xfs project quotas or per-tenant quota-capable storage. A tenant can fill the node's disk; log growth is also unbounded.
2. **No network egress controls / SSRF defence (PRD 7.3).** Tenants are isolated from each other, but containers can still reach the internet, the host's bridge gateway, other host services and cloud metadata addresses. Requires host firewall rules (nftables/iptables on `DOCKER-USER`), validated custom URLs and DNS rebinding defence.
3. **Runtime isolation not fully validated (PRD 7.2).** `runc` is the default. gVisor (`runsc`) is selectable and was reported compatible, but it is not the default and has had no escape or kernel-exposure testing; no microVM evaluation; seccomp/AppArmor not verified on target hosts (the dev sandbox uses cgroup v1).
4. **Real Hermes image only partly validated.** The pinned official image boots under the hardened baseline and answers authenticated requests in the live harness (see [milestone-2-runtime-security.md](milestone-2-runtime-security.md)). Not validated: production hosts and kernels, behaviour under a real model backend, the telegram transport, and what the image does with no `API_SERVER_KEY`.
5. **Operator API only.** Single shared bearer token; no users, tenant membership, rate limits, CSRF or audit log. Never expose it publicly; it binds to loopback.
6. **Provisioning is synchronous and in-process;** no job queue, dead-letter queue or outbox. A control-plane crash mid-operation is cleaned up by the lease-based reaper after the lease expires (≤ TTL, 60 s by default): it fails or finishes the operation but does not resume it. Several control-plane replicas are unsupported: the lease protects individual operations, but there is no leader election for the reconciler loop, and clock skew between replicas/DB is not handled. A Docker call that hangs without erroring holds its lease until `maxOperationMs`.
7. **Single node, no scheduler or capacity reservation;** the host port is a random loopback port, with no ingress or TLS.
8. **No secrets management** (envelope encryption, rotation). Per-instance API keys are derived from one master secret in the environment and are never stored, but there is no rotation and no vault; log redaction is by key path only, so free-text secrets in messages would not be caught.
9. **No backups/restore, customer shell/file broker, metrics, or suspend/grace/retention lifecycle.**
10. `STOPPED`/`STOPPING` are not in PRD 10.2 (ADR 0001); `Plan` has no pricing by design.
11. The PID/OOM behaviour was verified on the dev sandbox kernel (cgroup v1); re-verify on the production host kernel/cgroup v2.
