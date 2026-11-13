# Backend Milestone B (Redis + BullMQ jobs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (default) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instance operations (provision, start, stop, restart, delete) and the reconciler run as BullMQ jobs, so HTTP requests answer `202` with a `jobId` immediately, failed work retries with bounded backoff, exhausted jobs are visible and retryable by the operator, and several API replicas are safe.

**Architecture:** The database stays the source of truth for instance state; the queue only delivers work. `InstanceService` keeps its synchronous, lease-fenced, compare-and-set methods unchanged and becomes what the worker calls. A thin `InstanceCommands` layer sits in front of the HTTP routes: with a queue it validates and enqueues, without one (`REDIS_URL` unset, development and most existing tests) it runs the same service call inline, as today.

**Tech Stack:** BullMQ and ioredis (current stable at install time; Task 1 records the exact versions), Redis 7 with AOF, existing Fastify 5, Prisma 6, Vitest 3.

**Spec:** `docs/superpowers/specs/2026-11-12-backend-design.md` section 6 ("B (jobs)"), PRD 11, 13.2, 15.8.

## Global Constraints

- Payload of every job is ids only, never keys, emails, tokens or names (spec 6, PRD 7.4).
- Redis runs with AOF persistence and `maxmemory-policy noeviction` (BullMQ requirement, spec 6).
- Existing HTTP behavior is a contract: no existing integration test may change meaning. The only response change is an added `jobId` (string or `null` when run inline).
- Operator API stays loopback-only; its new job routes need the admin bearer like the rest.
- Repository is public: `.env.example` and `compose.yaml` hold placeholders and dev-only values only.
- Node >= 22, ESM, pnpm; `pnpm build` (tsc) must stay clean; no `any` escapes.

## Decisions that differ from the spec text (confirm at review)

1. **No outbox table in B.** The spec mentions an outbox for critical events. B has no consumer of such events yet (emails arrive in D), so an outbox would be dead code. Instead the database row is the durable intent: `PENDING` instances are re-enqueued by a sweeper (Task 5). The outbox is added in D when the first event consumer exists.
2. **Dead-letter = BullMQ's failed set**, retained 7 days, with operator list/retry routes, instead of a second queue. Same observable behavior (inspect, retry), one less moving part.
3. **Non-provision operations answer `503 queue_unavailable` when Redis is down** and change nothing. Provision answers `202` anyway because the `PENDING` row already exists and the sweeper delivers it.
4. **`REDIS_URL` is required when `NODE_ENV=production`**, optional otherwise (inline mode).

## Review Focus

1. Redis unreachable at request time: provision still returns `202` with a `PENDING` instance that the sweeper later runs; stop/start/restart/delete return `503 queue_unavailable` and leave the instance state untouched.
2. Double click: two restart requests for one instance produce one job; a job delivered twice (stalled or redelivered) is a no-op the second time because the service re-reads state.
3. Worker dies mid-operation: the lease reaper fails or finishes the operation as today; the redelivered job meets a transitional state, is classified permanent, and does not retry in a loop.
4. A permanently failing job (unknown op, instance gone, state conflict) is not retried; a transient one (`RuntimeUnavailableError`, database down) retries at most 4 times, then lands in the failed set.
5. Job payloads and failed-job listings never contain secrets; the failed-job route returns ids, op, attempts and a sanitized reason only.

---

## File structure

- Create `src/modules/jobs/types.ts`: `InstanceOp`, `InstanceOpPayload`, `JobQueue` interface.
- Create `src/modules/jobs/bullmq-queue.ts`: BullMQ-backed `JobQueue`, job id and retry policy.
- Create `src/modules/jobs/worker.ts`: `createInstanceWorker`, error classification.
- Create `src/modules/jobs/scheduler.ts`: repeatable reconcile and sweep jobs with a Redis lock.
- Create `src/modules/instances/instance-commands.ts`: accept-and-enqueue layer used by HTTP.
- Modify `src/modules/instances/instance-service.ts`: add `runProvisionById`, split `provision` into create and run.
- Modify `src/http/customer-routes.ts`, `src/http/operator-routes.ts`, `src/http/server.ts`, `src/main.ts`, `src/config/env.ts`.
- Create `test/helpers/redis.ts`; tests listed per task.
- Modify `compose.yaml`, `.env.example`, `docs/setup.md`, `docs/architecture.md`, `docs/CURRENT_STATE.md`, `AGENTS.md`.

---

