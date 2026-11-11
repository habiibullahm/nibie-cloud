# Milestone 1 review fixes

Round 2 of review on `feat/runtime-foundation`. No change to the architecture or API boundaries;
no frontend, billing, auth or new dependencies.

## 1. Idempotency key bound to its request

- **Problem.** Reusing an `Idempotency-Key` with a different `name` or `planId` silently returned the
  original instance, dropping the client's real request.
- **Fix.** On a key collision the stored `name` and `planId` are compared with the new request;
  a mismatch answers `409 Conflict` (`ConflictError`), including for a `FAILED` instance (it is *not*
  re-driven by a mismatched retry). Concurrent calls with the same key and different payloads: the
  first insert wins, every mismatched call gets 409, exactly one instance/container/volume exists.
- **Tests.** `instance-service.test.ts` › *idempotency key is bound to its request payload* (different
  name; different plan; FAILED + mismatched retry does not re-drive; 6 concurrent calls with two
  payloads) and `api.test.ts` › *409 when an idempotency key is reused with a different payload*.

## 2. Database errors are no longer swallowed

- **Problem.** `.catch(() => null)` on the tenant/plan lookups turned any database failure into
  "Tenant not found" (404), and a malformed tenant id on `list` produced a 500.
- **Fix.** Malformed ids are rejected up front as `404` via a UUID check (same for `list`); the
  lookups themselves no longer catch. Prisma connectivity errors (`PrismaClientInitializationError`,
  `P1001/P1002/P1008/P1017/P2024`) map to `503 database_unavailable` with a sanitized body and no
  connection details in the response or logs.
- **Tests.** Unknown / malformed tenant and plan → `NotFoundError`; a service pointed at an unreachable
  Postgres rejects with `PrismaClientInitializationError`, not `NotFoundError` (service and API level,
  including that the password in the URL never appears in the body or logs).

## 3. Operation leases and heartbeats for the stale reaper

- **Problem.** The reaper treated any transitional row not updated for 5 minutes as abandoned, so a
  legitimately long operation (slow image pull, slow health wait) could be failed under its own feet.
- **Fix.** Every operation takes a lease (`operationOwner`, `leaseExpiresAt`; migration
  `add_operation_lease`) and renews it with a heartbeat. The reaper only acts on rows whose lease has
  *expired*, fences its writes on that, takes over the lease before finishing a `STOPPING`/`DELETING`
  operation, and an operation's own writes are fenced on `operationOwner`, so a zombie cannot
  overwrite the reaper's outcome. Heartbeats stop after `maxOperationMs` so hung operations are
  eventually reaped. See [architecture.md](architecture.md#instance-lifecycle).
- **Tests.** `lease.test.ts`: a provisioning whose health wait is ~6× the lease TTL, a slow stop, a slow
  delete and an in-flight reconciler recovery are never reaped while the reaper polls concurrently, and
  their leases are cleared on completion; expired lease → reaped (even if the row was updated
  recently); valid lease on an old-looking row → left alone; heartbeat beating vs. stopped (simulated
  crash); abandoned `DELETING` is finished; fenced takeover loses to a late renewal; hung operation
  (past `maxOperationMs`) is reaped and the zombie cannot overwrite the result. Mutation check:
  disabling the heartbeat fails 4 of the 9 tests.

## Remaining production blockers

Unchanged by these fixes (details in [architecture.md](architecture.md#known-gaps-and-deferred-security-work)):

1. Disk quota is not enforced (`Plan.storageMb` is stored only).
2. No network egress controls / SSRF defences; tenants can reach the internet, host gateway and metadata addresses.
3. Runtime isolation not validated (no gVisor/microVM evaluation, no escape testing; hardened `runc` only).
4. The real Hermes image has not been validated; all runtime tests use the stub image.
5. Operator API only: shared bearer token, no customer auth/tenant membership, rate limiting or audit log.
6. Synchronous in-process provisioning: no job queue, DLQ or outbox; single control-plane process only (no leader election, no clock-skew handling).
7. Single node: no scheduler, capacity reservation, ingress or TLS.
8. No secrets management, backups/restore, customer shell/file broker, metrics/alerts or billing/suspension lifecycle.
9. Deferred minors: retried stop/delete during the operation answers 409 (not a no-op); manual restart of an exhausted instance that fails health can re-emit `recovery.exhausted`; dependency ranges in `package.json` are caret ranges (the lockfile pins them).
