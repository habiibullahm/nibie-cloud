# Disk Quota and Disk Usage Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (default) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap every tenant volume at its plan's `storageMb` with a kernel-enforced XFS project quota, bound container log growth, refuse to run an unquotaed tenant in production, and record `disk.warning` / `disk.full` / `disk.ok` events per instance.

**Architecture:** `ensure()` creates the tenant volume with Docker's local-volume size option and reports the quota it found on an existing volume. `InstanceService` and `Reconciler` pass `storageMb` and the quota mode, map a missing quota to a fixed failure reason, and record a mismatch event. A new `DiskMonitor` reads all volume sizes in one Docker call on a slow interval and writes an event only when an instance's level changes. Startup probes that Docker accepts the size option.

**Tech Stack:** Node >=22, TypeScript, Fastify 5, Zod 4, Prisma 6.19 + PostgreSQL 16, dockerode 5, Vitest 3.2, pnpm 10.28.

**Spec:** `docs/superpowers/specs/2026-11-12-disk-quota-design.md`

## Global Constraints

- No git commit, push, stash or reset without Nash's explicit instruction (AGENTS.md). Every "Commit" step runs **only** after Nash says to commit; until then leave changes in the working tree. The repository is public: no keys, tokens, host names or personal data in any file.
- Config: `HERMES_DISK_QUOTA` is `enforce | off`, default `enforce`; `off` is rejected when `NODE_ENV=production`. `HERMES_DISK_CHECK_INTERVAL_MS` is an integer, default `300000`. Error messages name the key, never the value.
- `ResourceLimits.storageMb`: integer, minimum `64`.
- Quota is set when the volume is created. No resize, no node-level pressure checks, no inode limits, no ext4 or loopback fallback.
- Existing volume with no quota while `enforce`: fixed reason `volume_quota_missing`. Existing volume whose quota differs from the plan: one `disk.quota_mismatch` event, no state change.
- Container logs: `LogConfig { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } }` on every tenant container.
- Levels: `warning` at or above 90%, `full` at or above 99% of `Plan.storageMb`. Falling from `full` to `warning` needs usage below 97% and records no event. Returning to `ok` needs usage below 85% and records `disk.ok`. Events fire only on a level change. The monitor never changes `status` and never restarts a container.
- `Instance` gains `diskUsedBytes BigInt?` and `diskLevel String @default("ok")`, one migration, written only by the monitor.
- Event messages are fixed text plus numbers (percent used), never paths or raw Docker text.
- Tests that need Docker, Postgres or an XFS host cannot run in the authoring sandbox. Nothing may be reported as passing before Task 8 is run on an XFS and Postgres host. `pnpm test:unit` and `pnpm build` run anywhere.
- Out of scope: the egress plan, dashboard work, plan-change billing.

## Review Focus

- A plan with `storageMb` 63 or a non-integer is rejected before Docker is touched (Task 2).
- A volume created before this change (no quota) is never started while `enforce` is on, in provisioning and in recovery (Task 4).
- A tenant sitting at exactly 90% or 99% does not flap between levels or write an event per poll (Task 6).
- A `volumeUsage()` entry with an unknown or negative size is skipped, not treated as zero usage (Task 6).
- Docker unreachable during a usage poll writes no events and changes no state (Task 6).

---

### Task 1: Host verification spike (no repo code)

Run on the XFS production-class host. Its output replaces every "unverified" in spec section 5.1 and fixes two constants used by Tasks 3 and 5.

**Files:**
- Create: `docs/disk-quota-host-notes.md` (results only, no host names or secrets)

**Interfaces:**
- Produces: the exact `DriverOpts` shape for a sized volume (used as `sizedVolumeOpts` in Task 3) and the exact failure signature when the filesystem has no quota support (used as `isQuotaUnsupported` in Task 3).