### Task 1: Redis dependency, config, dev environment

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`, `src/config/env.ts`, `compose.yaml`, `.env.example`
- Create: `test/helpers/redis.ts`
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Produces: `Config.redisUrl: string | null`; `redisTestUrl(): string` and `uniquePrefix(): string` in `test/helpers/redis.ts` (the prefix isolates each test file's keys, so no `FLUSHALL`).

- [ ] **Step 1: Verify BullMQ facts before relying on them.** Install `bullmq` and `ioredis`, then read the installed package's type definitions and README to confirm and write down in the ledger: (a) whether a custom job id may contain `:`, (b) the job-scheduler API name for repeatable jobs, (c) `UnrecoverableError` export, (d) how `removeOnComplete` interacts with re-adding a job with the same id, (e) custom `backoffStrategy` signature. Adjust Tasks 2 to 6 to what the types say; the job id format in Task 2 already avoids `:`.
- [ ] **Step 2: Write failing config tests:** `REDIS_URL` unset gives `redisUrl === null`; `redis://:pw@127.0.0.1:6379` is accepted and returned; `http://x` is rejected naming `REDIS_URL` without echoing the value; `NODE_ENV=production` without `REDIS_URL` throws naming `REDIS_URL`.
- [ ] **Step 3: Implement** `REDIS_URL` (optional, `redis:` or `rediss:` scheme, empty string means unset) in `src/config/env.ts` and `redisUrl` on `Config`; update every `Config` literal (`scripts/demo.ts`, `test/helpers/auth.ts`, `test/integration/api.test.ts`).
- [ ] **Step 4: Add a `redis:7` service to `compose.yaml`** bound to `127.0.0.1:6380`, started with `--appendonly yes --maxmemory-policy noeviction --requirepass hermes_dev_only`; add `REDIS_URL` placeholder to `.env.example`.
- [ ] **Step 5: Write `test/helpers/redis.ts`:** `redisTestUrl()` reads `REDIS_URL` from the environment and throws a clear message if unset; `uniquePrefix()` returns `test-<random>`.
- [ ] **Step 6: Run** `pnpm build && pnpm vitest run test/unit/config.test.ts`; expected clean and all passing.
- [ ] **Step 7: Commit** `feat(jobs): add Redis configuration`.

### Task 2: Queue module (enqueue, ids, retry policy)

**Files:**
- Create: `src/modules/jobs/types.ts`, `src/modules/jobs/bullmq-queue.ts`
- Test: `test/integration/job-queue.test.ts`

**Interfaces:**
- Produces:
  - `type InstanceOp = 'provision' | 'start' | 'stop' | 'restart' | 'delete'`
  - `interface InstanceOpPayload { op: InstanceOp; tenantId: string; instanceId: string }`
  - `interface JobQueue { enqueue(p: InstanceOpPayload, o?: { dedupeKey?: string }): Promise<{ jobId: string }>; listFailed(): Promise<FailedJob[]>; retryFailed(jobId: string): Promise<void>; close(): Promise<void> }`
  - `interface FailedJob { jobId: string; op: InstanceOp; instanceId: string; attempts: number; reason: string; failedAt: Date }`
  - `createBullQueue(o: { redisUrl: string; prefix?: string; queueName?: string }): JobQueue`
  - `jobIdFor(p: InstanceOpPayload, dedupeKey?: string): string` returns `<instanceId>_<op>` or `<instanceId>_<op>_<dedupeKey>` (no `:`).

- [ ] **Step 1: Write failing tests** (real Redis, unique prefix per file): enqueueing the same restart twice returns the same `jobId` and leaves one waiting job; provision with two different `dedupeKey`s gives two jobs; the stored job data equals exactly `{ op, tenantId, instanceId }`; a job that has failed permanently can be enqueued again (the failed one is removed first); `listFailed` returns a failed job with a sanitized `reason` (class name of the error, no message text).
- [ ] **Step 2: Implement** `createBullQueue`. Job options: `attempts: 4`, custom backoff using `backoffMs(attempt)` from `src/modules/instances/reconciler.ts` (reuse, do not copy), `removeOnComplete: true`, `removeOnFail: { age: 7 * 24 * 3600 }`. `enqueue` removes an existing job with the same id when that job is in the failed state, then adds.
- [ ] **Step 3: Run** `pnpm vitest run test/integration/job-queue.test.ts` with `REDIS_URL` set to the dev Redis; expected pass.
- [ ] **Step 4: Commit** `feat(jobs): BullMQ queue with deduplicated ids and bounded retry`.

### Task 3: Worker and error classification

**Files:**
- Create: `src/modules/jobs/worker.ts`
- Modify: `src/modules/instances/instance-service.ts` (add `runProvisionById`, keep `provision` behavior identical)
- Test: `test/integration/job-worker.test.ts`

**Interfaces:**
- Consumes: `InstanceOpPayload`, `createBullQueue`, `InstanceService`.
- Produces:
  - `InstanceService.runProvisionById(tenantId: string, instanceId: string): Promise<InstanceView>`: loads the row and its plan, no-op returning the view when status is not `PENDING` or `FAILED`.
  - `createInstanceWorker(o: { redisUrl: string; prefix?: string; queueName?: string; service: InstanceService; logger: Logger; concurrency?: number }): { close(): Promise<void> }`
  - `classify(e: unknown): 'permanent' | 'retry'`: `ConflictError`, `NotFoundError`, `ValidationError` and unknown op are permanent; everything else retries.

