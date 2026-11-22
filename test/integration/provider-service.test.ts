import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { ProviderService, NIBIEROUTER_BASE_URL } from '../../src/modules/integrations/provider-service.js';
import type { Fetcher } from '../../src/modules/integrations/fetcher.js';
import { createRuntimeConfigLoader } from '../../src/modules/integrations/runtime-env.js';
import { PrismaSecretStore } from '../../src/modules/secrets/secret-store.js';
import { NotFoundError, OutboundBlockedError, OutboundFailedError, ValidationError } from '../../src/shared/errors.js';
import { createLogger } from '../../src/shared/logger.js';
import { resetDb } from '../helpers/db.js';
import { seed } from '../helpers/service-env.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const KEY = 'sk-canary-provider-key-0123456789';
const KEY2 = 'sk-canary-second-key-9876543210';
const BASE = 'https://llm.example.com/v1';

interface Call { url: string; auth: string | undefined; maxBytes: number | undefined }
let calls: Call[];
let lines: string[];
let respond: (url: string) => Promise<{ status: number; headers: Record<string, string>; body: string }>;
let s: Awaited<ReturnType<typeof seed>>;
let svc: ProviderService;
let secrets: PrismaSecretStore;

const fetcher: Fetcher = async (url, opts) => {
  calls.push({ url, auth: opts.headers?.authorization, maxBytes: opts.maxBytes });
  return respond(url);
};
const ok = async () => ({ status: 200, headers: {}, body: JSON.stringify({ data: [{ id: 'm' }], secretEcho: 'UPSTREAM-BODY-CANARY' }) });
const mkInstance = (tenantId: string) =>
  prisma.instance.create({ data: { tenantId, planId: s.plan.id, nodeId: s.node.id, name: 'x', idempotencyKey: crypto.randomUUID(), image: 'hermes-stub:0.2.0', status: 'ACTIVE' } });