- [ ] **Step 1:** Confirm `findmnt -T /var/lib/docker -o TARGET,FSTYPE,OPTIONS` shows `xfs` with `prjquota` or `pquota`. If not, stop and fix the host first (see Task 8 for the setup text).
- [ ] **Step 2:** Create a 64 MB volume both ways and record which one `docker volume inspect` shows as limited: `docker volume create --driver local --opt size=64m probe-a` and `docker volume create --driver local --opt o=size=64m probe-b`. Record the Engine API `DriverOpts` JSON that corresponds to the working form.
- [ ] **Step 3:** For the working volume, run `docker run --rm -v probe-a:/d alpine sh -c 'dd if=/dev/zero of=/d/f bs=1M count=100'`. Expected: it stops at about 64 MB with `No space left on device`. Record the observed stop size.
- [ ] **Step 4:** On a filesystem without quota support (any ext4 dev box), run the same create. Record whether Docker errors at create time and the exact HTTP status and message. If it does not error, record that fact; Task 3 then must detect missing quota by inspecting the volume instead.
- [ ] **Step 5:** `docker system df -v` (and the Engine `GET /system/df?type=volume`): record whether `UsageData.Size` is populated for local volumes and how long the call takes with 10 volumes.
- [ ] **Step 6:** Remove all probe volumes. Write the results into `docs/disk-quota-host-notes.md`, then update the spec's section 5.1 and risk list to state what was verified and what was not.

### Task 2: Config, limits and log rotation

**Files:**
- Modify: `src/config/env.ts`, `src/modules/runtime/types.ts`, `src/modules/runtime/hardening.ts`
- Modify (add `storageMb: 1024` to every `limits` literal): `test/unit/hardening.test.ts`, `test/integration/persistence.test.ts`, `test/integration/runtime-manager.test.ts`, `test/integration/isolation.test.ts`, `test/validation/runtime-manager-live.ts`
- Test: `test/unit/config.test.ts`, `test/unit/hardening.test.ts`

**Interfaces:**
- Produces: `Config.diskQuota: 'enforce' | 'off'`, `Config.diskCheckIntervalMs: number`; `type DiskQuotaMode = 'enforce' | 'off'` and `ResourceLimits.storageMb: number` and `RuntimeSpec.diskQuota: DiskQuotaMode` in `types.ts`; exported constant `LOG_CONFIG` in `hardening.ts`.

