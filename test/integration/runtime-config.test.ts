import { randomUUID } from 'node:crypto';
import Docker from 'dockerode';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DockerRuntimeManager } from '../../src/modules/runtime/docker-runtime-manager.js';
import { ConfigUnreadableError } from '../../src/modules/runtime/hermes-config.js';
import { buildTar, readFirstFile } from '../../src/modules/runtime/tar.js';
import type { RuntimeSpec } from '../../src/modules/runtime/types.js';
import { createLogger } from '../../src/shared/logger.js';
import { ensureStubImage } from '../helpers/stub-image.js';

const docker = new Docker();
const manager = new DockerRuntimeManager({ docker, logger: createLogger({ level: 'silent' }) });
const created: string[] = [];
let image: string;
const MODEL = { default: 'gpt-x', baseUrl: 'https://llm.example.com/v1', keyEnv: 'HERMES_PROVIDER_API_KEY' };

const newSpec = (over: Partial<RuntimeSpec> = {}): RuntimeSpec => {
  const instanceId = randomUUID();
  created.push(instanceId);
  return {
    instanceId, tenantId: randomUUID(), image, limits: { cpuMillis: 500, memoryMb: 256, pids: 128, storageMb: 1024 },
    diskQuota: 'off', egressPolicy: 'off', env: { HERMES_INSTANCE_ID: instanceId },
    apiServerKey: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), ...over,
  };
};
const container = (id: string) => docker.getContainer(`hermes-${id}`);
async function readFile(id: string, name: string): Promise<{ text: string | null; uid: number }> {
  try {
    const stream = await container(id).getArchive({ path: `/opt/data/${name}` });
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    const tar = Buffer.concat(chunks);
    return { text: readFirstFile(tar), uid: parseInt(tar.subarray(108, 116).toString('latin1').replace(/\0.*$/, '').trim(), 8) };
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode === 404) return { text: null, uid: -1 };
    throw e;
  }
}
const envOf = async (id: string) => (await container(id).inspect()).Config.Env ?? [];

describe('runtime config delivery', () => {
  beforeAll(async () => { image = await ensureStubImage(); });
  afterEach(async () => { for (const id of created.splice(0)) await manager.remove(id, { deleteVolume: true }); });
  afterAll(async () => { for (const id of created.splice(0)) await manager.remove(id, { deleteVolume: true }); });

  it('ensure seeds a managed model block into the volume of a new container, owned by the hermes user', async () => {
    const s = newSpec({ modelConfig: MODEL });
    await manager.ensure(s);
    const f = await readFile(s.instanceId, 'config.yaml');
    expect(parse(f.text!)).toEqual({ model: { default: 'gpt-x', provider: 'custom', base_url: MODEL.baseUrl, key_env: 'HERMES_PROVIDER_API_KEY' } });
    expect(f.uid).toBe(10000);
  });

  it('ensure without modelConfig writes no config file', async () => {
    const s = newSpec();
    await manager.ensure(s);
    expect((await readFile(s.instanceId, 'config.yaml')).text).toBeNull();
  });

  it('ensure on an existing container leaves its configuration alone (idempotent)', async () => {
    const s = newSpec({ modelConfig: MODEL });
    await manager.ensure(s);
    await manager.ensure({ ...s, modelConfig: { ...MODEL, default: 'other' } });
    expect(parse((await readFile(s.instanceId, 'config.yaml')).text!).model.default).toBe('gpt-x');
  });

  it('recreate replaces the container with new environment and keeps the volume contents', async () => {
    const s = newSpec({ env: { HERMES_INSTANCE_ID: 'x', TELEGRAM_BOT_TOKEN: 'old-token-canary' } });
    await manager.ensure(s);
    await container(s.instanceId).putArchive(buildTar('marker.txt', 'survives', { uid: 10000, gid: 10000, mode: 0o644 }), { path: '/opt/data' });
    await manager.start(s.instanceId);
    const oldId = (await container(s.instanceId).inspect()).Id;

    await manager.recreate({ ...s, env: { HERMES_INSTANCE_ID: 'x', TELEGRAM_BOT_TOKEN: 'new-token-canary' }, modelConfig: MODEL });

    const info = await container(s.instanceId).inspect();
    expect(info.Id).not.toBe(oldId);
    expect(info.State.Running).toBe(false); // recreate does not start; the caller does
    const env = await envOf(s.instanceId);
    expect(env).toContain('TELEGRAM_BOT_TOKEN=new-token-canary');
    expect(env.join('\n')).not.toContain('old-token-canary');
    expect((await readFile(s.instanceId, 'marker.txt')).text).toBe('survives');
    expect(parse((await readFile(s.instanceId, 'config.yaml')).text!).model.default).toBe('gpt-x');
  });

  it('recreate with modelConfig null removes a block the platform wrote and nothing else', async () => {
    const s = newSpec({ modelConfig: MODEL });
    await manager.ensure(s);
    await manager.recreate({ ...s, modelConfig: null });
    expect(parse((await readFile(s.instanceId, 'config.yaml')).text!)).toEqual({});
  });

  it('recreate with modelConfig undefined does not touch the file', async () => {
    const s = newSpec({ modelConfig: MODEL });
    await manager.ensure(s);
    const { modelConfig: _omit, ...rest } = s;
    await manager.recreate(rest);
    expect(parse((await readFile(s.instanceId, 'config.yaml')).text!).model.default).toBe('gpt-x');
  });

  it('an unreadable config.yaml fails the recreate and leaves no half-configured container behind', async () => {
    const s = newSpec();
    await manager.ensure(s);
    await container(s.instanceId).putArchive(buildTar('config.yaml', 'model: [unclosed\n  : :', { uid: 10000, gid: 10000, mode: 0o644 }), { path: '/opt/data' });
    await expect(manager.recreate({ ...s, modelConfig: MODEL })).rejects.toBeInstanceOf(ConfigUnreadableError);
    expect((await manager.inspect(s.instanceId)).state).toBe('absent');
    // A second attempt must not find an unseeded container and silently start it.
    await expect(manager.ensure({ ...s, modelConfig: MODEL })).rejects.toBeInstanceOf(ConfigUnreadableError);
  });

  it('a config.yaml far larger than the cap is refused without being read into memory', async () => {
    const s = newSpec();
    await manager.ensure(s);
    const huge = '# ' + 'x'.repeat(1024 * 1024) + '\nmodel: {}\n';
    await container(s.instanceId).putArchive(buildTar('config.yaml', huge, { uid: 10000, gid: 10000, mode: 0o644 }), { path: '/opt/data' });
    await expect(manager.recreate({ ...s, modelConfig: MODEL })).rejects.toBeInstanceOf(ConfigUnreadableError);
    expect((await manager.inspect(s.instanceId)).state).toBe('absent');
  });
});
