import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createPrisma } from '../../src/db/client.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { Reconciler } from '../../src/modules/instances/reconciler.js';
import type { Fetcher } from '../../src/modules/integrations/fetcher.js';
import { ProviderService } from '../../src/modules/integrations/provider-service.js';
import { createRuntimeConfigLoader } from '../../src/modules/integrations/runtime-env.js';
import { TelegramService } from '../../src/modules/integrations/telegram-service.js';
import { ConfigUnreadableError } from '../../src/modules/runtime/hermes-config.js';
import { PrismaSecretStore } from '../../src/modules/secrets/secret-store.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { TEST_MASTER_KEY, cleanupDocker, docker, realRuntime, seed, silentLogger } from '../helpers/service-env.js';
import { ensureStubImage } from '../helpers/stub-image.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const IMAGE = 'hermes-stub:0.2.0';
const TOKEN = '123456789:AAHcanaryTOKENvalue0123456789abcdefg';
const TOKEN2 = '123456789:BBHsecondTOKENvalue0123456789abcdefg';
const KEY = 'sk-canary-provider-key-0123456789';
let s: Awaited<ReturnType<typeof seed>>;
let secrets: PrismaSecretStore;

const fetcher: Fetcher = async (url) => ({
  status: 200, headers: {},
  body: url.endsWith('/getMe') ? JSON.stringify({ ok: true, result: { id: 77, is_bot: true, username: 'apply_bot' } }) : '{"ok":true}',
});
const telegram = () => new TelegramService({ prisma, secrets, logger: silentLogger, fetcher });
const providers = () => new ProviderService({ prisma, secrets, logger: silentLogger, fetcher });
const loader = () => createRuntimeConfigLoader({ prisma, secrets });
const row = (id: string) => prisma.instance.findUniqueOrThrow({ where: { id } });

function services(runtime: FakeRuntime, image = IMAGE) {
  const service = new InstanceService({
    prisma, runtime, image, production: false, logger: silentLogger, masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off',
    pollIntervalMs: 10, healthTimeoutMs: 2000, runtimeConfig: loader(),
  });
  return service;
}