- [ ] **Step 1: Write failing tests** with `FakeRuntime`: a `provision` job takes a `PENDING` instance to `ACTIVE`; `stop` then `start` jobs work; delivering the same `stop` job twice leaves `STOPPED` with one `instance.stopped` event; a `restart` for an instance in `PROVISIONING` is permanent (one attempt, lands in failed set, no retry); a runtime that throws `RuntimeUnavailableError` twice then succeeds completes on the third attempt; an unknown op fails permanently; a `delete` job for an already `DELETED` instance completes without error.
- [ ] **Step 2: Implement** `runProvisionById` and the worker. The worker calls `service.start|stop|restart|delete(tenantId, instanceId)` or `runProvisionById`, wraps permanent errors in BullMQ's `UnrecoverableError`, logs only `errName` and ids (never messages).
- [ ] **Step 3: Run** `pnpm vitest run test/integration/job-worker.test.ts test/integration/instance-service.test.ts`; expected pass (the second file proves the service did not change).
- [ ] **Step 4: Commit** `feat(jobs): worker runs instance operations with retry classification`.

### Task 4: Commands layer and HTTP contract

**Files:**
- Create: `src/modules/instances/instance-commands.ts`
- Modify: `src/http/customer-routes.ts`, `src/http/operator-routes.ts`, `src/http/server.ts`, `src/shared/errors.ts`
- Test: `test/integration/instance-commands.test.ts`, extend `test/integration/customer-api.test.ts`

**Interfaces:**
- Consumes: `InstanceService`, `JobQueue`.
- Produces:
  - `class InstanceCommands` with `constructor(o: { service: InstanceService; queue: JobQueue | null; logger: Logger })` and, for each of `provision(input)`, `start|stop|restart|delete(tenantId, instanceId)`: `Promise<{ instance: InstanceView; jobId: string | null }>`.
  - `class QueueUnavailableError extends AppError` (503, code `queue_unavailable`, message `Job queue is temporarily unavailable`).
  - `buildServer` dep `commands: InstanceCommands` replaces direct service calls in the routes for these five operations; reads (`get`, `list`, `events`) still use `service`.

- [ ] **Step 1: Write failing tests.** Inline mode (`queue: null`): behavior and responses equal today's plus `jobId: null`. Queue mode: `provision` creates the `PENDING` row, enqueues, returns `PENDING` view and a `jobId`; `stop` returns the unchanged `ACTIVE` view and a `jobId`; with a queue whose `enqueue` rejects, `stop` throws `QueueUnavailableError` and the status is unchanged, while `provision` still returns the `PENDING` view (decision 3); `restart` on an instance in `STOPPING` is rejected with 409 before enqueueing (validate the state first, using the same rules as the service). HTTP: customer and operator `POST` routes include `jobId` in the 202 body; the existing cross-tenant tests still pass unchanged.
- [ ] **Step 2: Implement** `InstanceCommands`. Split `InstanceService.provision` into `createProvisioning(...)` (validation, cap, idempotent insert, returns the row) and the existing run step so queue mode can stop after creation; `provision` itself keeps its signature and behavior. Pre-validate state transitions with a small exported `assertCanRun(op, status)` extracted from the service's existing checks (do not duplicate the rules: the service methods call it too).
- [ ] **Step 3: Map `QueueUnavailableError`** through the existing `AppError` handler; no handler change expected.
- [ ] **Step 4: Run** the full integration suite for `customer-api`, `api`, `instance-service`, `instance-commands`; expected all green.
- [ ] **Step 5: Commit** `feat(jobs): accept operations as jobs and return jobId`.

### Task 5: Provision sweeper

**Files:**
- Modify: `src/modules/instances/instance-commands.ts` (export `sweepPending`) or create `src/modules/jobs/sweeper.ts`
- Test: `test/integration/job-sweeper.test.ts`

**Interfaces:**
- Produces: `sweepPending(o: { prisma: PrismaClient; queue: JobQueue; olderThanMs: number; now?: () => Date; limit?: number }): Promise<number>` returns how many jobs it enqueued.

- [ ] **Step 1: Write failing tests:** a `PENDING` instance older than the threshold is enqueued once (a second sweep returns 0 new jobs because the job id is deterministic); a `PENDING` instance younger than the threshold is skipped; instances in other states are skipped; with `limit: 2` and five stale rows only two are enqueued.
- [ ] **Step 2: Implement** with `dedupeKey` omitted so the id is `<instanceId>_provision`. Threshold default 30 seconds.
- [ ] **Step 3: Run** the new test file; expected pass.
- [ ] **Step 4: Commit** `feat(jobs): re-enqueue stranded PENDING instances`.

