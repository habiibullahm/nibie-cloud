import type { ModelConfig } from './hermes-config.js';

export interface ResourceLimits {
  cpuMillis: number;
  memoryMb: number;
  pids: number;
  /** Persistent volume quota in MB, enforced by the kernel when the volume is created. */
  storageMb: number;
}

export type SupportedRuntime = 'runc' | 'runsc';

/** `enforce`: tenant volumes are created with a size quota and never run without one. */
export type DiskQuotaMode = 'enforce' | 'off';

/** `enforce`: tenant networks must carry the `hn` bridge name the host ruleset matches. */
export type EgressPolicyMode = 'enforce' | 'off';

export interface RuntimeSpec {
  instanceId: string;
  tenantId: string;
  image: string;
  limits: ResourceLimits;
  diskQuota: DiskQuotaMode;
  egressPolicy: EgressPolicyMode;
  env: Record<string, string>;
  runtime?: SupportedRuntime;
  apiServerKey?: string;
  /**
   * Platform-managed `model:` block for `/opt/data/config.yaml` (ADR 0003). Applied only when the container
   * is created (`ensure` of a new container, or `recreate`). `undefined`: leave the file alone. `null`: remove
   * a block the platform wrote earlier. The provider key itself is never here; it travels in `env`.
   */
  modelConfig?: ModelConfig | null;
}

export type RuntimeState = 'absent' | 'created' | 'running' | 'exited' | 'restarting' | 'dead';

export interface RuntimeInspection {
  state: RuntimeState;
  exitCode: number | null;
  oomKilled: boolean;
  startedAt: Date | null;
  hostPort: number | null;
  volumePresent: boolean;
}

/** `HealthResult.detail` when the gateway answered 401 to the key we sent: restarting cannot fix that. */
export const AUTH_REJECTED_DETAIL = 'auth rejected';

export interface HealthResult {
  ok: boolean;
  latencyMs: number;
  detail: string;
}

/**
 * The only seam through which the rest of the platform touches containers (PRD 6.3).
 * All operations are keyed by instance UUID; callers never pass container ids,
 * host paths or Docker parameters.
 */
export interface RuntimeManager {
  /**
   * Idempotent: ensures network, volume and an (unstarted) container exist. `volumeQuotaMb` is the
   * quota the volume actually has (null when none).
   */
  ensure(spec: RuntimeSpec): Promise<{ hostPort: number | null; volumeQuotaMb: number | null }>;
  /**
   * Fail-closed guard for the paths that start an existing container without `ensure()` (user start or
   * restart, reconciler restart): throws `VolumeQuotaMissingError` when `mode` is `enforce` and the
   * tenant volume is absent or has no quota. Does nothing when `mode` is `off`.
   */
  assertVolumeQuota(instanceId: string, mode: DiskQuotaMode): Promise<void>;
  /**
   * Removes the container (network and volume stay) and creates it again from `spec`, so a changed
   * environment or model block takes effect. Does not start it. Idempotent like `ensure`.
   */
  recreate(spec: RuntimeSpec): Promise<{ hostPort: number | null; volumeQuotaMb: number | null }>;
  /**
   * Fail-closed guard for the paths that start an existing container without `ensure()`: throws
   * `NetworkPolicyMissingError` when `mode` is `enforce` and the tenant network is absent or lacks the
   * `hn` bridge name the host ruleset matches (a network created before the policy existed). Does
   * nothing when `mode` is `off`.
   */
  assertNetworkPolicy(instanceId: string, mode: EgressPolicyMode): Promise<void>;
  /**
   * Last `tail` lines of the container's output (stdout and stderr), oldest first. Empty when no container
   * exists. Raw: callers must redact before showing it to anyone.
   */
  logs(instanceId: string, opts: { tail: number }): Promise<string[]>;
  start(instanceId: string): Promise<void>;
  /** No-op if already stopped or absent. */
  stop(instanceId: string, timeoutSec?: number): Promise<void>;
  restart(instanceId: string): Promise<void>;
  /** `state: 'absent'` when no container exists. */
  inspect(instanceId: string): Promise<RuntimeInspection>;
  checkHealth(instanceId: string, apiServerKey?: string): Promise<HealthResult>;
  /**
   * Used bytes per tenant volume, keyed by instance id, from a single Docker call. Volumes whose size
   * is unknown or negative are omitted (never reported as 0). Expensive (walks every volume), so
   * callers poll it slowly.
   */
  volumeUsage(): Promise<Map<string, number>>;
  /** No-op if absent. Volume is kept unless `deleteVolume` is true. */
  remove(instanceId: string, opts: { deleteVolume: boolean }): Promise<void>;
}
