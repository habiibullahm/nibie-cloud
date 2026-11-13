import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { Reconciler } from '../../src/modules/instances/reconciler.js';
import type { Fetcher } from '../../src/modules/integrations/fetcher.js';
import { LogService } from '../../src/modules/integrations/log-service.js';
import { ProviderService } from '../../src/modules/integrations/provider-service.js';
import { purgeIntegrations } from '../../src/modules/integrations/purge.js';
import { createRuntimeConfigLoader } from '../../src/modules/integrations/runtime-env.js';
import { TelegramService } from '../../src/modules/integrations/telegram-service.js';
import { PrismaSecretStore } from '../../src/modules/secrets/secret-store.js';
import { NotFoundError } from '../../src/shared/errors.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { TEST_MASTER_KEY, cleanupDocker, docker, realRuntime, seed, silentLogger } from '../helpers/service-env.js';
import { ensureStubImage } from '../helpers/stub-image.js';
import { deriveApiKey } from '../../src/modules/runtime/api-key.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const IMAGE = 'hermes-stub:0.2.0';
const TOKEN = '123456789:AAHcanaryTOKENvalue0123456789abcdefg';
const KEY = 'sk-canary-provider-key-0123456789';
let s: Awaited<ReturnType<typeof seed>>;
let secrets: PrismaSecretStore;

const fetcher: Fetcher = async (url) => ({
  status: 200, headers: {},
  body: url.endsWith('/getMe') ? JSON.stringify({ ok: true, result: { id: 91, is_bot: true, username: 'purge_bot' } }) : '{"ok":true}',
});
const telegram = () => new TelegramService({ prisma, secrets, logger: silentLogger, fetcher });
const providers = () => new ProviderService({ prisma, secrets, logger: silentLogger, fetcher });
const purge = (tenantId: string, instanceId: string) => purgeIntegrations({ prisma, secrets }, tenantId, instanceId);
const service = (runtime: FakeRuntime, over: Record<string, unknown> = {}) =>
  new InstanceService({
    prisma, runtime, image: IMAGE, production: false, logger: silentLogger, masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off',
    pollIntervalMs: 10, healthTimeoutMs: 2000, purgeIntegrations: purge, ...over,
  });

async function configured(runtime: FakeRuntime) {
  const v = await service(runtime).provision({ tenantId: s.tenant.id, planId: s.plan.id, name: 'a', idempotencyKey: randomUUID() });
  await telegram().put(s.tenant.id, v.id, { token: TOKEN, allowedUserIds: ['1'] });
  await providers().put(s.tenant.id, v.id, { baseUrl: 'https://llm.example.com/v1', model: 'm', apiKey: KEY });
  return v;
}

