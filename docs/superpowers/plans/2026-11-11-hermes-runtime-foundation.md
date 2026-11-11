# Hermes Runtime Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (default) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision, access, restart and recover a dedicated, hardened Hermes container with persistent storage purely through backend operations (service + REST), no manual `docker run`.

**Architecture:** One TypeScript/Node modular monolith. `runtime` module is the only code that talks to Docker (via `dockerode`); `instances` module owns the lifecycle state machine and persistence (Prisma/PostgreSQL) and calls `runtime` through a `RuntimeManager` interface; `http` is a thin Fastify layer. Recovery is a reconciler that compares DB state with Docker state. No queue, no Redis, no Kubernetes in this milestone: lifecycle calls run in-process and are made safe by compare-and-set status transitions and deterministic Docker resource names, so BullMQ can wrap them later without redesign.

**Tech Stack:** Node 22, TypeScript (strict, ESM), pnpm, Fastify, Prisma + PostgreSQL 16, dockerode, zod, pino, vitest.

**Spec:** `docs/prd.md` (sections 6.3, 7.1, 10.2, 11, 13.2, 14, 15.3) and Nash's milestone brief ("Working Hermes Runtime").

## Global Constraints

- Never mount the Docker socket into customer containers; never privileged; never host networking; no broad host mounts (PRD 7.1).
- Containers run non-root (uid/gid `10001`), `CapDrop: ["ALL"]`, `no-new-privileges`, default seccomp/AppArmor (never `unconfined`), CPU/memory/PID limits enforced, no swap (PRD 7.1).
- Hermes image must be pinned: tag other than `latest` (dev/test) or `@sha256:` digest (required when `NODE_ENV=production`); `latest` and untagged are rejected (PRD 7.1).
- Externally visible ids are UUIDs; timestamps UTC; no secrets in logs, errors or source control (PRD 7.4, 14.1).
- Docker resource names derive only from instance UUIDs, never from customer-supplied text.
- The `runtime` module is the only component that creates/inspects/stops/removes containers (PRD 6.3).
- Modular monolith; no Kubernetes; no dashboard/frontend; REST under `/api/v1`.
- Out of scope this milestone: auth/users, billing, scheduler across nodes (single `local` node row only), BullMQ/Redis, backups, Telegram/providers, ingress/custom domains, disk quota enforcement, gVisor/microVM evaluation.

## Review Focus

