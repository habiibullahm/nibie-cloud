import { randomUUID } from 'node:crypto';
import Docker from 'dockerode';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DockerRuntimeManager } from '../../src/modules/runtime/docker-runtime-manager.js';
import type { RuntimeSpec } from '../../src/modules/runtime/types.js';
import { RuntimeUnavailableError } from '../../src/shared/errors.js';
import { createLogger } from '../../src/shared/logger.js';
import { ensureStubImage } from '../helpers/stub-image.js';

const docker = new Docker();
const logger = createLogger({ level: 'silent' });
const manager = new DockerRuntimeManager({ docker, logger });
const created: string[] = [];
let image: string;

const newSpec = (): RuntimeSpec => {
  const instanceId = randomUUID();
  created.push(instanceId);
  return {
    instanceId,
    tenantId: randomUUID(),
    image,
    limits: { cpuMillis: 500, memoryMb: 256, pids: 128 },
    env: {},
  };
};

const labelled = (id: string) => ({ label: [`hermes.cloud/instance-id=${id}`] });

describe('DockerRuntimeManager', () => {
  beforeAll(async () => {
    image = await ensureStubImage();
  });
  afterEach(async () => {
    for (const id of created.splice(0)) await manager.remove(id, { deleteVolume: true });
  });
  afterAll(async () => {
    for (const id of created.splice(0)) await manager.remove(id, { deleteVolume: true });
  });

  it('ensure creates volume, network and an unstarted container', async () => {
    const s = newSpec();
    await manager.ensure(s);
    const i = await manager.inspect(s.instanceId);
    expect(i.state).toBe('created');
    expect(i.volumePresent).toBe(true);
  });

  it('ensure is idempotent: one container, one volume, one network', async () => {
    const s = newSpec();
    await manager.ensure(s);
    await manager.ensure(s);
    const containers = await docker.listContainers({ all: true, filters: labelled(s.instanceId) });
    const volumes = await docker.listVolumes({ filters: { name: [`hermes-data-${s.instanceId}`] } });
    const networks = await docker.listNetworks({ filters: { name: [`hermes-net-${s.instanceId}`] } });
    expect(containers).toHaveLength(1);
    expect(volumes.Volumes).toHaveLength(1);
    expect(networks).toHaveLength(1);
  });

  it('start makes it running with a loopback host port and passing health check', async () => {
    const s = newSpec();
    await manager.ensure(s);
    await manager.start(s.instanceId);
    const i = await manager.inspect(s.instanceId);
    expect(i.state).toBe('running');
    expect(i.hostPort).toBeGreaterThanOrEqual(1024);
    expect(i.hostPort).toBeLessThanOrEqual(65535);
    const h = await manager.checkHealth(s.instanceId);
    expect(h.ok).toBe(true);
    const info = await docker.getContainer(`hermes-${s.instanceId}`).inspect();
    expect(info.NetworkSettings.Ports['8080/tcp']![0]!.HostIp).toBe('127.0.0.1');
  });

  it('stop then start works and stop is idempotent', async () => {
    const s = newSpec();
    await manager.ensure(s);
    await manager.start(s.instanceId);
    await manager.stop(s.instanceId, 2);
    expect((await manager.inspect(s.instanceId)).state).toBe('exited');
    await manager.stop(s.instanceId, 2);
    await manager.start(s.instanceId);
    expect((await manager.inspect(s.instanceId)).state).toBe('running');
  });

  it('restart produces a newer startedAt', async () => {
    const s = newSpec();
    await manager.ensure(s);
    await manager.start(s.instanceId);
    const before = (await manager.inspect(s.instanceId)).startedAt!;
    await new Promise((r) => setTimeout(r, 1100));
    await manager.restart(s.instanceId);
    const after = (await manager.inspect(s.instanceId)).startedAt!;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('remove on an absent instance is a no-op and inspect reports absent', async () => {
    const id = randomUUID();
    await expect(manager.remove(id, { deleteVolume: true })).resolves.toBeUndefined();
    const i = await manager.inspect(id);
    expect(i.state).toBe('absent');
    expect(i.volumePresent).toBe(false);
  });

  it('checkHealth reports not ok (without throwing) when stopped', async () => {
    const s = newSpec();
    await manager.ensure(s);
    const h = await manager.checkHealth(s.instanceId);
    expect(h.ok).toBe(false);
    expect(h.detail.length).toBeGreaterThan(0);
  });

  it('remove keeps the volume unless deleteVolume is true', async () => {
    const s = newSpec();
    await manager.ensure(s);
    await manager.remove(s.instanceId, { deleteVolume: false });
    const i = await manager.inspect(s.instanceId);
    expect(i.state).toBe('absent');
    expect(i.volumePresent).toBe(true);
    await manager.remove(s.instanceId, { deleteVolume: true });
    expect((await manager.inspect(s.instanceId)).volumePresent).toBe(false);
  });

  it('maps an unreachable Docker daemon to RuntimeUnavailableError', async () => {
    const dead = new DockerRuntimeManager({ docker: new Docker({ socketPath: '/nonexistent.sock' }), logger });
    await expect(dead.inspect(randomUUID())).rejects.toBeInstanceOf(RuntimeUnavailableError);
    await expect(dead.ensure(newSpec())).rejects.toBeInstanceOf(RuntimeUnavailableError);
  });
});
