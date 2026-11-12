import { randomUUID } from 'node:crypto';
import Docker from 'dockerode';
import type { PrismaClient } from '@prisma/client';
import { deriveApiKey } from '../../src/modules/runtime/api-key.js';
import { DockerRuntimeManager } from '../../src/modules/runtime/docker-runtime-manager.js';
import type { RuntimeManager } from '../../src/modules/runtime/types.js';
import { createLogger } from '../../src/shared/logger.js';

export const docker = new Docker();
export const silentLogger = createLogger({ level: 'silent' });
export const realRuntime = () => new DockerRuntimeManager({ docker, logger: silentLogger });

export const TEST_MASTER_KEY = 'test-master-key-'.padEnd(32, 'x');

/** Authorization header for an instance created by a service/reconciler using TEST_MASTER_KEY. */
export const authFor = (instanceId: string): { Authorization: string } => ({
  Authorization: `Bearer ${deriveApiKey(TEST_MASTER_KEY, instanceId)}`,
});

export const TEST_PLAN = { slug: 'test-small', name: 'Test small', cpuMillis: 500, memoryMb: 256, pids: 128, storageMb: 1024 };

export async function seed(prisma: PrismaClient) {
  const tenant = await prisma.tenant.create({ data: { name: 'tenant-a' } });
  const other = await prisma.tenant.create({ data: { name: 'tenant-b' } });
  const plan = await prisma.plan.create({ data: TEST_PLAN });
  const node = await prisma.runtimeNode.create({ data: { name: 'local', region: 'local' } });
  return { tenant, other, plan, node };
}

/** Delegating runtime whose methods can be overridden per test. */
export function wrapRuntime(inner: RuntimeManager, overrides: Partial<RuntimeManager>): RuntimeManager {
  return {
    ensure: (s) => inner.ensure(s),
    start: (i) => inner.start(i),
    stop: (i, t) => inner.stop(i, t),
    restart: (i) => inner.restart(i),
    inspect: (i) => inner.inspect(i),
    checkHealth: (i, k) => inner.checkHealth(i, k),
    remove: (i, o) => inner.remove(i, o),
    volumeUsage: () => inner.volumeUsage(),
    assertVolumeQuota: (i, m) => inner.assertVolumeQuota(i, m),
    assertNetworkPolicy: (i, m) => inner.assertNetworkPolicy(i, m),
    ...overrides,
  };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 250));
  }
}

export const key = () => randomUUID();

export async function containersFor(instanceId: string) {
  return docker.listContainers({ all: true, filters: { label: [`hermes.cloud/instance-id=${instanceId}`] } });
}

export async function cleanupDocker() {
  const cs = await docker.listContainers({ all: true, filters: { label: ['hermes.cloud/managed=true'] } });
  for (const c of cs) await docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
  const nets = await docker.listNetworks({ filters: { name: ['hermes-net-'] } });
  for (const n of nets) await docker.getNetwork(n.Id).remove().catch(() => {});
  const vols = await docker.listVolumes({ filters: { name: ['hermes-data-'] } });
  for (const v of vols.Volumes ?? []) await docker.getVolume(v.Name).remove().catch(() => {});
}
