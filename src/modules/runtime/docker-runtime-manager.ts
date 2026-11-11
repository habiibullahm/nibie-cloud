import Docker from 'dockerode';
import { RuntimeUnavailableError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import {
  CONTAINER_PORT,
  LABEL_INSTANCE,
  LABEL_MANAGED,
  LABEL_TENANT,
  buildContainerConfig,
  containerName,
  networkName,
  volumeName,
} from './hardening.js';
import type { HealthResult, RuntimeInspection, RuntimeManager, RuntimeSpec, RuntimeState } from './types.js';

const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'EACCES', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

function statusCode(e: unknown): number | undefined {
  return (e as { statusCode?: number }).statusCode;
}

/** Docker is the data plane. Daemon connectivity problems become RuntimeUnavailableError. */
function translate(e: unknown): never {
  const code = (e as { code?: string }).code;
  if (code && CONNECTION_CODES.has(code)) throw new RuntimeUnavailableError();
  // Never forward raw Docker messages: they can embed env values or host paths.
  const err = new Error(`Docker operation failed (status ${statusCode(e) ?? 'n/a'})`);
  throw err;
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    return translate(e);
  }
}

export class DockerRuntimeManager implements RuntimeManager {
  private readonly docker: Docker;
  private readonly logger: Logger;
  private readonly healthTimeoutMs: number;

  constructor(opts: { docker?: Docker; logger: Logger; healthTimeoutMs?: number }) {
    this.docker = opts.docker ?? new Docker();
    this.logger = opts.logger;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 2000;
  }

  async ensure(spec: RuntimeSpec): Promise<{ hostPort: number | null }> {
    const config = buildContainerConfig(spec); // validates before touching Docker
    return guard(async () => {
      await this.ensureNetwork(spec);
      await this.docker.createVolume({
        Name: volumeName(spec.instanceId),
        Labels: { [LABEL_MANAGED]: 'true', [LABEL_INSTANCE]: spec.instanceId, [LABEL_TENANT]: spec.tenantId },
      });
      const existing = await this.findContainer(spec.instanceId);
      if (!existing) {
        await this.ensureImage(spec.image);
        try {
          await this.docker.createContainer(config);
        } catch (e) {
          if (statusCode(e) !== 409) throw e; // lost a race with a concurrent ensure
        }
      }
      this.logger.info({ instanceId: spec.instanceId }, 'runtime ensured');
      return { hostPort: null };
    });
  }

  async start(instanceId: string): Promise<void> {
    await guard(async () => {
      try {
        await this.docker.getContainer(containerName(instanceId)).start();
      } catch (e) {
        if (statusCode(e) !== 304) throw e; // already started
      }
    });
  }

  async stop(instanceId: string, timeoutSec = 10): Promise<void> {
    await guard(async () => {
      try {
        await this.docker.getContainer(containerName(instanceId)).stop({ t: timeoutSec });
      } catch (e) {
        if (statusCode(e) !== 304 && statusCode(e) !== 404) throw e;
      }
    });
  }

  async restart(instanceId: string): Promise<void> {
    await guard(() => this.docker.getContainer(containerName(instanceId)).restart({ t: 10 }));
  }

  async inspect(instanceId: string): Promise<RuntimeInspection> {
    return guard(async () => {
      const volumePresent = await this.volumeExists(instanceId);
      let info: Docker.ContainerInspectInfo;
      try {
        info = await this.docker.getContainer(containerName(instanceId)).inspect();
      } catch (e) {
        if (statusCode(e) === 404) {
          return { state: 'absent', exitCode: null, oomKilled: false, startedAt: null, hostPort: null, volumePresent };
        }
        throw e;
      }
      const s = info.State;
      const state = (['created', 'running', 'exited', 'restarting', 'dead'].includes(s.Status)
        ? s.Status
        : s.Running ? 'running' : 'exited') as RuntimeState;
      const bound = info.NetworkSettings.Ports?.[`${CONTAINER_PORT}/tcp`]?.[0]?.HostPort;
      const started = s.StartedAt && !s.StartedAt.startsWith('0001') ? new Date(s.StartedAt) : null;
      return {
        state,
        exitCode: state === 'running' || state === 'created' ? null : s.ExitCode,
        oomKilled: Boolean(s.OOMKilled),
        startedAt: started,
        hostPort: state === 'running' && bound ? Number(bound) : null,
        volumePresent,
      };
    });
  }

  async checkHealth(instanceId: string, apiServerKey?: string): Promise<HealthResult> {
    const i = await this.inspect(instanceId);
    if (i.state !== 'running' || !i.hostPort) {
      return { ok: false, latencyMs: 0, detail: `runtime not running (${i.state})` };
    }
    const t0 = Date.now();
    try {
      const headers: Record<string, string> = {};
      if (apiServerKey) {
        headers['Authorization'] = `Bearer ${apiServerKey}`;
      }
      // Query loopback gateway status
      const res = await fetch(`http://127.0.0.1:${i.hostPort}/api/sessions`, {
        headers,
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      // HTTP 200 (authenticated) or HTTP 401 (gateway alive and enforcing auth) confirms daemon health
      const isAlive = res.status === 200 || res.status === 401;
      return { ok: isAlive, latencyMs: Date.now() - t0, detail: `HTTP ${res.status}` };
    } catch (e) {
      const name = (e as Error).name === 'TimeoutError' ? 'timeout' : 'connection failed';
      return { ok: false, latencyMs: Date.now() - t0, detail: name };
    }
  }

  async remove(instanceId: string, opts: { deleteVolume: boolean }): Promise<void> {
    await guard(async () => {
      const ignore404 = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (e) {
          if (statusCode(e) !== 404) throw e;
        }
      };
      await ignore404(() => this.docker.getContainer(containerName(instanceId)).remove({ force: true }));
      await ignore404(() => this.docker.getNetwork(networkName(instanceId)).remove());
      if (opts.deleteVolume) await ignore404(() => this.docker.getVolume(volumeName(instanceId)).remove());
    });
  }

  private async findContainer(instanceId: string): Promise<boolean> {
    try {
      await this.docker.getContainer(containerName(instanceId)).inspect();
      return true;
    } catch (e) {
      if (statusCode(e) === 404) return false;
      throw e;
    }
  }

  private async volumeExists(instanceId: string): Promise<boolean> {
    try {
      await this.docker.getVolume(volumeName(instanceId)).inspect();
      return true;
    } catch (e) {
      if (statusCode(e) === 404) return false;
      throw e;
    }
  }

  private async ensureNetwork(spec: RuntimeSpec): Promise<void> {
    const name = networkName(spec.instanceId);
    try {
      await this.docker.getNetwork(name).inspect();
      return;
    } catch (e) {
      if (statusCode(e) !== 404) throw e;
    }
    try {
      await this.docker.createNetwork({
        Name: name,
        Driver: 'bridge',
        Options: { 'com.docker.network.bridge.enable_icc': 'false' },
        Labels: { [LABEL_MANAGED]: 'true', [LABEL_INSTANCE]: spec.instanceId },
      });
    } catch (e) {
      if (statusCode(e) !== 409) throw e;
    }
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
    } catch (e) {
      if (statusCode(e) !== 404) throw e;
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          this.docker.modem.followProgress(stream, (e2: Error | null) => (e2 ? reject(e2) : resolve()));
        });
      });
    }
  }
}
