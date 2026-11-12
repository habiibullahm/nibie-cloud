import {
  AUTH_REJECTED_DETAIL,
  type HealthResult, type RuntimeInspection, type RuntimeManager, type RuntimeSpec,
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
  private readonly containers = new Map<string, { key: string | undefined; running: boolean }>();

  async ensure(spec: RuntimeSpec): Promise<{ hostPort: number | null }> {
    this.ensured.push(spec);
    if (!this.containers.has(spec.instanceId)) {
      this.containers.set(spec.instanceId, { key: spec.apiServerKey, running: false });
    }
    return { hostPort: null };
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

  async remove(id: string): Promise<void> {
    this.containers.delete(id);
  }
}
