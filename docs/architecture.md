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

The customer dashboard (`apps/web`, a separate Next.js package) is documented in
[../apps/web/README.md](../apps/web/README.md). In `live` mode it still reaches the operator instance
endpoints through a server-side dev bridge; moving it to the customer API below is frontend work
that has not been done.

### API surfaces (`src/http`)

Two surfaces under `/api/v1`, registered as separate Fastify plugins so neither's auth hook applies
to the other (`customer-auth.test.ts` checks both directions):

| Surface | Auth | Paths | File |
| --- | --- | --- | --- |
| Operator | bearer `ADMIN_TOKEN` | `/tenants/:tenantId/instances...` | `operator-routes.ts` |
| Customer | Supabase access token (JWT) | `/me`, `/plans`, `/instances...` | `customer-routes.ts`, `customer-auth.ts` |

The customer surface exists only when `SUPABASE_URL` is set. `src/modules/auth/token-verifier.ts`
verifies the token locally against the project's JWKS (asymmetric algorithms only, pinned issuer and
audience, UUID `sub`); every failure is the same opaque `401`. `identity-service.ts` maps the `sub`
to a `User`, a personal `Tenant` and an `OWNER` membership, created on the first request and safe
under concurrent first requests. The tenant always comes from that membership, never from the
request, so another tenant's instance id is a `404` on every verb (`customer-api.test.ts`).

Until payments exist, `POST /instances` is allowed only for emails in `BETA_ALLOWED_EMAILS` (empty:
nobody) and capped at `MAX_INSTANCES_PER_TENANT` non-deleted instances; the count and insert run
under a per-tenant advisory lock. Details and the milestones that follow:
[superpowers/specs/2026-11-12-backend-design.md](superpowers/specs/2026-11-12-backend-design.md).

One Node/TypeScript modular monolith (ADR 0001). Only `src/modules/runtime` talks to Docker
(PRD 6.3). The Docker socket is used by the control plane only; it is never mounted into, or
reachable from, a tenant container.

## Data model (`prisma/schema.prisma`)

`Tenant`, `Plan` (resource limits only; pricing is unapproved), `RuntimeNode` (single `local` row
for now), `Instance`, `InstanceEvent` (append-only, pre-sanitized). UUID ids, UTC `timestamptz`.
`Instance` is unique on `(tenantId, idempotencyKey)`; foreign keys are `RESTRICT`, so history is
never cascaded away. `User` (id = Supabase user id) and `TenantMember` (role `OWNER`; unique on
`userId`, so one user has one tenant for the beta) back the customer API. `Plan` has a display `name`
and an `active` flag. Subscriptions, payments, secrets, backups: later milestones.

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
| Disk quota | with `HERMES_DISK_QUOTA=enforce` (default; `off` is refused in production) the volume is created with Docker's local-volume `size` option from `Plan.storageMb`, enforced by XFS project quotas, so a full tenant gets ENOSPC without affecting others. An existing volume without a quota is refused (`volume_quota_missing`); a quota that differs from the plan records one `disk.quota_mismatch` event. Startup probes that Docker accepts the option | `volume-quota.test.ts`; `disk-quota-check.test.ts`; `disk-wiring.test.ts`. The kernel enforcement itself is **not verified yet** (needs an XFS host, see `disk-quota-host-notes.md`) |
| Log rotation | `json-file`, `max-size` 10m, `max-file` 3 on every tenant container (about 30 MB per tenant on the host, outside the volume quota) | `hardening.test.ts` |
| Disk usage events | `DiskMonitor` reads all volume sizes in one Docker call every `HERMES_DISK_CHECK_INTERVAL_MS` (default 5 min) and records `disk.warning` (>= 90%), `disk.full` (>= 99%) and `disk.ok` (< 85%) once per level change, with hysteresis. It never changes `status` or restarts a container | `disk-level.test.ts`; `disk-monitor.test.ts` |
| Tenant network separation | one bridge per instance, ICC disabled, loopback-only port publish | `isolation.test.ts` (A cannot reach B) |
| Network identity | each tenant bridge is named `hn` + the first 12 hex characters of the instance id and has IPv6 off (`buildNetworkConfig`). With `HERMES_EGRESS_POLICY=enforce` (default; `off` is refused in production) an existing network without that name, or a bridge-name collision (Docker answers 403), is refused with `network_policy_missing`, also on user start, user restart and the reconciler's restart (`assertNetworkPolicy`); Docker cannot rename a bridge, so the fix is delete and reprovision | `network-config.test.ts`; `network-policy.test.ts` (unit, fake Docker, and Postgres-only wiring); checked once against a real daemon |
| Host egress ruleset | `ops/egress/hermes-egress.sh` owns chain `HERMES-EGRESS`, jumped to from `DOCKER-USER` and `INPUT` for `-i hn+`: established, DNS to configured resolvers, optional `ip:port` exceptions (empty by default), TCP 25 reject, per-source new-connection cap (**placeholder value, not measured**), rejects for private, link-local (metadata), reserved and host-local destinations, then `RETURN`. `apply` replaces the chain in one atomic `iptables-restore` transaction and closes tenant IPv6 with `ip6tables` drops; the systemd unit never removes the rules on stop or restart | `egress-rules.test.ts` (rules printed by `--dry-run`); the script was applied for real once on a sandbox kernel. **No tenant traffic has hit it yet** (see `egress-host-notes.md`) |
| Egress canary | with `enforce`, startup runs a short-lived container on a temporary `hn` network (image pinned by digest, all caps dropped, read-only, small limits) that tries listeners the control plane opened on the bridge gateway and on `HERMES_CANARY_PRIVATE_IP`, and `169.254.169.254:80`. A connection means a rule is missing and the process exits; the message names only the failed check. It first proves its `nc` can listen and connect on loopback, runs under `HERMES_RUNTIME`, and only the metadata probe takes the forwarding path, so it is a tripwire for the `INPUT` side and not an audit (`hermes-egress.sh status` checks the `DOCKER-USER` jump) | `egress-canary.test.ts` (fake Docker); `egress-canary.test.ts` integration (real daemon: missing image); the positive and negative cases need an image and a host with the rules (Task 8) |
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