### Task 6: Reconciler and sweeper as scheduled, leader-safe jobs

**Files:**
- Create: `src/modules/jobs/scheduler.ts`
- Test: `test/integration/job-scheduler.test.ts`

**Interfaces:**
- Produces:
  - `withRedisLock(redisUrl: string, key: string, ttlMs: number, fn: () => Promise<void>, o?: { prefix?: string }): Promise<'ran' | 'skipped'>`: `SET NX PX` with a random token, released with a compare-and-delete script; never throws when held.
  - `startScheduler(o: { redisUrl: string; prefix?: string; reconciler: Reconciler; sweep: () => Promise<number>; intervalMs: number; logger: Logger }): Promise<() => Promise<void>>` registers the repeatable job (using the API confirmed in Task 1) and a worker that runs `reconcileAll` then `sweep` under `withRedisLock`.

- [ ] **Step 1: Write failing tests:** two concurrent `withRedisLock` calls on one key run `fn` once and return `ran` and `skipped`; the lock is released after `fn` throws; a lock whose holder never releases expires after `ttlMs`; two schedulers started against the same Redis with a counting `reconciler` fake produce exactly one `reconcileAll` per tick (assert over three ticks with a short interval).
- [ ] **Step 2: Implement.** The lock TTL is `max(3 * intervalMs, 60_000)`.
- [ ] **Step 3: Run** the new test file; expected pass.
- [ ] **Step 4: Commit** `feat(jobs): leader-safe scheduled reconcile and sweep`.

### Task 7: Operator job routes and process wiring

**Files:**
- Modify: `src/http/operator-routes.ts`, `src/http/server.ts`, `src/main.ts`
- Test: `test/integration/operator-jobs.test.ts`

**Interfaces:**
- Produces operator routes (admin bearer, loopback): `GET /api/v1/jobs/failed` returns `{ jobs: FailedJob[] }`; `POST /api/v1/jobs/failed/:jobId/retry` returns `202 { jobId }`, `404` when the id is not in the failed set. Both answer `503 queue_unavailable` in inline mode.

- [ ] **Step 1: Write failing tests:** a permanently failed job appears in the list with `attempts` and no message text; retry requeues it and, with the runtime fixed, the instance reaches its target state; unknown id gives 404; without the admin token both routes give 401; in inline mode both give 503.
- [ ] **Step 2: Implement the routes**, then wire `src/main.ts`: when `config.redisUrl` is set, create the queue, `InstanceCommands`, the instance worker and the scheduler (replacing `reconciler.start(15_000)`), and close all three in `shutdown()` before `app.close()`; when unset, keep today's `setInterval` reconciler and inline commands. Log which mode started.
- [ ] **Step 3: Run** `pnpm build && pnpm test` against dev Postgres, Docker and Redis; expected all green.
- [ ] **Step 4: Commit** `feat(jobs): operator failed-job routes and process wiring`.

### Task 8: Documentation and final verification

**Files:**
- Modify: `docs/setup.md` (Redis, `REDIS_URL`, AOF and `noeviction`, inline mode), `docs/architecture.md` (job flow, failure semantics, the four decisions above, known gaps), `docs/CURRENT_STATE.md`, `AGENTS.md` (commands: tests need Redis; architecture bullet), `docs/README.md`.

- [ ] **Step 1: Update docs** with real test counts from this run and what is unverified (no Redis outside the sandbox, no VPS run, no multi-replica test beyond the lock test).
- [ ] **Step 2: Run** `pnpm build && pnpm test` and record the output counts.
- [ ] **Step 3: Fresh read-only review** of the whole diff against this plan's Review Focus; fix Critical and Important findings test-first; record the rest in the ledger.
- [ ] **Step 4: Report to the owner and ask before commit/push/PR** (project rule).

---

## Self-review

- **Spec coverage:** jobs for all five operations (Tasks 2 to 4), 202 plus job id (4), bounded retry with backoff and jitter (2), dead-letter and operator retry (2, 7), idempotent jobs (2, 3), outbox (replaced, decision 1), reconciler as repeatable job with a single-leader guarantee (6), Redis AOF and `noeviction` (1, 8), existing tests stay green (3, 4).
- **Types:** `InstanceOpPayload`, `JobQueue`, `FailedJob`, `InstanceCommands` and `jobIdFor` are defined once (Tasks 2 and 4) and used by the later tasks under the same names.
- **Proportion:** the plan states signatures, test assertions and decisions; bodies are left to the implementer.
- **Open, depends on Task 1 step 1:** job id separator, scheduler API name and `removeOnComplete` semantics are verified against the installed BullMQ before use, not assumed.
