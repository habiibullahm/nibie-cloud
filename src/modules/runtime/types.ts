export interface ResourceLimits {
  cpuMillis: number;
  memoryMb: number;
  pids: number;
}

export type SupportedRuntime = 'runc' | 'runsc';

export interface RuntimeSpec {
  instanceId: string;
  tenantId: string;
  image: string;
  limits: ResourceLimits;
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
  /** Idempotent: ensures network, volume and an (unstarted) container exist. */
  ensure(spec: RuntimeSpec): Promise<{ hostPort: number | null }>;
  start(instanceId: string): Promise<void>;
  /** No-op if already stopped or absent. */
  stop(instanceId: string, timeoutSec?: number): Promise<void>;
  restart(instanceId: string): Promise<void>;
  /** `state: 'absent'` when no container exists. */
  inspect(instanceId: string): Promise<RuntimeInspection>;
  checkHealth(instanceId: string, apiServerKey?: string): Promise<HealthResult>;
  /** No-op if absent. Volume is kept unless `deleteVolume` is true. */
  remove(instanceId: string, opts: { deleteVolume: boolean }): Promise<void>;
}