describe('ProviderService', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seed(prisma);
    calls = [];
    lines = [];
    respond = ok;
    secrets = new PrismaSecretStore({ prisma, current: { version: 1, key: randomBytes(32) }, previous: null });
    const stream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
    svc = new ProviderService({ prisma, secrets, logger: createLogger({ level: 'trace', stream }), fetcher });
  });
  afterAll(() => prisma.$disconnect());

  it('put stores BYOK config with an encrypted key, UNTESTED status, a hint and a bumped revision', async () => {
    const inst = await mkInstance(s.tenant.id);
    const v = await svc.put(s.tenant.id, inst.id, { baseUrl: `${BASE}/`, model: 'gpt-x', apiKey: KEY });
    expect(v).toMatchObject({ kind: 'BYOK', baseUrl: BASE, model: 'gpt-x', status: 'UNTESTED', keyHint: KEY.slice(-4), restartRequired: true });
    expect(JSON.stringify(v)).not.toContain(KEY);
    expect(JSON.stringify(await prisma.secret.findMany())).not.toContain(KEY);
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: inst.id } })).configRevision).toBe(1);
    expect(calls).toHaveLength(0); // storing never calls the provider
  });

  it.each([
    ['http scheme', 'http://llm.example.com/v1'],
    ['userinfo', 'https://u:p@llm.example.com/v1'],
    ['query string', 'https://llm.example.com/v1?x=1'],
    ['fragment', 'https://llm.example.com/v1#x'],
    ['loopback literal', 'https://127.0.0.1/v1'],
    ['metadata literal', 'https://169.254.169.254/v1'],
    ['private literal', 'https://10.0.0.5/v1'],
    ['ipv6 loopback', 'https://[::1]/v1'],
    ['decimal loopback', 'https://2130706433/v1'],
    ['not a url', 'llm.example.com'],
    ['too long', `https://llm.example.com/${'a'.repeat(300)}`],
    ['a non-standard port', 'https://llm.example.com:8443/v1'],
    ['a port of another service', 'https://llm.example.com:6379/v1'],
  ])('rejects a base URL with %s', async (_n, baseUrl) => {
    const inst = await mkInstance(s.tenant.id);
    await expect(svc.put(s.tenant.id, inst.id, { baseUrl, model: 'm', apiKey: KEY })).rejects.toThrow();
    expect(await prisma.providerConfig.count()).toBe(0);
    expect(await prisma.secret.count()).toBe(0);
  });

  it('rejects bad model names and bad keys', async () => {
    const inst = await mkInstance(s.tenant.id);
    for (const model of ['', 'a b', 'x'.repeat(200), 'm\nx']) {
      await expect(svc.put(s.tenant.id, inst.id, { baseUrl: BASE, model, apiKey: KEY })).rejects.toBeInstanceOf(ValidationError);
    }
    for (const apiKey of ['', 'short', 'has space in key 12345', 'k'.repeat(600), 'line\nbreak12345678']) {
      await expect(svc.put(s.tenant.id, inst.id, { baseUrl: BASE, model: 'm', apiKey })).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('test calls GET {baseUrl}/models with the key and records OK without storing the upstream body', async () => {
    const inst = await mkInstance(s.tenant.id);
    await svc.put(s.tenant.id, inst.id, { baseUrl: BASE, model: 'm', apiKey: KEY });
    const v = await svc.test(s.tenant.id, inst.id);
    expect(v).toMatchObject({ status: 'OK', lastErrorCode: null });
    expect(calls).toEqual([{ url: `${BASE}/models`, auth: `Bearer ${KEY}`, maxBytes: 4 * 1024 * 1024 }]);
    expect(JSON.stringify(v)).not.toContain('UPSTREAM-BODY-CANARY');
    expect(JSON.stringify(await prisma.providerConfig.findMany())).not.toContain('UPSTREAM-BODY-CANARY');
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'unexpected_status'],
    [500, 'unexpected_status'],
  ])('test maps upstream status %i to %s', async (status, code) => {
    const inst = await mkInstance(s.tenant.id);
    await svc.put(s.tenant.id, inst.id, { baseUrl: BASE, model: 'm', apiKey: KEY });
    respond = async () => ({ status, headers: {}, body: 'Upstream says: ' + KEY });
    const v = await svc.test(s.tenant.id, inst.id);
    expect(v).toMatchObject({ status: 'FAILED', lastErrorCode: code });
    expect(JSON.stringify(v)).not.toContain(KEY);
  });

  it('test maps transport problems to coarse codes and never touches the instance status', async () => {
    const inst = await mkInstance(s.tenant.id);
    await svc.put(s.tenant.id, inst.id, { baseUrl: BASE, model: 'm', apiKey: KEY });
    respond = async () => { throw new OutboundFailedError('timeout'); };
    expect(await svc.test(s.tenant.id, inst.id)).toMatchObject({ status: 'FAILED', lastErrorCode: 'timeout' });
    respond = async () => { throw new OutboundFailedError('unreachable'); };
    expect(await svc.test(s.tenant.id, inst.id)).toMatchObject({ status: 'FAILED', lastErrorCode: 'unreachable' });
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: inst.id } })).status).toBe('ACTIVE');
  });

  it('test of a blocked destination throws outbound_blocked and records blocked', async () => {
    const inst = await mkInstance(s.tenant.id);
    await svc.put(s.tenant.id, inst.id, { baseUrl: BASE, model: 'm', apiKey: KEY });
    respond = async () => { throw new OutboundBlockedError(); };
    await expect(svc.test(s.tenant.id, inst.id)).rejects.toBeInstanceOf(OutboundBlockedError);
    expect((await prisma.providerConfig.findFirstOrThrow()).lastErrorCode).toBe('blocked');
  });

  it('replacing the key revokes the old secret; there is still one config', async () => {
    const inst = await mkInstance(s.tenant.id);
    await svc.put(s.tenant.id, inst.id, { baseUrl: BASE, model: 'm', apiKey: KEY });
    const first = await prisma.providerConfig.findUniqueOrThrow({ where: { instanceId: inst.id } });
    await svc.put(s.tenant.id, inst.id, { baseUrl: BASE, model: 'm2', apiKey: KEY2 });
    const second = await prisma.providerConfig.findUniqueOrThrow({ where: { instanceId: inst.id } });
    expect(second.model).toBe('m2');
    expect((await prisma.secret.findUniqueOrThrow({ where: { id: first.secretId } })).revokedAt).not.toBeNull();
    expect(await secrets.get(s.tenant.id, second.secretId)).toBe(KEY2);
    expect(await prisma.providerConfig.count()).toBe(1);
  });

  it('list returns [] before configuration and one redacted entry after', async () => {
    const inst = await mkInstance(s.tenant.id);
    expect(await svc.list(s.tenant.id, inst.id)).toEqual([]);
    await svc.put(s.tenant.id, inst.id, { baseUrl: BASE, model: 'm', apiKey: KEY });
    const list = await svc.list(s.tenant.id, inst.id);
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(KEY);
  });

  it('remove revokes the secret, deletes the config and bumps the revision; a wrong id is not found', async () => {
    const inst = await mkInstance(s.tenant.id);
    const v = await svc.put(s.tenant.id, inst.id, { baseUrl: BASE, model: 'm', apiKey: KEY });
    await expect(svc.remove(s.tenant.id, inst.id, crypto.randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    const secretId = (await prisma.providerConfig.findUniqueOrThrow({ where: { instanceId: inst.id } })).secretId;
    expect((await svc.remove(s.tenant.id, inst.id, v.id)).restartRequired).toBe(true);
    expect(await prisma.providerConfig.count()).toBe(0);
    expect((await prisma.secret.findUniqueOrThrow({ where: { id: secretId } })).revokedAt).not.toBeNull();
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: inst.id } })).configRevision).toBe(2);
  });

  it("another tenant's instance is not found for every operation", async () => {
    const inst = await mkInstance(s.tenant.id);
    const v = await svc.put(s.tenant.id, inst.id, { baseUrl: BASE, model: 'm', apiKey: KEY });
    await expect(svc.list(s.other.id, inst.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.put(s.other.id, inst.id, { baseUrl: BASE, model: 'm', apiKey: KEY2 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.test(s.other.id, inst.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.remove(s.other.id, inst.id, v.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.attachNibieRouter(s.other.id, inst.id, { apiKey: KEY2, model: 'm' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('attachNibieRouter uses the fixed router URL, hides the key hint and replaces a BYOK config', async () => {
    const inst = await mkInstance(s.tenant.id);
    await svc.put(s.tenant.id, inst.id, { baseUrl: BASE, model: 'm', apiKey: KEY });
    const v = await svc.attachNibieRouter(s.tenant.id, inst.id, { apiKey: KEY2, model: 'nibie-default' });
    expect(v).toMatchObject({ kind: 'NIBIEROUTER', baseUrl: NIBIEROUTER_BASE_URL, model: 'nibie-default', keyHint: null });
    expect(JSON.stringify(v)).not.toContain(KEY2);
    expect(await prisma.providerConfig.count()).toBe(1);
    expect((await prisma.secret.findMany({ where: { revokedAt: null } })).length).toBe(1);
  });

  it('the key never appears in logs, events, errors or stored rows', async () => {
    const inst = await mkInstance(s.tenant.id);
    const errors: string[] = [];
    await svc.put(s.tenant.id, inst.id, { baseUrl: BASE, model: 'm', apiKey: KEY });
    respond = async () => ({ status: 401, headers: {}, body: `bad key ${KEY}` });
    await svc.test(s.tenant.id, inst.id);
    respond = async () => { throw new OutboundBlockedError(); };
    await svc.test(s.tenant.id, inst.id).catch((e: Error) => errors.push(`${e.message} ${JSON.stringify(e)}`));
    await svc.put(s.tenant.id, inst.id, { baseUrl: 'http://x', model: 'm', apiKey: KEY2 }).catch((e: Error) => errors.push(e.message));
    const everything = JSON.stringify({ lines, errors, events: await prisma.instanceEvent.findMany(), secrets: await prisma.secret.findMany(), cfg: await prisma.providerConfig.findMany() });
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain(KEY2);
  });

  describe('NibieRouter model choice', () => {
    const FREE = { id: 'nibierouter-free', name: 'Free', contextLength: null, promptUsdPerM: 0, completionUsdPerM: 0, free: true };
    const PAID = { id: 'paid-model', name: 'Paid', contextLength: 1000, promptUsdPerM: 0.3, completionUsdPerM: 2.16, free: false };
    let routerSvc: ProviderService;
    beforeEach(() => {
      routerSvc = new ProviderService({ prisma, secrets, logger: createLogger({ level: 'silent' }), fetcher, catalog: { list: async () => [FREE, PAID] } });
    });
    const routerInstance = async () => {
      const inst = await mkInstance(s.tenant.id);
      await routerSvc.attachNibieRouter(s.tenant.id, inst.id, { apiKey: KEY2, model: FREE.id });
      return inst;
    };
    const paidPlan = () => prisma.plan.update({ where: { id: s.plan.id }, data: { monthlyPriceIdr: 50_000 } });
    const revision = async (id: string) => (await prisma.instance.findUniqueOrThrow({ where: { id } })).configRevision;

    it('lists the free models only on a free plan without AI balance, and every model on a paid one or with AI balance', async () => {
      const inst = await routerInstance();
      expect(await routerSvc.models(s.tenant.id, inst.id)).toEqual({ freeOnly: true, models: [FREE] });
      const withBalance = new ProviderService({ prisma, secrets, logger: createLogger({ level: 'silent' }), fetcher, catalog: { list: async () => [FREE, PAID] }, hasAiBalance: async () => true });
      expect(await withBalance.models(s.tenant.id, inst.id)).toEqual({ freeOnly: false, models: [FREE, PAID] });
      expect(await withBalance.setModel(s.tenant.id, inst.id, PAID.id)).toMatchObject({ model: PAID.id, restartRequired: true });
      await paidPlan();
      expect(await routerSvc.models(s.tenant.id, inst.id)).toEqual({ freeOnly: false, models: [FREE, PAID] });
    });

    it('a free plan cannot choose a paid model, and nothing changes', async () => {
      const inst = await routerInstance();
      const before = await revision(inst.id);
      await expect(routerSvc.setModel(s.tenant.id, inst.id, PAID.id)).rejects.toThrow('free models');
      expect(await revision(inst.id)).toBe(before);
      expect((await prisma.providerConfig.findUniqueOrThrow({ where: { instanceId: inst.id } })).model).toBe(FREE.id);
    });

    it('refuses a model the router does not offer, and a malformed name', async () => {
      const inst = await routerInstance();
      await paidPlan();
      await expect(routerSvc.setModel(s.tenant.id, inst.id, 'gpt-unknown')).rejects.toBeInstanceOf(ValidationError);
      await expect(routerSvc.setModel(s.tenant.id, inst.id, 'bad model')).rejects.toBeInstanceOf(ValidationError);
    });

    it('a BYOK or unconfigured instance answers 409 not_nibierouter', async () => {
      const inst = await mkInstance(s.tenant.id);
      await expect(routerSvc.setModel(s.tenant.id, inst.id, FREE.id)).rejects.toMatchObject({ status: 409, code: 'not_nibierouter' });
      await routerSvc.put(s.tenant.id, inst.id, { baseUrl: BASE, model: 'm', apiKey: KEY });
      await expect(routerSvc.setModel(s.tenant.id, inst.id, FREE.id)).rejects.toMatchObject({ status: 409, code: 'not_nibierouter' });
    });

    it('saves the model, keeps the key, bumps the revision, and the next container start gets the new model', async () => {
      const inst = await routerInstance();
      await paidPlan();
      const secretBefore = (await prisma.providerConfig.findUniqueOrThrow({ where: { instanceId: inst.id } })).secretId;
      const before = await revision(inst.id);
      const v = await routerSvc.setModel(s.tenant.id, inst.id, PAID.id);
      expect(v).toMatchObject({ kind: 'NIBIEROUTER', model: PAID.id, restartRequired: true, keyHint: null });
      expect(await revision(inst.id)).toBe(before + 1);
      expect((await prisma.providerConfig.findUniqueOrThrow({ where: { instanceId: inst.id } })).secretId).toBe(secretBefore);
      const loaded = await createRuntimeConfigLoader({ prisma, secrets })(s.tenant.id, inst.id);
      expect(loaded.model).toMatchObject({ default: PAID.id, baseUrl: NIBIEROUTER_BASE_URL });
      expect(loaded.revision).toBe(before + 1);
      // The same model again is a no-op: no new revision, so no restart is asked for.
      await routerSvc.setModel(s.tenant.id, inst.id, PAID.id);
      expect(await revision(inst.id)).toBe(before + 1);
    });

    it('another tenant\'s instance is not found, and no catalogue means router_unavailable', async () => {
      const inst = await routerInstance();
      await expect(routerSvc.models(s.other.id, inst.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(routerSvc.setModel(s.other.id, inst.id, FREE.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(svc.models(s.tenant.id, inst.id)).rejects.toMatchObject({ code: 'router_unavailable' });
    });
  });

  describe('BYOK model discovery', () => {
    it('fetches, deduplicates and sorts models using provided credentials or a saved BYOK config', async () => {
      const inst = await mkInstance(s.tenant.id);
      respond = async () => ({
        status: 200,
        headers: {},
        body: JSON.stringify({
          data: [
            { id: 'gpt-4o', name: 'GPT-4o' },
            { id: 'bad model!' },
            { id: 'claude-3.5-sonnet' },
            { id: 'gpt-4o', name: 'Duplicate' },
          ],
        }),
      });
      const beforeSave = await svc.listByokModels(s.tenant.id, inst.id, { baseUrl: `${BASE}/`, apiKey: KEY });
      expect(beforeSave).toEqual([
        { id: 'claude-3.5-sonnet', name: 'claude-3.5-sonnet' },
        { id: 'gpt-4o', name: 'GPT-4o' },
      ]);
      expect(calls[0]).toMatchObject({ url: `${BASE}/models`, auth: `Bearer ${KEY}`, maxBytes: 4 * 1024 * 1024 });

      await svc.put(s.tenant.id, inst.id, { baseUrl: BASE, model: 'gpt-4o', apiKey: KEY2 });
      const saved = await svc.listByokModels(s.tenant.id, inst.id);
      expect(saved).toHaveLength(2);
      expect(calls[1]).toMatchObject({ url: `${BASE}/models`, auth: `Bearer ${KEY2}` });
    });

    it('rejects missing/non-BYOK config, invalid key, blocked URL, and malformed responses', async () => {
      const inst = await mkInstance(s.tenant.id);
      await expect(svc.listByokModels(s.tenant.id, inst.id)).rejects.toBeInstanceOf(NotFoundError);
      await svc.attachNibieRouter(s.tenant.id, inst.id, { apiKey: KEY, model: 'nibierouter-free' });
      await expect(svc.listByokModels(s.tenant.id, inst.id)).rejects.toMatchObject({ status: 409, code: 'not_byok' });
      await expect(svc.listByokModels(s.tenant.id, inst.id, { baseUrl: 'https://127.0.0.1/v1', apiKey: KEY })).rejects.toBeInstanceOf(OutboundBlockedError);
      respond = async () => ({ status: 401, headers: {}, body: 'bad key' });
      await expect(svc.listByokModels(s.tenant.id, inst.id, { baseUrl: BASE, apiKey: KEY })).rejects.toBeInstanceOf(ValidationError);
      respond = async () => ({ status: 200, headers: {}, body: 'not json' });
      await expect(svc.listByokModels(s.tenant.id, inst.id, { baseUrl: BASE, apiKey: KEY })).rejects.toMatchObject({ status: 502, code: 'provider_error' });
    });
  });

  it('two saves at once leave exactly one live secret and one config', async () => {
    const inst = await mkInstance(s.tenant.id);
    await svc.put(s.tenant.id, inst.id, { baseUrl: BASE, model: 'm', apiKey: KEY });
    // A slow secret write makes both transactions read the existing config before either one writes.
    const slow = Object.create(secrets) as PrismaSecretStore;
    slow.put = async (...args) => { await new Promise((r) => setTimeout(r, 150)); return secrets.put(...args); };
    const racing = new ProviderService({ prisma, secrets: slow, logger: createLogger({ level: 'silent' }), fetcher });
    const results = await Promise.allSettled([
      racing.put(s.tenant.id, inst.id, { baseUrl: BASE, model: 'a', apiKey: KEY2 }),
      racing.put(s.tenant.id, inst.id, { baseUrl: BASE, model: 'b', apiKey: KEY }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await prisma.secret.count({ where: { revokedAt: null } })).toBe(1);
    const cfg = await prisma.providerConfig.findUniqueOrThrow({ where: { instanceId: inst.id } });
    expect((await prisma.secret.findUniqueOrThrow({ where: { id: cfg.secretId } })).revokedAt).toBeNull();
  });
});