1. Client retries `provision` with the same idempotency key (also concurrently) → exactly one instance, one container, one volume; same instance returned.
2. Docker fails midway through provisioning (volume created, container creation fails) → instance `FAILED` with sanitized reason; retry reuses the volume and succeeds with no duplicates or leaks.
3. Container crash-loops or is OOM-killed → bounded recovery attempts with backoff, then `DEGRADED` + `recovery.exhausted` event; never an infinite restart loop.
4. Docker daemon unreachable → API answers 503; no instance is marked `FAILED`/`DELETED` and nothing is removed because of it.
5. Two lifecycle calls race on one instance (restart + stop, double delete) → one wins, the other gets 409; repeated stop/delete on an already stopped/deleted instance is a no-op success.

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, .env.example, compose.yaml
prisma/schema.prisma, prisma/migrations/…
src/config/env.ts                       env parsing (zod); exports loadConfig()
src/shared/logger.ts                    pino with secret redaction
src/shared/errors.ts                    AppError hierarchy → HTTP status
src/db/client.ts                        PrismaClient factory
src/modules/runtime/types.ts            RuntimeSpec, RuntimeInspection, RuntimeManager
src/modules/runtime/image-policy.ts     assertPinnedImage()
src/modules/runtime/hardening.ts        buildContainerConfig() (pure)
src/modules/runtime/docker-runtime-manager.ts   DockerRuntimeManager
src/modules/instances/state-machine.ts  allowed transitions
src/modules/instances/instance-service.ts       lifecycle
src/modules/instances/reconciler.ts     recovery
src/http/server.ts                      Fastify app + routes
scripts/demo.ts                         end-to-end proof run
test/fixtures/hermes-stub/{Dockerfile,server.js}  test-only Hermes stand-in
test/unit/*.test.ts, test/integration/*.test.ts
docs/architecture.md, docs/setup.md
```

---

### Task 1: Project scaffold, config, logger

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `compose.yaml`, `src/config/env.ts`, `src/shared/logger.ts`, `src/shared/errors.ts`
- Test: `test/unit/config.test.ts`, `test/unit/logger.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): Config` where `Config = { nodeEnv: 'development'|'test'|'production'; databaseUrl: string; hermesImage: string; port: number; adminToken: string; dockerSocketPath: string }`; `createLogger(opts?): pino.Logger`; `class AppError extends Error { status: number; code: string }` with subclasses `NotFoundError(404)`, `ConflictError(409)`, `ValidationError(400)`, `RuntimeUnavailableError(503)`.

- [ ] **Step 1: Write failing tests.** `config.test.ts`: `loadConfig` throws when `DATABASE_URL`, `HERMES_IMAGE` or `ADMIN_TOKEN` missing; throws when `ADMIN_TOKEN` shorter than 24 chars; returns parsed `port` default `3000`. `logger.test.ts`: logging `{ adminToken: 'sekret', env: { TELEGRAM_BOT_TOKEN: 'x' } }` writes output that does not contain `sekret` or the token value (redact paths `adminToken`, `*.token`, `*.apiKey`, `*.password`, `env.*`, `req.headers.authorization`).
- [ ] **Step 2:** `pnpm install`, then `pnpm vitest run test/unit` → FAIL (modules missing).
- [ ] **Step 3:** Scaffold the project (ESM, `"type":"module"`, strict TS, scripts `build`, `test`, `test:unit`, `test:integration`, `db:migrate`, `db:dev`, `demo`); implement `loadConfig` with zod, `createLogger` with the redact paths above, and the error classes. `compose.yaml` runs `postgres:16` on `127.0.0.1:5433` only. `.env.example` contains placeholders only; `.env` is git-ignored.
- [ ] **Step 4:** `pnpm test:unit` → PASS; `pnpm build` → no type errors.
- [ ] **Step 5:** Commit `chore: scaffold TypeScript backend with config and redacting logger`.

### Task 2: Prisma data model and migration

**Files:**
- Create: `prisma/schema.prisma`, `src/db/client.ts`, `test/helpers/db.ts`
- Test: `test/integration/schema.test.ts`

**Interfaces:**
- Produces: `createPrisma(databaseUrl: string): PrismaClient`; `resetDb(prisma): Promise<void>` (test helper, truncates all tables). Models (all ids `String @id @default(uuid()) @db.Uuid`, timestamps `@db.Timestamptz`):
  - `Tenant { id, name, createdAt }`
  - `Plan { id, slug @unique, cpuMillis Int, memoryMb Int, pids Int, storageMb Int }` (no price: pricing is unapproved, PRD 5.2)
  - `RuntimeNode { id, name @unique, region, schedulable Boolean @default(true) }`
  - `Instance { id, tenantId, planId, nodeId, name, idempotencyKey, status InstanceStatus, statusReason String?, image String, hostPort Int?, consecutiveFailures Int @default(0), recoveryAttempts Int @default(0), nextRecoveryAt DateTime?, lastHealthAt DateTime?, createdAt, updatedAt, deletedAt DateTime? }` with `@@unique([tenantId, idempotencyKey])` and `@@index([status])`
  - `InstanceEvent { id, instanceId, type String, message String, createdAt }` (append-only; message must be pre-sanitized)
  - `enum InstanceStatus { PENDING PROVISIONING CONFIGURING STARTING ACTIVE DEGRADED STOPPED FAILED DELETING DELETED }` (`STOPPED` is internal, added for customer stop/start; PRD 10.2 doesn't list it; flagged in ADR).

- [ ] **Step 1: Write failing test** (`schema.test.ts`): inserting two instances with the same `(tenantId, idempotencyKey)` rejects with Prisma `P2002`; inserting an instance with an unknown `tenantId` rejects (FK); `InstanceEvent` rows cascade-delete never (deleting an instance row is not supported: `onDelete: Restrict`).
- [ ] **Step 2:** `docker compose up -d postgres`, `pnpm test:integration -- schema` → FAIL.
- [ ] **Step 3:** Write `schema.prisma`, run `pnpm prisma migrate dev --name init` to generate and commit the migration; implement `createPrisma` and `resetDb`.
- [ ] **Step 4:** Test → PASS; `pnpm prisma migrate deploy` on a fresh DB succeeds.
- [ ] **Step 5:** Commit `feat(db): tenant, plan, node, instance, event schema and initial migration`.

### Task 3: Image policy and container hardening (pure logic)

**Files:**
- Create: `src/modules/runtime/types.ts`, `src/modules/runtime/image-policy.ts`, `src/modules/runtime/hardening.ts`
- Test: `test/unit/image-policy.test.ts`, `test/unit/hardening.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export interface ResourceLimits { cpuMillis: number; memoryMb: number; pids: number }
  export interface RuntimeSpec { instanceId: string; tenantId: string; image: string; limits: ResourceLimits; env: Record<string,string> }
  export type RuntimeState = 'absent'|'created'|'running'|'exited'|'restarting'|'dead'
  export interface RuntimeInspection { state: RuntimeState; exitCode: number|null; oomKilled: boolean; startedAt: Date|null; hostPort: number|null; volumePresent: boolean }
  export interface HealthResult { ok: boolean; latencyMs: number; detail: string }
  export interface RuntimeManager {
    ensure(spec: RuntimeSpec): Promise<{ hostPort: number|null }>   // idempotent: network+volume+container (created, not started)
    start(instanceId: string): Promise<void>
    stop(instanceId: string, timeoutSec?: number): Promise<void>     // no-op if already stopped/absent
    restart(instanceId: string): Promise<void>
    inspect(instanceId: string): Promise<RuntimeInspection>          // state 'absent' if no container
    checkHealth(instanceId: string): Promise<HealthResult>
    remove(instanceId: string, opts: { deleteVolume: boolean }): Promise<void>  // no-op if absent
  }
  ```
  `assertPinnedImage(image: string, opts: { production: boolean }): void` (throws `ValidationError`); `buildContainerConfig(spec: RuntimeSpec): Docker.ContainerCreateOptions`; naming helpers `containerName(id)`, `volumeName(id)`, `networkName(id)` → `hermes-<id>`, `hermes-data-<id>`, `hermes-net-<id>`.
- Constants the config must produce: `User: "10001:10001"`, `HostConfig.ReadonlyRootfs: true`, `Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" }`, `Binds` only `["hermes-data-<id>:/data"]`, `CapDrop: ["ALL"]`, `CapAdd` absent, `Privileged: false`, `SecurityOpt: ["no-new-privileges:true"]`, `Memory = memoryMb*1048576`, `MemorySwap = Memory`, `NanoCpus = cpuMillis*1_000_000`, `PidsLimit = pids`, `Init: true`, `RestartPolicy: { Name: "no" }` (recovery is ours, so failures stay visible), `PortBindings` `8080/tcp → 127.0.0.1:0`, `NetworkMode: hermes-net-<id>`, labels `hermes.cloud/managed=true`, `hermes.cloud/instance-id`, `hermes.cloud/tenant-id`.

- [ ] **Step 1: Write failing tests.** `image-policy`: rejects `hermes`, `hermes:latest`, `registry/x/hermes:LATEST`; accepts `hermes:1.4.2`; in production rejects `hermes:1.4.2` and accepts `hermes@sha256:<64 hex>`. `hardening`: for a spec with `{cpuMillis:500, memoryMb:256, pids:128}` assert every constant above; assert no bind contains `docker.sock` or starts with `/`; assert `SecurityOpt` has no `unconfined`; assert `NetworkMode` is not `host`; assert a spec whose `env` has `DOCKER_HOST` or key `DOCKER_*` throws; assert names are built only from the UUID (a non-UUID `instanceId` like `../x; rm` throws).
- [ ] **Step 2:** `pnpm test:unit` → FAIL.
- [ ] **Step 3:** Implement the three files per Interfaces.
- [ ] **Step 4:** `pnpm test:unit` → PASS.
- [ ] **Step 5:** Commit `feat(runtime): image pin policy and hardened container config builder`.

### Task 4: Hermes stub image (test fixture)

**Files:**
- Create: `test/fixtures/hermes-stub/Dockerfile`, `test/fixtures/hermes-stub/server.js`, `test/helpers/stub-image.ts`

**Interfaces:**
- Produces: `ensureStubImage(): Promise<string>` returns `hermes-stub:0.1.0` (builds it via `docker build` if missing). Image contract that the real Hermes image must also meet (documented in architecture.md): listens on `8080`, `GET /healthz` → 200 `{"status":"ok"}`, writes state under `/data`, runs as uid `10001`, has `/data` pre-created and owned by `10001:10001` (so new named volumes inherit ownership), works with read-only rootfs + writable `/tmp` and `/data`.
- `server.js` also exposes `GET /state` → `{"boots": n}` (increments a counter file `/data/boots` at start; persistence evidence) and `POST /crash` → exits non-zero (failure-recovery tests). Base: `node:22-alpine` pinned by digest recorded in the Dockerfile.

- [ ] **Step 1:** Write the fixture and helper.
- [ ] **Step 2:** Verify manually through the helper: `pnpm tsx -e "import('./test/helpers/stub-image.ts').then(m=>m.ensureStubImage()).then(console.log)"` prints `hermes-stub:0.1.0`; `docker run --rm --read-only --user 10001:10001 -v t:/data hermes-stub:0.1.0` serves `/healthz` and survives a second run with `boots` = 2; remove volume `t` afterwards.
- [ ] **Step 3:** Commit `test: add Hermes stub image fixture`.

### Task 5: DockerRuntimeManager

**Files:**
- Create: `src/modules/runtime/docker-runtime-manager.ts`
- Test: `test/integration/runtime-manager.test.ts`

**Interfaces:**
- Consumes: `RuntimeManager`, `buildContainerConfig`, naming helpers (Task 3).
- Produces: `class DockerRuntimeManager implements RuntimeManager { constructor(opts: { docker?: Docker; logger: Logger; healthTimeoutMs?: number }) }`. Docker connectivity failures (`ECONNREFUSED`, `ENOENT` on socket) are rethrown as `RuntimeUnavailableError`; other errors keep their type but with message passed through a sanitizer that strips env values.

- [ ] **Step 1: Write failing integration tests** (each uses a fresh `randomUUID()` instance id and `afterEach` calls `remove(id,{deleteVolume:true})`):
  - `ensure creates volume, network and an unstarted container`: after `ensure`, `inspect(id).state === 'created'`, `volumePresent === true`.
  - `ensure is idempotent`: calling it twice leaves exactly one container, one volume, one network matching the `hermes.cloud/instance-id` label.
  - `start → inspect running with hostPort; checkHealth ok`: `inspect.state==='running'`, `hostPort` between 1024 and 65535, `checkHealth.ok === true`.
  - `stop then start`; `restart` changes `startedAt`; `stop` twice is a no-op; `remove` on an absent instance is a no-op.
  - `checkHealth reports not ok when stopped` (`ok:false`, detail does not throw).
  - `daemon unreachable`: manager built with `new Docker({ socketPath: '/nonexistent.sock' })` → `inspect` rejects `RuntimeUnavailableError`.
- [ ] **Step 2:** `pnpm test:integration -- runtime-manager` → FAIL (needs `dockerd` running; see setup doc).
- [ ] **Step 3:** Implement. `ensure`: create network `internal:false` bridge with `com.docker.network.bridge.enable_icc=false` if absent, create volume if absent (labels), create container if absent via `buildContainerConfig`; swallow 409 "already exists". `inspect` maps Docker `State` (`Status`, `OOMKilled`, `ExitCode`) and the published port to `RuntimeInspection`. `checkHealth`: `fetch('http://127.0.0.1:<hostPort>/healthz')` with `AbortSignal.timeout(healthTimeoutMs ?? 2000)`. `remove`: stop, remove container, remove network, remove volume only when `deleteVolume`.
- [ ] **Step 4:** Tests → PASS.
- [ ] **Step 5:** Commit `feat(runtime): DockerRuntimeManager with idempotent ensure and health checks`.

### Task 6: Isolation and persistence tests

**Files:**
- Test: `test/integration/isolation.test.ts`, `test/integration/persistence.test.ts` (no new production code expected; fix `hardening.ts` if a test exposes a gap)

**Interfaces:**
- Consumes: `DockerRuntimeManager` and stub image (Tasks 4–5). Helper `execIn(instanceId, cmd: string[]): Promise<{code:number; out:string}>` in `test/helpers/exec.ts` using `docker exec` via dockerode (test-only; customer shell broker is a later milestone).

- [ ] **Step 1: Write the tests.**
  - `isolation.test.ts`, two tenants A and B running: `docker inspect` of A shows `Privileged=false`, `ReadonlyRootfs=true`, `CapDrop=['ALL']`, `SecurityOpt` contains `no-new-privileges:true`, `PidsLimit=128`, `Memory=268435456`, `NanoCpus=500000000`, `NetworkMode='hermes-net-<A>'`, and `Mounts` contains exactly one entry (the named volume at `/data`), none with source or destination `docker.sock`; inside A: `id -u` → `10001`, `ls /var/run/docker.sock` fails, `touch /etc/x` fails (read-only), `touch /data/x` succeeds, `ls /data` does not show B's files; fork-bomb-lite (`sh -c 'for i in $(seq 1 400); do sleep 30 & done'`) is capped by the PID limit (some forks fail, container still inspectable); A cannot reach B by container name or by B's bridge IP (`wget -T2` fails); A's volume name differs from B's.
  - `persistence.test.ts`: provision, `GET /state` boots=1, `remove(id,{deleteVolume:false})`, `ensure` + `start` again → `boots=2` and a marker file written by exec before removal still exists; after `remove(id,{deleteVolume:true})` a fresh `ensure` gives `boots=1` (data really deleted).
- [ ] **Step 2:** `pnpm test:integration -- isolation persistence` → FAIL or PASS; every failure is a real hardening bug.
- [ ] **Step 3:** Fix production code only where tests expose a defect.
- [ ] **Step 4:** All pass.
- [ ] **Step 5:** Commit `test(runtime): isolation and persistence coverage`.

### Task 7: State machine and InstanceService

**Files:**
- Create: `src/modules/instances/state-machine.ts`, `src/modules/instances/instance-service.ts`
- Test: `test/unit/state-machine.test.ts`, `test/integration/instance-service.test.ts`

**Interfaces:**
- Consumes: `RuntimeManager` (Task 3), `PrismaClient` (Task 2), `assertPinnedImage`.
- Produces:
  ```ts
  export function canTransition(from: InstanceStatus, to: InstanceStatus): boolean
  export interface InstanceView { id: string; tenantId: string; name: string; status: InstanceStatus; statusReason: string|null; accessUrl: string|null; createdAt: Date }
  export class InstanceService {
    constructor(deps: { prisma: PrismaClient; runtime: RuntimeManager; image: string; production: boolean; logger: Logger })
    provision(input: { tenantId: string; name: string; planId: string; idempotencyKey: string }): Promise<InstanceView>
    get(tenantId: string, instanceId: string): Promise<InstanceView>
    list(tenantId: string): Promise<InstanceView[]>
    start(tenantId: string, instanceId: string): Promise<InstanceView>
    stop(tenantId: string, instanceId: string): Promise<InstanceView>
    restart(tenantId: string, instanceId: string): Promise<InstanceView>
    delete(tenantId: string, instanceId: string): Promise<InstanceView>
    events(tenantId: string, instanceId: string): Promise<{ type: string; message: string; createdAt: Date }[]>
  }
  ```
- Transitions: `PENDING→PROVISIONING→CONFIGURING→STARTING→ACTIVE`; `ACTIVE⇄DEGRADED`; `ACTIVE|DEGRADED→STOPPED`; `STOPPED→STARTING`; `ACTIVE|DEGRADED→STARTING` (restart); `PROVISIONING|CONFIGURING|STARTING→FAILED`; `FAILED→PROVISIONING` (retry); `ACTIVE|DEGRADED|STOPPED|FAILED→DELETING→DELETED`. Everything else is false. Each transition is a compare-and-set (`updateMany where {id, status: from}`; count 0 → `ConflictError`) and writes an `InstanceEvent`. Every query includes `tenantId`; a mismatched tenant yields `NotFoundError`, never a leak. `accessUrl` is `http://127.0.0.1:<hostPort>` (ingress is a later milestone). Statuses `Pending…Failed` map to customer-facing names later; failure reasons stored are fixed strings (`"runtime_create_failed"`, `"health_check_timeout"`), never raw Docker errors.

- [ ] **Step 1: Write failing tests.**
  - Unit: `canTransition(ACTIVE,STOPPED)` true; `(DELETED,ACTIVE)`, `(STOPPED,ACTIVE)`, `(PENDING,ACTIVE)` false.
  - Integration (real Docker + DB + stub image, plan `{cpuMillis:500,memoryMb:256,pids:128}`): `provision reaches ACTIVE with persisted container` (status ACTIVE, `accessUrl` non-null, events include `provisioning.started`, `instance.active`); **`duplicate idempotencyKey returns same instance`**, also via `Promise.all` of 5 parallel calls → one DB row, one container; **`partial failure then retry`**: a wrapper runtime that throws once from `ensure` after creating the volume → status `FAILED`, `statusReason === 'runtime_create_failed'`, retrying `provision` with the same key succeeds, one volume total; `stop/start/restart` produce `STOPPED/ACTIVE/ACTIVE`; **`concurrent restart + stop`**: exactly one resolves, the other rejects `ConflictError`; `stop` on `STOPPED` and `delete` on `DELETED` resolve without error; **`wrong tenant gets NotFoundError`** for every method; `delete` removes container, network and volume (verified via Docker) and sets `deletedAt`; **`runtime unavailable`**: a runtime stub throwing `RuntimeUnavailableError` from `start` leaves status unchanged and rethrows; `provision` rejects `name` longer than 63 chars or containing control characters (`ValidationError`), and a name like `"; rm -rf /`/`日本語` is stored but never appears in any Docker name or label.
- [ ] **Step 2:** `pnpm test:unit && pnpm test:integration -- instance-service` → FAIL.
- [ ] **Step 3:** Implement. Provisioning order: create row `PENDING`→`PROVISIONING` → `runtime.ensure` (`CONFIGURING`) → `runtime.start` (`STARTING`) → poll `checkHealth` every 500 ms up to 30 s → `ACTIVE`. Idempotency: `create` with unique key, on `P2002` load the existing row and return/continue it; a row in `FAILED` is re-driven from `PROVISIONING`. A non-`RuntimeUnavailableError` failure → `FAILED`; a `RuntimeUnavailableError` leaves state and rethrows.
- [ ] **Step 4:** Tests → PASS.
- [ ] **Step 5:** Commit `feat(instances): lifecycle state machine and InstanceService`.

### Task 8: Reconciler and failure recovery

**Files:**
- Create: `src/modules/instances/reconciler.ts`
- Test: `test/unit/backoff.test.ts`, `test/integration/recovery.test.ts`

**Interfaces:**
- Consumes: `InstanceService` internals via shared repository helpers from Task 7 (`transition(...)`, `recordEvent(...)`), `RuntimeManager`.
- Produces:
  ```ts
  export function backoffMs(attempt: number, rand?: () => number): number   // min(60_000, 2_000 * 2^attempt) * (0.5 + rand()*0.5)
  export class Reconciler {
    constructor(deps: { prisma; runtime: RuntimeManager; logger; now?: () => Date; maxRecoveryAttempts?: number /*default 3*/; unhealthyThreshold?: number /*default 3*/ })
    reconcileInstance(instanceId: string): Promise<'ok'|'recovered'|'waiting'|'degraded'|'exhausted'|'skipped'>
    reconcileAll(): Promise<void>
    start(intervalMs: number): () => void   // returns stop function
  }
  ```
- Behavior: only instances in `ACTIVE|DEGRADED|STARTING` are examined. Runtime `running` + healthy → `ACTIVE`, counters reset. `running` + unhealthy → increment `consecutiveFailures`; `≥ unhealthyThreshold` → restart; below it → `DEGRADED`. Container `exited|dead|created|absent` → recovery: if `now < nextRecoveryAt` → `waiting`; else `ensure` (re-creates a missing container on the existing volume) + `start`, `recoveryAttempts++`, `nextRecoveryAt = now + backoffMs(attempts)`; success + healthy → `recovered`. When `recoveryAttempts ≥ maxRecoveryAttempts` → status `DEGRADED`, event `recovery.exhausted`, no further restarts (`exhausted`). `RuntimeUnavailableError` → `skipped`, no state change. `STOPPED` instances are never restarted.

- [ ] **Step 1: Write failing tests.** Unit: `backoffMs(0, ()=>1) === 2000`, `backoffMs(10, ()=>1) === 60000`, `backoffMs(3, ()=>0) === 8000`. Integration with injectable clock: **kill container (`docker kill`) of an ACTIVE instance → `reconcileInstance` returns `recovered`, status ACTIVE, `boots` incremented, marker file in `/data` intact**; **remove the container only (volume kept) → recovered with data intact**; **crash loop** (stub with `POST /crash` called each time it comes up, clock advanced past backoff each pass): after 3 attempts result `exhausted`, status `DEGRADED`, `recovery.exhausted` event present, a 4th pass starts nothing (assert via `docker inspect` StartedAt unchanged); OOM kill (stub allocates beyond 256 MB when `POST /oom`) shows `oomKilled` in event message and follows the same bounded path; STOPPED instance with exited container → `ok`, not restarted; reconciler with a runtime throwing `RuntimeUnavailableError` → `skipped`, status unchanged; healthy again after exhaustion (manual `start` via service) resets counters.
- [ ] **Step 2:** FAIL (module missing).
- [ ] **Step 3:** Implement per Behavior. Add `POST /oom` to the stub (Task 4 fixture) if absent.
- [ ] **Step 4:** Tests → PASS.
- [ ] **Step 5:** Commit `feat(instances): reconciler with bounded backoff recovery`.

### Task 9: REST API

**Files:**
- Create: `src/http/server.ts`, `src/main.ts`
- Test: `test/integration/api.test.ts`

**Interfaces:**
- Consumes: `InstanceService`, `Reconciler`, `loadConfig`, `AppError`.
- Produces: `buildServer(deps: { service: InstanceService; config: Config; logger: Logger }): FastifyInstance`. Routes (operator-only for now: `Authorization: Bearer <ADMIN_TOKEN>`, compared with `timingSafeEqual`; real customer auth/tenant membership arrives with the auth milestone, and tenant ids in paths are never treated as authorization there):
  - `POST /api/v1/tenants/:tenantId/instances` body `{ name, planId }`, header `Idempotency-Key` required → `202` `{ instance }`
  - `GET /api/v1/tenants/:tenantId/instances`, `GET …/:instanceId`, `GET …/:instanceId/status`, `GET …/:instanceId/events`
  - `POST …/:instanceId/{start,stop,restart}` → `202`; `DELETE …/:instanceId` → `202`
  - `GET /healthz` unauthenticated (process only, no Docker calls).
  - Errors map from `AppError` to `{ error: { code, message } }`; unknown errors → `500` with generic message; request logs redact `authorization`.

- [ ] **Step 1: Write failing tests** via `server.inject`: missing/wrong bearer → 401; missing `Idempotency-Key` → 400; provision → 202 and subsequently ACTIVE (poll `/status`); wrong tenant path → 404; concurrent restart+stop → one 202, one 409; runtime stub throwing `RuntimeUnavailableError` → 503 and instance status unchanged; response bodies and captured log output never contain the admin token.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement `buildServer` (zod validation per route) and `main.ts` (load config, build deps, start reconciler every 15 s, graceful shutdown).
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(api): operator REST API for instance lifecycle`.

