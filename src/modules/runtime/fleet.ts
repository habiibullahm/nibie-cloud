import type { PrismaClient } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { RuntimeUnavailableError } from '../../shared/errors.js';
import { readHostUsage, type HostUsage } from '../admin/host-usage.js';
import { readBackupMetadata } from '../instances/backup-metadata.js';
import { RuntimeAgentClient } from './agent-client.js';
import { nodeName } from './agent-protocol.js';
import type { ResourceLimits, RuntimeManager, RuntimeSpec } from './types.js';

const limit = z.number().int().positive();
const node = z.strictObject({
  name: nodeName, region: nodeName,
  cpuMillis: limit, memoryMb: limit, storageMb: limit,
});
const httpsOrigin = z.string().refine((value) => {
  try { return new URL(value).origin === value && value.startsWith('https://'); }
  catch { return false; }
}, 'Expected an HTTPS origin');
const fleetFile = z.strictObject({
  local: node,
  remote: z.array(node.extend({ origin: httpsOrigin, tlsDir: z.string().min(1) })).max(32),
});

type Node = z.infer<typeof node>;
type Entry = {
  id: string;
  config: Node;
  runtime: RuntimeManager;
  client?: RuntimeAgentClient;
  ready: () => Promise<HostUsage | null>;
  lastSeenAt: number;
  host: HostUsage | null;
};
export type NodeCapacity = Pick<ResourceLimits, 'cpuMillis' | 'memoryMb' | 'storageMb'>;
export type PlacementNode = NodeCapacity & { id: string };

export async function loadAgentTls(dir: string) {
  const [ca, cert, key] = await Promise.all(['ca.crt', 'tls.crt', 'tls.key'].map((file) => readFile(join(dir, file))));
  return { ca, cert, key };
}

export class RuntimeFleet implements RuntimeManager {
  private timer?: NodeJS.Timeout;
  private refreshing = false;
  private constructor(private readonly prisma: PrismaClient, private readonly entries: Map<string, Entry>) {}

  static async open(o: {
    file: string; prisma: PrismaClient; local: RuntimeManager; ping: () => Promise<unknown>;
  }): Promise<RuntimeFleet> {
    const config = fleetFile.parse(JSON.parse(await readFile(o.file, 'utf8')));
    const configs = [config.local, ...config.remote];
    if (new Set(configs.map(({ name }) => name)).size !== configs.length) throw new Error('Duplicate runtime node name');
    const existing = await o.prisma.runtimeNode.findMany({ select: { name: true, agentManaged: true } });
    if (existing.length > 0 && !existing.some(({ name, agentManaged }) => name === config.local.name && !agentManaged)) {
      throw new Error('The local runtime node must match its existing database name');
    }
    const entries = new Map<string, Entry>();
    for (const cfg of configs) {
      const local = cfg.name === config.local.name;
      const remote = config.remote.find(({ name }) => name === cfg.name);
      const client = remote ? new RuntimeAgentClient(remote.name, remote.origin, await loadAgentTls(remote.tlsDir)) : undefined;
      const row = await o.prisma.runtimeNode.upsert({
        where: { name: cfg.name }, update: { agentManaged: !local },
        create: { name: cfg.name, region: cfg.region, schedulable: local, agentManaged: !local },
      });
      if (row.region !== cfg.region) throw new Error('Runtime node region differs from the database');
      entries.set(row.id, {
        id: row.id, config: cfg, client, runtime: client ?? o.local, lastSeenAt: 0, host: null,
        ready: client ? () => client.ready() : async () => {
          await Promise.race([
            o.ping(),
            delay(2_500, undefined, { ref: false }).then(() => { throw new RuntimeUnavailableError(); }),
          ]);
          return readHostUsage();
        },
      });
    }
    const fleet = new RuntimeFleet(o.prisma, entries);
    await fleet.refresh();
    fleet.timer = setInterval(() => { void fleet.refresh(); }, 10_000);
    fleet.timer.unref();
    return fleet;
  }