describe('purge on delete', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seed(prisma);
    secrets = new PrismaSecretStore({ prisma, current: { version: 1, key: randomBytes(32) }, previous: null });
  });
  afterAll(() => prisma.$disconnect());

  it('deleting an instance removes its configuration rows and secret rows, with a value-free event', async () => {
    const runtime = new FakeRuntime();
    const v = await configured(runtime);
    expect(await prisma.secret.count()).toBe(2);
    await service(runtime).delete(s.tenant.id, v.id);
    expect(await prisma.secret.count()).toBe(0);
    expect(await prisma.telegramConnection.count()).toBe(0);
    expect(await prisma.providerConfig.count()).toBe(0);
    const events = await prisma.instanceEvent.findMany({ where: { instanceId: v.id } });
    expect(events.map((e) => e.type)).toContain('secrets.purged');
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  it('a failed runtime removal keeps the credentials of the instance that still exists', async () => {
    const runtime = new FakeRuntime();
    const v = await configured(runtime);
    runtime.remove = async () => { throw new Error('daemon down'); };
    await expect(service(runtime).delete(s.tenant.id, v.id)).rejects.toThrow();
    expect(await prisma.secret.count({ where: { revokedAt: null } })).toBe(2);
    expect(await prisma.telegramConnection.count()).toBe(1);
  });

  it('the stale-operation reaper that finishes a deletion purges as well', async () => {
    const runtime = new FakeRuntime();
    const v = await configured(runtime);
    await prisma.instance.update({ where: { id: v.id }, data: { status: 'DELETING', operationOwner: randomUUID(), leaseExpiresAt: new Date(Date.now() - 60_000) } });
    const rec = new Reconciler({ masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off', prisma, runtime, logger: silentLogger, purgeIntegrations: purge });
    expect(await rec.reapStale()).toBe(1);
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('DELETED');
    expect(await prisma.secret.count()).toBe(0);
  });

  it('purging twice is harmless', async () => {
    const runtime = new FakeRuntime();
    const v = await configured(runtime);
    await purge(s.tenant.id, v.id);
    await purge(s.tenant.id, v.id);
    expect(await prisma.secret.count()).toBe(0);
  });

  it('a revoked secret keeps no hint', async () => {
    const runtime = new FakeRuntime();
    const v = await configured(runtime);
    await telegram().put(s.tenant.id, v.id, { token: '123456789:BBHsecondTOKENvalue0123456789abcdefg', allowedUserIds: ['1'] });
    const revoked = await prisma.secret.findMany({ where: { revokedAt: { not: null } } });
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.keyHint).toBe('');
  });
});

describe('LogService', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seed(prisma);
    secrets = new PrismaSecretStore({ prisma, current: { version: 1, key: randomBytes(32) }, previous: null });
  });

  const logs = (runtime: FakeRuntime) => new LogService({ prisma, runtime, loader: createRuntimeConfigLoader({ prisma, secrets }), masterKey: TEST_MASTER_KEY });

  it('returns the tail with the instance own secrets, API key and token shapes scrubbed', async () => {
    const runtime = new FakeRuntime();
    const v = await configured(runtime);
    const apiKey = deriveApiKey(TEST_MASTER_KEY, v.id);
    runtime.logLines = ['boot ok', `using ${KEY}`, `bot ${TOKEN}`, `api ${apiKey}`, 'Bearer zzzzzzzzzzzzzzzzzzzz'];
    const out = await logs(runtime).tail(s.tenant.id, v.id, 100);
    const text = out.join('\n');
    for (const leak of [KEY, TOKEN, apiKey, 'zzzzzzzzzzzzzzzzzzzz']) expect(text).not.toContain(leak);
    expect(out[0]).toBe('boot ok');
  });

  it('caps the number of lines and passes a bounded tail to the runtime', async () => {
    const runtime = new FakeRuntime();
    const v = await configured(runtime);
    runtime.logLines = Array.from({ length: 900 }, (_, i) => `line ${i}`);
    const out = await logs(runtime).tail(s.tenant.id, v.id, 10_000);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(runtime.lastLogTail).toBeLessThanOrEqual(500);
    expect(out[out.length - 1]).toBe('line 899');
  });

  it("another tenant's instance is not found", async () => {
    const runtime = new FakeRuntime();
    const v = await configured(runtime);
    await expect(logs(runtime).tail(s.other.id, v.id, 10)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('an instance whose container is gone has no log lines', async () => {
    const runtime = new FakeRuntime();
    const v = await configured(runtime);
    runtime.vanish(v.id);
    runtime.logLines = [];
    expect(await logs(runtime).tail(s.tenant.id, v.id, 10)).toEqual([]);
  });
});

describe('DockerRuntimeManager.logs (real Docker)', () => {
  let image: string;
  beforeAll(async () => { image = await ensureStubImage(); });
  afterEach(cleanupDocker);

  /** A container named like a tenant one, whose output the test controls. */
  async function printing(script: string): Promise<string> {
    const id = randomUUID();
    const c = await docker.createContainer({
      name: `hermes-${id}`, Image: image, Entrypoint: ['sh', '-c'], Cmd: [script],
      Labels: { 'hermes.cloud/managed': 'true', 'hermes.cloud/instance-id': id },
    });
    await c.start();
    await c.wait();
    return id;
  }

  it('returns stdout and stderr lines, oldest first, limited to the tail', async () => {
    const id = await printing('for i in 1 2 3 4 5; do echo "line $i"; done; echo "oops" >&2');
    const all = await realRuntime().logs(id, { tail: 100 });
    expect(all).toHaveLength(6);
    expect(all[0]).toContain('line 1');
    expect(all[5]).toContain('oops');
    const last2 = await realRuntime().logs(id, { tail: 2 });
    expect(last2).toHaveLength(2);
    expect(last2[0]).toContain('line 5');
  });

  it('an unknown instance has no lines', async () => {
    expect(await realRuntime().logs(randomUUID(), { tail: 10 })).toEqual([]);
  });

  it('clamps an absurd tail request instead of reading everything', async () => {
    const id = await printing('i=0; while [ $i -lt 700 ]; do echo "n $i"; i=$((i+1)); done');
    const lines = await realRuntime().logs(id, { tail: 1_000_000 });
    expect(lines.length).toBe(500);
    expect(lines[499]).toContain('n 699');
  });
});
