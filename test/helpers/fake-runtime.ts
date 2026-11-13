import { NetworkPolicyMissingError, VolumeQuotaMissingError } from '../../src/shared/errors.js';
import {
  AUTH_REJECTED_DETAIL,
  type DiskQuotaMode, type EgressPolicyMode, type HealthResult, type RuntimeInspection, type RuntimeManager, type RuntimeSpec,
} from '../../src/modules/runtime/types.js';

/**
 * In-memory RuntimeManager for tests that care about what the control plane asks the runtime
 * for (specs, probe keys), not about Docker. Mirrors the real manager's key semantics: the key a
 * container was created with is fixed at creation, and only that key is accepted afterwards.
 */
export class FakeRuntime implements RuntimeManager {
  readonly ensured: RuntimeSpec[] = [];
  readonly probeKeys: (string | undefined)[] = [];
  /** When true, every authenticated probe is answered like a gateway that rejects the key. */
  rejectKey = false;
  restarts = 0;
  /** The quota `ensure()` reports for the volume (what a real manager read from Docker). */
  volumeQuotaMb: number | null = null;
  /** When true `ensure()` refuses like a manager that found an unquotaed volume while enforcing. */
  quotaMissing = false;
  /** When true `ensure()` refuses like a manager that found a tenant network without the policy bridge name. */
  networkPolicyMissing = false;
  /** Used bytes per instance id, as `volumeUsage()` reports them. */
  readonly usage = new Map<string, number>();
  /** When set, `volumeUsage()` throws it (e.g. a RuntimeUnavailableError). */
  usageError: Error | null = null;
  private readonly containers = new Map<string, { key: string | undefined; running: boolean }>();

  async ensure(spec: RuntimeSpec): Promise<{ hostPort: number | null; volumeQuotaMb: number | null }> {
    this.ensured.push(spec);
    if (this.networkPolicyMissing) throw new NetworkPolicyMissingError();
    if (this.quotaMissing) throw new VolumeQuotaMissingError();
    if (!this.containers.has(spec.instanceId)) {
      this.containers.set(spec.instanceId, { key: spec.apiServerKey, running: false });
    }
    return { hostPort: null, volumeQuotaMb: this.volumeQuotaMb };
  }

  /** Lines `logs()` returns (the tail is applied like the real manager does). */
  logLines: string[] = [];
  lastLogTail = 0;

  async logs(id: string, opts: { tail: number }): Promise<string[]> {
    this.lastLogTail = opts.tail;
    return this.containers.has(id) ? this.logLines.slice(-opts.tail) : [];
  }

  /** Every spec `recreate()` was called with, so tests can see which environment a container would get. */
  readonly recreated: RuntimeSpec[] = [];

  async recreate(spec: RuntimeSpec): Promise<{ hostPort: number | null; volumeQuotaMb: number | null }> {
    this.recreated.push(spec);
    this.containers.delete(spec.instanceId);
    return this.ensure(spec);
  }

  /** Mirrors the real manager: refuses only when quotas are enforced and the volume has none. */
  async assertVolumeQuota(_id: string, mode: DiskQuotaMode): Promise<void> {
    if (mode === 'enforce' && this.quotaMissing) throw new VolumeQuotaMissingError();
  }

  /** Mirrors the real manager: refuses only when the policy is enforced and the network lacks the name. */
  async assertNetworkPolicy(_id: string, mode: EgressPolicyMode): Promise<void> {
    if (mode === 'enforce' && this.networkPolicyMissing) throw new NetworkPolicyMissingError();
  }

  async start(id: string): Promise<void> {
    const c = this.containers.get(id);
    if (c) c.running = true;
  }

  async stop(id: string): Promise<void> {
    const c = this.containers.get(id);
    if (c) c.running = false;
  }

  async restart(id: string): Promise<void> {
    this.restarts += 1;
    await this.start(id);
  }

  /** Simulates the container disappearing (crash plus removal) while the volume survives. */
  vanish(id: string): void {
    this.containers.delete(id);
  }

  async inspect(id: string): Promise<RuntimeInspection> {
    const c = this.containers.get(id);
    return {
      state: !c ? 'absent' : c.running ? 'running' : 'created',
      exitCode: null, oomKilled: false, startedAt: c?.running ? new Date() : null,
      hostPort: c?.running ? 40000 : null, volumePresent: true,
    };
  }

  async checkHealth(id: string, apiServerKey?: string): Promise<HealthResult> {
    this.probeKeys.push(apiServerKey);
    const c = this.containers.get(id);
    if (!c?.running) return { ok: false, latencyMs: 0, detail: 'runtime not running' };
    if (apiServerKey !== undefined && (this.rejectKey || apiServerKey !== c.key)) {
      return { ok: false, latencyMs: 0, detail: AUTH_REJECTED_DETAIL };
    }
    return { ok: true, latencyMs: 0, detail: 'HTTP 200' };
  }

  async volumeUsage(): Promise<Map<string, number>> {
    if (this.usageError) throw this.usageError;
    return new Map(this.usage);
  }

  async remove(id: string): Promise<void> {
    this.containers.delete(id);
  }
}