describe('applying configuration on restart (fake runtime)', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seed(prisma);
    secrets = new PrismaSecretStore({ prisma, current: { version: 1, key: randomBytes(32) }, previous: null });
  });
  afterAll(() => prisma.$disconnect());

  async function active(runtime: FakeRuntime) {
    const v = await services(runtime).provision({ tenantId: s.tenant.id, planId: s.plan.id, name: 'a', idempotencyKey: randomUUID() });
    expect(v.status).toBe('ACTIVE');
    return v;
  }

  it('provision passes the loaded environment and records the applied revision', async () => {
    const runtime = new FakeRuntime();
    const v = await active(runtime);
    expect(runtime.ensured[0]?.env).toEqual({ HERMES_INSTANCE_ID: v.id });
    expect(runtime.ensured[0]?.modelConfig).toBeNull();
    expect((await row(v.id)).appliedRevision).toBe(0);
  });

  it('a restart after a config change recreates the container with the new environment and model block', async () => {
    const runtime = new FakeRuntime();
    const v = await active(runtime);
    await telegram().put(s.tenant.id, v.id, { token: TOKEN, allowedUserIds: ['111', '222'] });
    await providers().put(s.tenant.id, v.id, { baseUrl: 'https://llm.example.com/v1', model: 'm-1', apiKey: KEY });
    expect((await row(v.id)).configRevision).toBe(2);

    await services(runtime).restart(s.tenant.id, v.id);

    expect(runtime.recreated).toHaveLength(1);
    const spec = runtime.recreated[0]!;
    expect(spec.env).toMatchObject({ HERMES_INSTANCE_ID: v.id, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USERS: '111,222', HERMES_PROVIDER_API_KEY: KEY });
    expect(spec.modelConfig).toEqual({ default: 'm-1', baseUrl: 'https://llm.example.com/v1', keyEnv: 'HERMES_PROVIDER_API_KEY' });
    const r = await row(v.id);
    expect(r.status).toBe('ACTIVE');
    expect(r.appliedRevision).toBe(2);
    expect(runtime.restarts).toBe(0);
  });

  it('a provisioning retry after a failure recreates the container when the configuration changed in between', async () => {
    class FailingStart extends FakeRuntime {
      failNext = true;
      override async start(id: string): Promise<void> {
        if (this.failNext) { this.failNext = false; throw new Error('boom'); }
        return super.start(id);
      }
    }
    const runtime = new FailingStart();
    const key = randomUUID();
    const input = { tenantId: s.tenant.id, planId: s.plan.id, name: 'a', idempotencyKey: key };
    const first = await services(runtime).provision(input).catch(() => null);
    const inst = await prisma.instance.findFirstOrThrow({ where: { tenantId: s.tenant.id } });
    expect(first?.status ?? inst.status).toBe('FAILED');
    await telegram().put(s.tenant.id, inst.id, { token: TOKEN, allowedUserIds: ['1'] });

    const second = await services(runtime).provision(input);

    expect(second.status).toBe('ACTIVE');
    expect(runtime.recreated).toHaveLength(1);
    expect(runtime.recreated[0]?.env).toMatchObject({ TELEGRAM_BOT_TOKEN: TOKEN });
    expect((await row(inst.id)).appliedRevision).toBe(1);
  });

  it('a restart with nothing to apply is a plain restart', async () => {
    const runtime = new FakeRuntime();
    const v = await active(runtime);
    await telegram().put(s.tenant.id, v.id, { token: TOKEN, allowedUserIds: ['1'] });
    await services(runtime).restart(s.tenant.id, v.id);
    await services(runtime).restart(s.tenant.id, v.id);
    expect(runtime.recreated).toHaveLength(1);
    expect(runtime.restarts).toBe(1);
  });

  it('start of a stopped instance also picks up the new configuration', async () => {
    const runtime = new FakeRuntime();
    const v = await active(runtime);
    await services(runtime).stop(s.tenant.id, v.id);
    await telegram().put(s.tenant.id, v.id, { token: TOKEN, allowedUserIds: ['1'] });
    await services(runtime).start(s.tenant.id, v.id);
    expect(runtime.recreated).toHaveLength(1);
    expect(runtime.recreated[0]?.env.TELEGRAM_BOT_TOKEN).toBe(TOKEN);
  });

  it('removing the provider recreates with modelConfig null so the platform block is removed', async () => {
    const runtime = new FakeRuntime();
    const v = await active(runtime);
    const p = await providers().put(s.tenant.id, v.id, { baseUrl: 'https://llm.example.com/v1', model: 'm', apiKey: KEY });
    await services(runtime).restart(s.tenant.id, v.id);
    await providers().remove(s.tenant.id, v.id, p.id);
    await services(runtime).restart(s.tenant.id, v.id);
    expect(runtime.recreated).toHaveLength(2);
    expect(runtime.recreated[1]?.modelConfig).toBeNull();
    expect(runtime.recreated[1]?.env.HERMES_PROVIDER_API_KEY).toBeUndefined();
  });

  it('a revoked token never comes back: replacing the token and restarting uses only the new one', async () => {
    const runtime = new FakeRuntime();
    const v = await active(runtime);
    await telegram().put(s.tenant.id, v.id, { token: TOKEN, allowedUserIds: ['1'] });
    await telegram().put(s.tenant.id, v.id, { token: TOKEN2, allowedUserIds: ['1'] });
    await services(runtime).restart(s.tenant.id, v.id);
    expect(runtime.recreated[0]?.env.TELEGRAM_BOT_TOKEN).toBe(TOKEN2);
  });

  it('a failed recreate (unreadable config file) refuses the restart, restores the state and keeps the gap', async () => {
    const runtime = new FakeRuntime();
    const v = await active(runtime);
    await telegram().put(s.tenant.id, v.id, { token: TOKEN, allowedUserIds: ['1'] });
    runtime.recreate = async () => { throw new ConfigUnreadableError(); };
    await expect(services(runtime).restart(s.tenant.id, v.id)).rejects.toBeInstanceOf(ConfigUnreadableError);
    const r = await row(v.id);
    expect(r.status).toBe('ACTIVE');
    expect(r.appliedRevision).toBe(0);
    expect(r.configRevision).toBe(1);
  });

  const reconciler = (runtime: FakeRuntime) =>
    new Reconciler({ masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off', prisma, runtime, logger: silentLogger, runtimeConfig: loader(), pollIntervalMs: 10, healthTimeoutMs: 500 });

  it('the reconciler recreates (not just starts) a stopped container that has a pending config change', async () => {
    const runtime = new FakeRuntime();
    const v = await active(runtime);
    await telegram().put(s.tenant.id, v.id, { token: TOKEN, allowedUserIds: ['1'] });
    await runtime.stop(v.id); // crashed container
    expect(await reconciler(runtime).reconcileInstance(v.id)).toBe('recovered');
    expect(runtime.recreated).toHaveLength(1);
    expect(runtime.recreated[0]?.env.TELEGRAM_BOT_TOKEN).toBe(TOKEN);
    expect((await row(v.id)).appliedRevision).toBe(1);
  });

  it('the reconciler re-creating a vanished container with an applied config uses the stored configuration', async () => {
    const runtime = new FakeRuntime();
    const v = await active(runtime);
    await providers().put(s.tenant.id, v.id, { baseUrl: 'https://llm.example.com/v1', model: 'm', apiKey: KEY });
    await services(runtime).restart(s.tenant.id, v.id); // applies revision 1
    runtime.recreated.length = 0;
    runtime.vanish(v.id);
    expect(await reconciler(runtime).reconcileInstance(v.id)).toBe('recovered');
    const last = runtime.ensured[runtime.ensured.length - 1]!;
    expect(last.env.HERMES_PROVIDER_API_KEY).toBe(KEY);
    expect(last.modelConfig).toMatchObject({ default: 'm' });
    expect(runtime.recreated).toHaveLength(0);
  });
});