  private async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await Promise.all([...this.entries.values()].map(async (entry) => {
        try {
          entry.host = await entry.ready();
          entry.lastSeenAt = Date.now();
        } catch { entry.lastSeenAt = 0; }
      }));
      const remote = [...this.entries.values()].filter((entry) => entry.client && this.online(entry));
      if (remote.length) {
        const rows = await this.prisma.instance.findMany({
          where: { nodeId: { in: remote.map(({ id }) => id) }, status: { notIn: ['DELETING', 'DELETED'] } },
          select: { id: true, nodeId: true, plan: { select: { storageMb: true } } },
        });
        await Promise.allSettled(remote.map((entry) => entry.client!.quotaPolicy(
          rows.filter((row) => row.nodeId === entry.id).map((row) => ({ instanceId: row.id, storageMb: row.plan.storageMb })),
        )));
      }
    } catch {
      // Keep runtime health available even when the desired quota inventory cannot be refreshed.
    } finally { this.refreshing = false; }
  }
  private online(entry: Entry) { return Date.now() - entry.lastSeenAt < 30_000; }
  placementNodes(): PlacementNode[] {
    return [...this.entries.values()].filter((entry) => this.online(entry))
      .map(({ id, config: { cpuMillis, memoryMb, storageMb } }) => ({ id, cpuMillis, memoryMb, storageMb }));
  }
  nodeStatus(id: string) {
    const entry = this.entries.get(id);
    return { online: entry ? this.online(entry) : false, host: entry?.host ?? null };
  }
  runtimeForNode(id: string): RuntimeManager {
    const entry = this.entries.get(id);
    if (!entry || !this.online(entry)) throw new RuntimeUnavailableError();
    return entry.runtime;
  }
  localNodeId() {
    return [...this.entries.values()].find((entry) => !entry.client)!.id;
  }
  close() {
    clearInterval(this.timer);
    for (const entry of this.entries.values()) entry.client?.close();
  }

  private async entry(instanceId: string) {
    const row = await this.prisma.instance.findUnique({ where: { id: instanceId }, select: { nodeId: true } });
    const entry = row && this.entries.get(row.nodeId);
    if (!entry || !this.online(entry)) throw new RuntimeUnavailableError();
    return entry;
  }
  async backup(instanceId: string, localDir?: string) {
    const row = await this.prisma.instance.findUnique({ where: { id: instanceId }, select: { nodeId: true } });
    const entry = row && this.entries.get(row.nodeId);
    if (!entry) throw new RuntimeUnavailableError();
    return entry.client ? entry.client.backup(instanceId) : readBackupMetadata(instanceId, localDir);
  }
  async ensure(spec: RuntimeSpec) { return (await this.entry(spec.instanceId)).runtime.ensure(spec); }
  async recreate(spec: RuntimeSpec) { return (await this.entry(spec.instanceId)).runtime.recreate(spec); }
  async assertVolumeQuota(...args: Parameters<RuntimeManager['assertVolumeQuota']>) { return (await this.entry(args[0])).runtime.assertVolumeQuota(...args); }
  async assertNetworkPolicy(...args: Parameters<RuntimeManager['assertNetworkPolicy']>) { return (await this.entry(args[0])).runtime.assertNetworkPolicy(...args); }
  async logs(...args: Parameters<RuntimeManager['logs']>) { return (await this.entry(args[0])).runtime.logs(...args); }
  async start(id: string) { return (await this.entry(id)).runtime.start(id); }
  async stop(...args: Parameters<RuntimeManager['stop']>) { return (await this.entry(args[0])).runtime.stop(...args); }
  async restart(id: string) { return (await this.entry(id)).runtime.restart(id); }
  async inspect(id: string) {
    const { runtime, client } = await this.entry(id);
    const result = await runtime.inspect(id);
    return client ? { ...result, hostPort: null } : result;
  }
  async checkHealth(...args: Parameters<RuntimeManager['checkHealth']>) { return (await this.entry(args[0])).runtime.checkHealth(...args); }
  async remove(...args: Parameters<RuntimeManager['remove']>) { return (await this.entry(args[0])).runtime.remove(...args); }
  async volumeUsage(): Promise<Map<string, number>> {
    const instances = await this.prisma.instance.findMany({
      where: { deletedAt: null }, select: { id: true, nodeId: true },
    });
    const owner = new Map(instances.map((i) => [i.id, i.nodeId]));
    const usage = new Map<string, number>();
    await Promise.all([...this.entries.values()].filter((entry) => this.online(entry)).map(async (entry) => {
      const sizes = await entry.runtime.volumeUsage().catch(() => new Map<string, number>());
      for (const [id, size] of sizes) if (owner.get(id) === entry.id) usage.set(id, size);
    }));
    return usage;
  }
}
