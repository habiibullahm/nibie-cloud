# Per-tenant disk quota and disk usage events

Date: 2026-11-12
Status: draft for review (not approved, nothing implemented, nothing committed)
Branch context: `feat/official-image-compatibility`
Related: PRD 7.1 ("Enforce CPU, memory, PID, and disk quotas"), PRD 13.2 ("Detect disk pressure"),
`docs/architecture.md` known gap 1. Egress/SSRF controls (known gap 2) get their own spec.

## 1. Problem

A tenant can fill the node's disk. `Plan.storageMb` is stored but never applied: `ensure()` calls
`docker.createVolume()` with only a name and labels, so every tenant volume is unbounded. Container
log files are also unbounded (no `LogConfig`). A customer who reaches a limit today would get no
signal, because no limit exists.

## 2. Goals and non-goals

Goals
- Each tenant's data volume is capped at its plan's `storageMb`, enforced by the kernel, so a full
  tenant cannot affect any other tenant or the host.
- Container log growth is bounded.
- The control plane refuses to run a tenant without a quota in production (fail closed).
- Operators see a `disk.warning` / `disk.full` / `disk.ok` event per instance when usage crosses
  thresholds.

Non-goals (stay open)
- Resizing an existing volume's quota on a plan change (decided: quota is set at creation only; the
  design must not block adding resize later).
- Node-level disk pressure checks and "stop scheduling new tenants" (PRD 13.2). Belongs with the
  scheduler work.
- Inode limits, backups, customer-facing usage UI, ext4 or loopback fallback, multi-node.
- Any dashboard or frontend work.
- No git commits and no repository move are part of this spec.

## 3. Decisions (made with the project owner on 2026-11-12)

| Topic | Decision |
| --- | --- |
| Scope | Two separate specs; disk quota first, egress second. |
| Mechanism | Docker local-volume size limit on an XFS filesystem with project quotas (approach 1). |
| Production filesystem | XFS, or an XFS disk can be added. |
| Resize | Not supported. Quota is set when the volume is created. |
| Visibility | Enforcement, log limits and per-instance usage events. No node-level pressure checks. |
| Failure mode | Fail closed in production when quotas cannot be enforced. |

## 4. Approaches considered

1. **Docker local-volume size on XFS project quotas (chosen).** The kernel enforces the cap. No
   privileged helper, no new host daemon, no project-ID bookkeeping in our code. Cannot resize.
2. **Our own `xfs_quota` helper.** Allows resize and exact usage numbers. Needs a root-level helper and
   our own project-ID allocation. Too much machinery for a 5 to 10 user beta.
3. **Fixed-size loopback image per tenant.** Works on any filesystem but adds mounts, fsck handling
   and slower I/O. Only worthwhile if XFS were unavailable.

## 5. Design

### 5.1 Host prerequisite

- Docker's data root (default `/var/lib/docker`) lives on XFS mounted with project quotas
  (`prjquota`, also spelled `pquota`). This is a host setup step, not code.
- `docs/setup.md` gains: how to create or mount the XFS filesystem, the mount option, a check
  command (`findmnt -T /var/lib/docker -o TARGET,FSTYPE,OPTIONS`), and a note that changing the data
  root requires stopping Docker and migrating existing data.
- **Unverified, to be confirmed on the host before implementation:** the exact option spelling the
  Docker Engine API accepts for the volume size on `POST /volumes/create` (`DriverOpts` key and value
  format), and the exact error Docker returns when the backing filesystem lacks quota support. The
  plan's first task is a throwaway check of both on the XFS host. This spec does not assume them.

### 5.2 Configuration (`src/config/env.ts`)

- `HERMES_DISK_QUOTA`: `enforce | off`. Default `enforce`.
- `off` is rejected when `NODE_ENV=production`. It exists so unit tests and a laptop without XFS keep
  working.
- `Config` gains `diskQuota`. Error messages name the key only, never the value.
- At startup with `enforce`, the control plane creates a probe volume with a small size, removes it,
  and exits with a clear error if Docker rejects the size option. This proves Docker accepts the
  option; it does not by itself prove the kernel enforces it (see 5.8, live check).

