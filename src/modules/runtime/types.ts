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

export interface RuntimeSpec {
  instanceId: string;
  tenantId: string;
  image: string;
  limits: ResourceLimits;
  diskQuota: DiskQuotaMode;
  env: Record<string, string>;
  runtime?: SupportedRuntime;
  apiServerKey?: string;
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