describe('applying configuration on restart (real Docker, stub image)', () => {
  let image: string;
  beforeAll(async () => { image = await ensureStubImage(); });
  beforeEach(async () => {
    await cleanupDocker();
    await resetDb(prisma);
    s = await seed(prisma);
    secrets = new PrismaSecretStore({ prisma, current: { version: 1, key: randomBytes(32) }, previous: null });
  });
  afterEach(cleanupDocker);

  it('a restart after configuring Telegram and a provider reaches the new container and keeps the data', async () => {
    const runtime = realRuntime();
    const service = new InstanceService({
      prisma, runtime, image, production: false, logger: silentLogger, masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off',
      pollIntervalMs: 200, healthTimeoutMs: 20_000, runtimeConfig: loader(),
    });
    const v = await service.provision({ tenantId: s.tenant.id, planId: s.plan.id, name: 'a', idempotencyKey: randomUUID() });
    expect(v.status).toBe('ACTIVE');
    await telegram().put(s.tenant.id, v.id, { token: TOKEN, allowedUserIds: ['111'] });
    await providers().put(s.tenant.id, v.id, { baseUrl: 'https://llm.example.com/v1', model: 'm-1', apiKey: KEY });

    const after = await service.restart(s.tenant.id, v.id);
    expect(after.status).toBe('ACTIVE');
    const info = await docker.getContainer(`hermes-${v.id}`).inspect();
    expect(info.Config.Env).toEqual(expect.arrayContaining([`TELEGRAM_BOT_TOKEN=${TOKEN}`, 'TELEGRAM_ALLOWED_USERS=111', `HERMES_PROVIDER_API_KEY=${KEY}`]));
    const stream = await docker.getContainer(`hermes-${v.id}`).getArchive({ path: '/opt/data/config.yaml' });
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).subarray(512, 2048).toString('utf8');
    expect(parse(text.replace(/\0+$/, '')).model).toMatchObject({ default: 'm-1', provider: 'custom', key_env: 'HERMES_PROVIDER_API_KEY' });
    expect((await row(v.id)).appliedRevision).toBe(2);
  });
});