### 5.3 Runtime (`src/modules/runtime`)

- `ResourceLimits` gains `storageMb` (integer, minimum 64, validated in `buildContainerConfig`
  alongside the existing CPU, memory and PID checks).
- `RuntimeSpec` carries an explicit `diskQuota: 'enforce' | 'off'` so `DockerRuntimeManager` does not
  read global config.
- `ensure()` creates the volume with the size option when `diskQuota` is `enforce`.
- Existing volume handling (`ensure()` is idempotent and recovery re-runs it):
  - Volume exists with no size limit and `enforce` is on: fail with a fixed reason
    `volume_quota_missing`; the instance goes to `FAILED` (retry path unchanged). It never starts
    unbounded. There are no production tenant volumes yet, so no migration is needed.
  - Volume exists with a size different from the plan's `storageMb`: record one `disk.quota_mismatch`
    event and carry on. This is how a plan change shows up, since resize is out of scope. It must not
    block reconciler recovery.
- When the quota is missing during recovery of an already-active instance, the error follows the
  reconciler's existing bounded-retry path and the instance ends `DEGRADED` after its attempts; `FAILED`
  applies to provisioning.
- A new fixed failure code `volume_quota_missing` joins the existing codes
  (`runtime_create_failed`, `health_check_timeout`, ...). No raw Docker error text is stored.

### 5.4 Wiring

- `InstanceService` and `Reconciler` pass `storageMb` from the loaded `Plan` and `diskQuota` from
  config into every `ensure()` call, the same way the hardening-wiring spec adds `apiServerKey` and
  `runtime`. No code path may call `ensure()` without them.

### 5.5 Log limits (`src/modules/runtime/hardening.ts`)

- `HostConfig.LogConfig = { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } }` for
  every tenant container, as named constants. Worst case about 30 MB of host log per tenant, outside
  the volume quota.
- `hardening.test.ts` asserts the log config.
- Not covered: files Hermes writes inside `/opt/data` count against the volume quota like any other
  data. The `/run`, `/tmp` and `/var/run` tmpfs mounts are already size-capped and memory-backed.

### 5.6 Disk usage events (`src/modules/instances/disk-monitor.ts`, new)