1. **Disk quota implemented, not verified on an XFS host.** Volumes are created with a size limit and usage events exist (see the hardening table), but the kernel enforcement has only been checked against Docker's refusal on ext4 so far. Still open: resizing a quota after a plan change (quota is set at creation only, so plan changes must not be offered yet), inode limits, node-level disk pressure and "stop scheduling on a full node" (PRD 13.2), and the host log files outside the quota.
2. **Egress controls implemented, not verified on a Docker host (PRD 7.3).** Tenants cannot reach the host, cloud metadata, private ranges or each other once the ruleset in `ops/egress/` is applied, TCP 25 is rejected and new connections are rate-capped, and the control plane exits in production if the canary shows the rules are missing. Not verified: that real tenant traffic hits the rules (runc and runsc), that the rules survive a Docker restart and a reboot, DNS on the real host, and the rate cap, which is an unmeasured placeholder (see [egress-host-notes.md](egress-host-notes.md); plan Task 8 is open). Still open by design: a domain allowlist or egress proxy, traffic metering, URL validation for custom provider and webhook URLs (it belongs to the BYOK work, PRD 8.2; this layer backs it up), IPv6 for tenants (disabled), per-plan policy, egress logging, and the abuse policy (PRD 21 item 11, undecided). A tenant can still scan or attack public hosts within the rate cap.
3. **Runtime isolation not fully validated (PRD 7.2).** `runc` is the default. gVisor (`runsc`) is selectable and was reported compatible, but it is not the default and has had no escape or kernel-exposure testing; no microVM evaluation; seccomp/AppArmor not verified on target hosts (the dev sandbox uses cgroup v1).
4. **Real Hermes image only partly validated.** The pinned official image boots under the hardened baseline and answers authenticated requests in the live harness (see [milestone-2-runtime-security.md](milestone-2-runtime-security.md)). Not validated: production hosts and kernels, behaviour under a real model backend, the telegram transport, and what the image does with no `API_SERVER_KEY`.
5. **Customer API is new and unproven against real infrastructure.** Tokens in tests are signed with local keys; no real Supabase project, no Supabase Postgres and no public deployment have been exercised. Both API surfaces share one loopback port, so a public reverse proxy must forward only the customer paths and never `/api/v1/tenants/*`; as a second line only, the operator API answers 404 to any request that carries a proxy header (`x-forwarded-*`, `forwarded`, `x-real-ip`, `cf-*`). The beta provisioning gate trusts the `email` claim, which is only safe while Supabase requires email confirmation (and secure email change) and every enabled OAuth provider returns verified emails; nothing in the backend enforces that. The operator API is still a single shared bearer token. The app's rate limit counts authenticated users only. There is no audit log, no account deletion, and a signed-out user's access token works until it expires. `accessUrl` is still a loopback URL, not something a customer can open.
6. **Provisioning is synchronous and in-process;** no job queue, dead-letter queue or outbox. A control-plane crash mid-operation is cleaned up by the lease-based reaper after the lease expires (≤ TTL, 60 s by default): it fails or finishes the operation but does not resume it. Several control-plane replicas are unsupported: the lease protects individual operations, but there is no leader election for the reconciler loop, and clock skew between replicas/DB is not handled. A Docker call that hangs without erroring holds its lease until `maxOperationMs`.
7. **Single node, no scheduler or capacity reservation;** the host port is a random loopback port, with no ingress or TLS.
8. **No secrets management** (envelope encryption, rotation). Per-instance API keys are derived from one master secret in the environment and are never stored, but there is no rotation and no vault; log redaction is by key path only, so free-text secrets in messages would not be caught.
9. **No backups/restore, customer shell/file broker, metrics, or suspend/grace/retention lifecycle.**
10. `STOPPED`/`STOPPING` are not in PRD 10.2 (ADR 0001); `Plan` has no pricing by design.
11. The PID/OOM behaviour was verified on the dev sandbox kernel (cgroup v1); re-verify on the production host kernel/cgroup v2.
