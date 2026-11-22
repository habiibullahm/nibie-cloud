import { Agent, request } from 'node:https';
import type { SecureContextOptions } from 'node:tls';
import { NetworkPolicyMissingError, RuntimeUnavailableError, ValidationError, VolumeQuotaMissingError } from '../../shared/errors.js';
import type { HostUsage } from '../admin/host-usage.js';
import type { readBackupMetadata } from '../instances/backup-metadata.js';
import { AGENT_API, AGENT_VERSION, type AgentCall, type QuotaList } from './agent-protocol.js';
import { ConfigUnreadableError } from './hermes-config.js';
import type { RuntimeInspection, RuntimeManager, RuntimeSpec } from './types.js';

type Backup = Awaited<ReturnType<typeof readBackupMetadata>>;
type InspectionWire = Omit<RuntimeInspection, 'startedAt'> & { startedAt: string | null };

export class RuntimeAgentClient implements RuntimeManager {
  private readonly agent: Agent;
  private readonly endpoint: URL;

  constructor(readonly name: string, origin: string, tls: SecureContextOptions) {
    this.agent = new Agent({ ...tls, keepAlive: true, maxSockets: 8, minVersion: 'TLSv1.2', rejectUnauthorized: true });
    this.endpoint = new URL(AGENT_API, origin);
  }

  private async call<T>(body: AgentCall | { op: 'ensure' | 'recreate'; spec: RuntimeSpec }, timeoutMs = 45_000): Promise<T> {
    const encoded = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const fail = () => reject(new RuntimeUnavailableError());
      const req = request(this.endpoint, {
        method: 'POST', agent: this.agent, signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) },
      }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('error', fail);
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) { fail(); req.destroy(); return; }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { value?: T; error?: string };
            if (res.statusCode === 200 && 'value' in result) { resolve(result.value as T); return; }
            switch (result.error) {
              case 'volume_quota_missing': reject(new VolumeQuotaMissingError()); return;
              case 'network_policy_missing': reject(new NetworkPolicyMissingError()); return;
              case 'config_unreadable': reject(new ConfigUnreadableError()); return;
              case 'invalid_request': reject(new ValidationError('Runtime node rejected the operation')); return;
              default: fail();
            }
          } catch { fail(); }
        });
      });
      req.on('error', fail);
      req.end(encoded);
    });
  }

  async ready(): Promise<HostUsage | null> {
    const result = await this.call<{ name: string; version: number; host: HostUsage | null }>({ op: 'ready' }, 2_500);
    if (result.name !== this.name || result.version !== AGENT_VERSION) throw new RuntimeUnavailableError();
    return result.host;
  }
  close() { this.agent.destroy(); }
  backup(instanceId: string) { return this.call<Backup>({ op: 'backup', instanceId }, 3_000); }
  quotaPolicy(volumes: QuotaList) { return this.call<void>({ op: 'quotaPolicy', volumes }, 3_000); }
  ensure(spec: RuntimeSpec) { return this.call<Awaited<ReturnType<RuntimeManager['ensure']>>>({ op: 'ensure', spec }, 300_000); }
  recreate(spec: RuntimeSpec) { return this.call<Awaited<ReturnType<RuntimeManager['recreate']>>>({ op: 'recreate', spec }, 300_000); }
  assertVolumeQuota(instanceId: string) { return this.call<void>({ op: 'assertVolumeQuota', instanceId }); }
  assertNetworkPolicy(instanceId: string) { return this.call<void>({ op: 'assertNetworkPolicy', instanceId }); }
  logs(instanceId: string, { tail }: { tail: number }) { return this.call<string[]>({ op: 'logs', instanceId, tail }); }
  start(instanceId: string) { return this.call<void>({ op: 'start', instanceId }); }
  stop(instanceId: string, timeoutSec?: number) { return this.call<void>({ op: 'stop', instanceId, timeoutSec }); }
  restart(instanceId: string) { return this.call<void>({ op: 'restart', instanceId }); }
  async inspect(instanceId: string) {
    const result = await this.call<InspectionWire>({ op: 'inspect', instanceId }, 3_000);
    return { ...result, startedAt: result.startedAt ? new Date(result.startedAt) : null };
  }
  checkHealth(instanceId: string, apiServerKey?: string) {
    return this.call<Awaited<ReturnType<RuntimeManager['checkHealth']>>>({ op: 'checkHealth', instanceId, apiServerKey }, 5_000);
  }
  async volumeUsage() { return new Map(await this.call<[string, number][]>({ op: 'volumeUsage' })); }
  remove(instanceId: string, { deleteVolume }: { deleteVolume: boolean }) {
    return this.call<void>({ op: 'remove', instanceId, deleteVolume });
  }
}