- `RuntimeManager` gains `volumeUsage(): Promise<Map<instanceId, usedBytes>>`. One Docker call for all
  volumes (the Engine's volume usage data), mapped to instances by the existing label. This is a
  full-walk operation, so it runs on a slow interval (default 5 minutes, config
  `HERMES_DISK_CHECK_INTERVAL_MS`), never per request. Fine for the launch target of 5 to 10 tenants
  and the 100-tenant ceiling; revisit if measurement shows it is slow.
- `DiskMonitor` compares each instance's usage with `Plan.storageMb` and keeps a level per instance:
  `ok`, `warning` (at or above 90%), `full` (at or above 99%). The 99% margin accounts for the gap
  between measured size and quota accounting; it is a starting value to confirm in the live check.
- It writes an `InstanceEvent` only when the level changes: `disk.warning`, `disk.full`, `disk.ok`.
  Falling from `full` to `warning` needs usage below 97%, and recovery to `ok` needs usage below 85%,
  so a tenant hovering at a threshold does not flap. Moving from `full` straight to `ok` records only
  `disk.ok`. Events are recorded for upward moves and for the return to `ok`; a drop from `full` to
  `warning` records nothing.
- Persistence: `Instance` gains `diskUsedBytes BigInt?` and `diskLevel String @default("ok")`, one
  Prisma migration. Both are written only by the monitor.
- It does not change `status`. A full disk does not mean the gateway is down, and the reconciler
  must not restart a container for it (consistent with PRD 8.3 and ADR 0002).
- It skips instances that are not `ACTIVE`, `DEGRADED` or `STOPPED`, and does nothing if Docker is
  unreachable (same `skipped` behavior as the reconciler).
- Event messages are fixed text with numbers only (percent used), no paths.

### 5.7 Error handling

| Situation | Behavior |
| --- | --- |
| Docker rejects the size option at startup | Process exits with `HERMES_DISK_QUOTA` named in the error. |
| Existing volume has no quota, `enforce` | Instance `FAILED` with `volume_quota_missing`. |
| Plan size differs from existing quota | One `disk.quota_mismatch` event, no state change. |
| Docker unreachable during usage check | Skip this round, no events. |
| Tenant reaches its quota | Writes inside the tenant fail with ENOSPC; other tenants and the host are unaffected; `disk.full` event is recorded. |

### 5.8 Tests

- Unit: `buildContainerConfig` rejects `storageMb` below 64 and non-integers; log config present;
  config rejects `HERMES_DISK_QUOTA=off` in production and unknown values; threshold and
  hysteresis logic of `DiskMonitor` over a sequence of usage readings.
- Integration (Postgres, fake `RuntimeManager`): events are written once per level change; a stable
  level writes nothing; `volume_quota_missing` leads to `FAILED`; a size mismatch writes one event and
  does not block recovery.
- Live harness (`test/validation/runtime-manager-live.ts`, needs the XFS host): a tenant writing past
  its limit gets ENOSPC; a second tenant's volume stays writable; reported usage is within a few
  percent of the real size (this settles the 99% margin); and on a filesystem without quota support
  (any ext4 dev box) enforce mode refuses to create the volume.
- Verification: none of this can run in the authoring environment. The implementation plan ends with
  a verification task run on the XFS and Postgres host. No pass is claimed before then.

### 5.9 Docs

- `docs/architecture.md`: add the quota and log rows to the hardening table, narrow known gap 1 to
  what remains (resize, inode limits, node pressure), and describe `DiskMonitor`.
- `docs/setup.md` and `.env.example`: XFS host steps, `HERMES_DISK_QUOTA`,
  `HERMES_DISK_CHECK_INTERVAL_MS`.
- Update `docs/CURRENT_STATE.md` and `docs/SESSION_HANDOFF.md` per the AGENTS.md continuity protocol.

## 6. Sequencing and file overlap

The hardening-wiring work (spec `2026-11-12-hardening-wiring-design.md`) edits `env.ts`,
`types.ts`, `docker-runtime-manager.ts`, `instance-service.ts` and `reconciler.ts`. This design edits
the same files plus `hardening.ts`. The implementation plan for this spec starts after the wiring
work lands, so the `ensure()` call sites already pass `apiServerKey` and `runtime`.

## 7. Risks and open points

- **Docker option spelling and error shape are unverified** (5.1). Mitigation: first plan task, run on
  the XFS host.
- **Usage measurement cost.** The all-volumes call walks directories. Mitigation: 5-minute interval,
  one call for all tenants, measure on the host.
- **Measured size versus quota accounting** can differ slightly, hence the 99% "full" margin.
- **No resize.** A plan upgrade does not raise the cap until a future change. Customers on a larger
  plan would keep the old cap, so plan changes must not be offered before resize exists.
- **Inodes are not limited.** Many tiny files consume blocks and hit the quota in practice, but a
  separate inode limit is not set.
- **Log files live outside the quota** (about 30 MB per tenant worst case).
- **Changing the Docker data root** is disruptive on a host that already has containers.

## 8. Acceptance criteria

1. Every `ensure()` call passes `storageMb` and `diskQuota`; no code path omits them.
2. In enforce mode, a volume is created with a size limit, and an existing unquotaed volume is never
   started (`volume_quota_missing`).
3. Config rejects `HERMES_DISK_QUOTA=off` when `NODE_ENV=production` and rejects unknown values.
4. Every tenant container has log rotation configured, asserted by `hardening.test.ts`.
5. `DiskMonitor` records `disk.warning`, `disk.full` and `disk.ok` once per level change and never
   changes instance status.
6. The live harness on an XFS host shows ENOSPC at the limit, an unaffected neighbour, usage within
   tolerance, and refusal on a non-quota filesystem, with output recorded; or the work is explicitly
   reported as unverified.
7. `docs/architecture.md`, `docs/setup.md` and `.env.example` match the code.
