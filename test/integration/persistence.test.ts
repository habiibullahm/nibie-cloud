import { randomUUID } from 'node:crypto';
import Docker from 'dockerode';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DockerRuntimeManager } from '../../src/modules/runtime/docker-runtime-manager.js';
import type { RuntimeSpec } from '../../src/modules/runtime/types.js';
import { createLogger } from '../../src/shared/logger.js';
import { execIn } from '../helpers/exec.js';
import { ensureStubImage } from '../helpers/stub-image.js';

const docker = new Docker();
const manager = new DockerRuntimeManager({ docker, logger: createLogger({ level: 'silent' }) });
let image: string;
const ids: string[] = [];

async function boots(id: string): Promise<number> {
  const i = await manager.inspect(id);
  const res = await fetch(`http://127.0.0.1:${i.hostPort}/state`);
  return ((await res.json()) as { boots: number }).boots;
}

describe('persistence', () => {
  beforeAll(async () => {
    image = await ensureStubImage();
  });
  afterEach(async () => {
    for (const id of ids.splice(0)) await manager.remove(id, { deleteVolume: true });
  });

  it('keeps /data across container removal and recreation, and wipes it on volume delete', async () => {
    const spec: RuntimeSpec = {
      instanceId: randomUUID(),
      tenantId: randomUUID(),
      image,
      limits: { cpuMillis: 500, memoryMb: 256, pids: 128 },
      env: {},
    };
    ids.push(spec.instanceId);

    await manager.ensure(spec);
    await manager.start(spec.instanceId);
    expect(await boots(spec.instanceId)).toBe(1);
    await execIn(docker, spec.instanceId, ['sh', '-c', 'echo persisted > /data/marker']);

    await manager.remove(spec.instanceId, { deleteVolume: false });
    expect((await manager.inspect(spec.instanceId)).state).toBe('absent');

    await manager.ensure(spec);
    await manager.start(spec.instanceId);
    expect(await boots(spec.instanceId)).toBe(2);
    const r = await execIn(docker, spec.instanceId, ['cat', '/data/marker']);
    expect(r.out.trim()).toBe('persisted');

    await manager.remove(spec.instanceId, { deleteVolume: true });
    await manager.ensure(spec);
    await manager.start(spec.instanceId);
    expect(await boots(spec.instanceId)).toBe(1);
    expect((await execIn(docker, spec.instanceId, ['cat', '/data/marker'])).code).not.toBe(0);
  });
});