- [ ] **Step 1: Write failing tests.** `config.test.ts`: `defaults HERMES_DISK_QUOTA to enforce`; `rejects HERMES_DISK_QUOTA=off when NODE_ENV=production` (message contains `HERMES_DISK_QUOTA`, not the value); `accepts off outside production`; `rejects an unknown HERMES_DISK_QUOTA`; `defaults HERMES_DISK_CHECK_INTERVAL_MS to 300000 and rejects a non-integer`. `hardening.test.ts`: `rejects storageMb below 64 and non-integers` (63, 64.5 throw `ValidationError`, 64 accepted); `sets json-file log rotation of 10m x 3` (`HostConfig.LogConfig` equals `{ Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } }`).
- [ ] **Step 2:** Run `pnpm vitest run test/unit/config.test.ts test/unit/hardening.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** `env.ts`: `HERMES_DISK_QUOTA: z.enum(['enforce','off']).default('enforce')`, `HERMES_DISK_CHECK_INTERVAL_MS: z.coerce.number().int().min(1000).default(300000)`, plus a refinement that rejects `off` when `NODE_ENV` is `production` (issue path `HERMES_DISK_QUOTA`). `types.ts` and `hardening.ts` as in Interfaces; validate `storageMb` next to the other limits with the same message style; add `LogConfig: LOG_CONFIG` to `hostConfig`. `diskQuota` in `RuntimeSpec` is required.
- [ ] **Step 4:** Run `pnpm build && pnpm test:unit`. Expected: PASS, no type errors (the edited `limits` literals compile).
- [ ] **Step 5: Commit** (only on Nash's go-ahead): `feat(runtime): disk quota config, storageMb limit, log rotation`.

### Task 3: Sized volumes and existing-volume handling in the runtime manager

**Files:**
- Modify: `src/modules/runtime/types.ts`, `src/modules/runtime/docker-runtime-manager.ts`, `src/shared/errors.ts`
- Test: `test/unit/volume-quota.test.ts` (new, fake dockerode), `test/integration/runtime-manager.test.ts`

**Interfaces:**
- Consumes: Task 1's recorded `DriverOpts` shape and unsupported-filesystem signature; `RuntimeSpec.diskQuota`, `limits.storageMb`.
- Produces: `RuntimeManager.ensure(spec): Promise<{ hostPort: number | null; volumeQuotaMb: number | null }>`; `class VolumeQuotaMissingError extends AppError` (status 409, code `volume_quota_missing`) in `shared/errors.ts`; exported helper `sizedVolumeOpts(storageMb: number): Record<string, string>` and `readVolumeQuotaMb(volume: { Options?: Record<string,string> | null }): number | null` in a new `src/modules/runtime/volume-quota.ts`.

- [ ] **Step 1: Write failing tests** in `volume-quota.test.ts` against a fake dockerode with an in-memory volume store: `creates the volume with the sized options when enforce`; `creates it without size options when off`; `reports the existing quota in MB through volumeQuotaMb`; `throws VolumeQuotaMissingError for an existing volume without a quota when enforce`; `does not throw for an existing unquotaed volume when off`; `readVolumeQuotaMb parses the recorded option and returns null when absent`; `a create-time filesystem rejection becomes VolumeQuotaMissingError` (using Task 1's signature).
- [ ] **Step 2:** Run `pnpm vitest run test/unit/volume-quota.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `volume-quota.ts` and use it in `DockerRuntimeManager.ensure()`: create the volume with `DriverOpts: sizedVolumeOpts(limits.storageMb)` when `enforce`; if the volume already exists, inspect it and read the quota; in `enforce` with `null` throw `VolumeQuotaMissingError`; return `volumeQuotaMb`. `translate()` must pass `AppError` subclasses through unchanged so the typed error reaches callers.
- [ ] **Step 4:** Run the same test plus `pnpm build`. Expected: PASS.
- [ ] **Step 5:** In `test/integration/runtime-manager.test.ts` add `refuses an existing unquotaed volume in enforce mode` (create a plain volume named `volumeName(id)` through dockerode, then `ensure()` with `diskQuota: 'enforce'` rejects with `VolumeQuotaMissingError`); it needs Docker only, and the positive path needs XFS (see Task 8).
- [ ] **Step 6: Commit** (only on Nash's go-ahead): `feat(runtime): create tenant volumes with a size quota`.

### Task 4: Wire quota into provisioning and recovery

**Files:**
- Modify: `src/modules/instances/instance-service.ts`, `src/modules/instances/reconciler.ts`, `src/main.ts`, `test/helpers/fake-runtime.ts`, `test/helpers/service-env.ts`
- Test: `test/integration/disk-wiring.test.ts` (new; Postgres plus `FakeRuntime`)

**Interfaces:**
- Consumes: Task 3's `ensure()` result and `VolumeQuotaMissingError`.
- Produces: `InstanceServiceDeps.diskQuota` and `ReconcilerDeps.diskQuota` (`DiskQuotaMode`, required); `FakeRuntime` gains `volumeQuotaMb: number | null = null` (what `ensure()` reports) and `quotaMissing = false` (when true `ensure()` throws `VolumeQuotaMissingError`).

- [ ] **Step 1: Write failing tests** in `disk-wiring.test.ts`: `passes the plan's storageMb and the quota mode on every ensure call` (provisioning and a reconciler re-ensure after `vanish`); `provisioning with a missing quota ends FAILED with reason volume_quota_missing`; `recovery with a missing quota never starts the container and ends DEGRADED after the bounded attempts`; `a quota different from the plan records one disk.quota_mismatch event and keeps the instance ACTIVE`; `a matching quota records no event`.
- [ ] **Step 2:** Run `pnpm vitest run test/integration/disk-wiring.test.ts`. Expected: FAIL (needs Postgres).
- [ ] **Step 3: Implement.** Both `ensure()` call sites add `storageMb: plan.storageMb` to `limits` and `diskQuota`. In `provisionSteps`, map `VolumeQuotaMissingError` to reason `volume_quota_missing`. After a successful `ensure()`, when `volumeQuotaMb` is not null and differs from `plan.storageMb`, call `recordEvent(prisma, id, 'disk.quota_mismatch', 'Volume quota differs from plan')`. The reconciler needs no new reason code: the thrown error falls into its existing bounded-retry path and the instance ends `DEGRADED`. **Spec clarification:** the spec said `FAILED` for this case; that holds for provisioning, while recovery of an already-active instance degrades after its attempts. `main.ts` passes `config.diskQuota` to both.
- [ ] **Step 4:** Run the test file and `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** (only on Nash's go-ahead): `feat(instances): apply plan storage quota on provision and recovery`.

### Task 5: Startup quota probe

**Files:**
- Create: `src/modules/runtime/disk-quota-check.ts`
- Modify: `src/main.ts`
- Test: `test/unit/disk-quota-check.test.ts`

**Interfaces:**
- Consumes: `sizedVolumeOpts`, Task 1's unsupported-filesystem signature.
- Produces: `assertDiskQuotaSupported(docker: { createVolume(o: object): Promise<unknown>; getVolume(n: string): { remove(): Promise<unknown> } }, mode: DiskQuotaMode): Promise<void>`. Follows `runtime-availability.ts`.

- [ ] **Step 1: Write failing tests** (fake docker): `does nothing and never calls Docker when off`; `creates and removes a 64 MB probe volume when enforce`; `removes the probe volume even when creation succeeds but inspection shows no quota`; `fails with a message naming HERMES_DISK_QUOTA when Docker rejects the size option`.
- [ ] **Step 2:** Run `pnpm vitest run test/unit/disk-quota-check.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with a probe volume named `hermes-quota-probe-<random uuid>`, and call it in `main.ts` right after `assertRuntimeAvailable`.
- [ ] **Step 4:** Run the test, `pnpm build`, `pnpm test:unit`. Expected: PASS.
- [ ] **Step 5: Commit** (only on Nash's go-ahead): `feat(runtime): probe quota support at startup`.

### Task 6: DiskMonitor, usage reading and migration

**Files:**
- Create: `src/modules/instances/disk-monitor.ts`, `prisma/migrations/<timestamp>_add_disk_usage/migration.sql`
- Modify: `prisma/schema.prisma`, `src/modules/runtime/types.ts`, `src/modules/runtime/docker-runtime-manager.ts`, `src/main.ts`, `test/helpers/fake-runtime.ts`, `test/helpers/service-env.ts` (`wrapRuntime` delegates `volumeUsage`)
- Test: `test/unit/disk-level.test.ts`, `test/integration/disk-monitor.test.ts`, `test/integration/schema.test.ts`

**Interfaces:**
- Produces: `RuntimeManager.volumeUsage(): Promise<Map<string, number>>` (instance id to used bytes; ids from the `hermes.cloud/instance-id` label, entries with unknown or negative size omitted); `type DiskLevel = 'ok' | 'warning' | 'full'`; pure `nextDiskLevel(prev: DiskLevel, usedBytes: number, limitBytes: number): DiskLevel`; `class DiskMonitor` with `constructor(deps: { prisma; runtime; logger; now?: () => Date })`, `pollOnce(): Promise<void>` and `start(intervalMs: number): () => void` (same shape as `Reconciler.start`, `timer.unref()`, no overlapping runs).

- [ ] **Step 1: Write failing unit tests** for `nextDiskLevel`: `ok to warning at 90%`; `ok to full at 99%`; `warning stays warning at 89% and 90%`; `warning to ok only below 85%`; `full to warning only below 97%`; `full stays full at 98%`; `full jumps to ok below 85%`; `zero or missing limit returns the previous level`.
- [ ] **Step 2:** Run `pnpm vitest run test/unit/disk-level.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `nextDiskLevel` as a pure function in `disk-monitor.ts`.
- [ ] **Step 4: Write failing integration tests** (Postgres, `FakeRuntime.usage` map): `records disk.warning once for repeated polls at 91%`; `records disk.full then nothing on a stable full level`; `records disk.ok when usage drops below 85%`; `a drop from full to warning records no event but updates diskLevel`; `skips instances that are not ACTIVE, DEGRADED or STOPPED`; `skips an instance missing from the usage map instead of treating it as 0 bytes`; `a RuntimeUnavailableError from volumeUsage writes no events and leaves diskLevel unchanged`; `never changes status or restarts a container`; `stores diskUsedBytes`. `schema.test.ts`: the two new columns exist with the stated default.
- [ ] **Step 5:** Run `pnpm vitest run test/integration/disk-monitor.test.ts`. Expected: FAIL.
- [ ] **Step 6: Implement** the migration and schema fields, `FakeRuntime.volumeUsage()`, `DockerRuntimeManager.volumeUsage()` (one `docker.df()` call; map volume names `hermes-data-<uuid>` or the instance label to the used size; shape per Task 1 Step 5), and `DiskMonitor.pollOnce`. Event messages: `Disk usage at <n>% of quota` for warning and full, `Disk usage back to normal` for ok. `main.ts` starts the monitor at `config.diskCheckIntervalMs` and stops it in `shutdown()`.
- [ ] **Step 7:** Run `pnpm build`, `pnpm test:unit`, then the integration files above. Expected: PASS.
- [ ] **Step 8: Commit** (only on Nash's go-ahead): `feat(instances): disk usage events via DiskMonitor`.

### Task 7: Docs

**Files:**
- Modify: `docs/architecture.md`, `docs/setup.md`, `.env.example`, `docs/CURRENT_STATE.md`, `docs/README.md`

- [ ] **Step 1:** `architecture.md`: add quota and log-rotation rows to the hardening table, describe `DiskMonitor` and the existing-volume rules, and rewrite known gap 1 to what remains (resize, inode limits, node-level pressure, log files outside the quota at about 30 MB per tenant).
- [ ] **Step 2:** `setup.md`: the XFS host steps (create or mount an XFS filesystem with `prjquota`, point Docker's data root at it, restart Docker; moving the data root with existing containers is disruptive), the `findmnt` check, `HERMES_DISK_QUOTA`, `HERMES_DISK_CHECK_INTERVAL_MS`. `.env.example`: both keys with defaults and a comment that `off` is not allowed in production.
- [ ] **Step 3:** `CURRENT_STATE.md`: record what exists, what was run, and what was not. `docs/README.md`: list the new spec, plan and host-notes file.
- [ ] **Step 4:** Check that no host name, key or personal data appears in any changed file: `git grep -n -i -E "password|token|secret" -- docs/setup.md .env.example` shows only the existing placeholders.

### Task 8: Verification on the XFS and Postgres host

- [ ] **Step 1:** On the host, run `pnpm install && pnpm build && pnpm test`. Record the totals.
- [ ] **Step 2:** Extend `test/validation/runtime-manager-live.ts` (same `check()` style) with: `a tenant writing past its quota gets ENOSPC` (exec a `dd` larger than the plan's `storageMb` in the container and assert the failure and a size near the limit); `a second tenant's volume stays writable while the first is full`; `volumeUsage() reports the first tenant within 5% of the bytes written`; `ensure() refuses an unquotaed existing volume`; `container log config shows json-file 10m x 3 in docker inspect`.
- [ ] **Step 3:** Run it on runc and on runsc: `pnpm tsx test/validation/runtime-manager-live.ts`. Expected: every check PASS.
- [ ] **Step 4:** On a non-XFS host run the startup probe path (start `pnpm dev` with `HERMES_DISK_QUOTA=enforce`). Expected: the process exits with a message naming `HERMES_DISK_QUOTA`.
- [ ] **Step 5:** Record the full output in `docs/milestone-2-runtime-security.md` under a new "Disk quota verification" heading. If any step could not run, say so there and in `CURRENT_STATE.md`; do not claim a pass.