### Task 10: Demo run, documentation, final verification

**Files:**
- Create: `scripts/demo.ts`, `docs/architecture.md`, `docs/setup.md`, `docs/adr/0001-docker-direct-no-orchestrator.md`, `docs/adr/0002-hardened-container-baseline.md`, `README.md`

**Interfaces:**
- Consumes: everything above. `pnpm demo` provisions one instance through the HTTP API against a real DB and Docker, writes a marker file, restarts it, `docker kill`s it, waits for the reconciler to recover it, prints the sanitized event timeline and the marker file contents, then deletes it (flag `--keep` leaves it running).

- [ ] **Step 1:** Write `demo.ts`; run `pnpm demo`; expected: ends with `OK: provisioned → restarted → recovered, data intact`.
- [ ] **Step 2:** Write docs. `setup.md`: prerequisites (Node 22, pnpm, Docker daemon, Postgres via `docker compose up -d postgres`), env vars, migrate, run tests, run demo, running `dockerd` manually in sandboxes. `architecture.md`: module boundaries, lifecycle diagram, hardening table mapped to PRD 7.1 items, naming scheme, image contract for the real Hermes image, recovery rules (no restart on provider-only outages: health probe covers gateway readiness only), and an explicit **Known gaps** list: no disk quota enforcement (Docker named volumes have no size limit without xfs pquota), no network egress policy / SSRF blocking (needs host firewall rules), no gVisor evaluation, no auth, single node, loopback port instead of ingress, `STOPPED` status not in PRD. ADRs: Docker-direct without orchestrator, hardened baseline plus `RestartPolicy: no`.
- [ ] **Step 3:** Full verification from a clean DB: `pnpm build && pnpm test` → all pass; `grep -rn "latest" src/ .env.example` shows no image default; `git ls-files | grep -E "\.env$"` is empty; `docker ps -a --filter label=hermes.cloud/managed=true` shows no leaked test containers (`pnpm test` teardown removes them).
- [ ] **Step 4:** Commit `docs: architecture, setup, ADRs and demo run`.

---

## Self-Review

- **Spec coverage:** brief items 1–7 → audit (done before plan), Tasks 1, 2, 3–6, 7–8, 6–8 tests, 10. PRD 7.1 baseline → Task 3/6; 10.2 lifecycle subset → Task 7; 11.2 idempotency/no duplicates → Task 7; 13.2 bounded recovery, no restart for provider outage → Task 8; 14.1 UUIDs/UTC/tenant scoping → Tasks 2, 7. Deferred items are listed in Global Constraints and Known gaps.
- **Type consistency:** `RuntimeManager`, `RuntimeSpec`, `RuntimeInspection` (Task 3) are what Tasks 5, 7, 8, 9 consume; `InstanceView` and `InstanceService` signatures (Task 7) match Task 9 routes; `Reconciler` uses the `transition`/`recordEvent` helpers declared in Task 7.
- **Review Focus:** each of the five lines has a named test in Tasks 7 (1, 2, 5), 8 (3), 9 and 7 (4).
- **Open items needing the user:** the real Hermes image reference (registry, tag/digest, port, health endpoint, data path, uid); until supplied, tests and demo use the stub image.
