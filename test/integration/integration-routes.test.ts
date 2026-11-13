import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { IdentityService } from '../../src/modules/auth/identity-service.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import type { Fetcher } from '../../src/modules/integrations/fetcher.js';
import { LogService } from '../../src/modules/integrations/log-service.js';
import { ProviderService } from '../../src/modules/integrations/provider-service.js';
import { createRuntimeConfigLoader } from '../../src/modules/integrations/runtime-env.js';
import { TelegramService } from '../../src/modules/integrations/telegram-service.js';
import { PrismaSecretStore } from '../../src/modules/secrets/secret-store.js';
import { OutboundFailedError } from '../../src/shared/errors.js';
import { createTestAuth, testConfig, TEST_ADMIN_TOKEN } from '../helpers/auth.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { TEST_MASTER_KEY, seed, silentLogger } from '../helpers/service-env.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const IMAGE = 'hermes-stub:0.2.0';
const TOKEN = '123456789:AAHcanaryTOKENvalue0123456789abcdefg';
const KEY = 'sk-canary-provider-key-0123456789';
const KEY2 = 'sk-canary-router-key-0123456789ab';
const ALICE = 'alice@example.test';

let auth: Awaited<ReturnType<typeof createTestAuth>>;
let s: Awaited<ReturnType<typeof seed>>;
let upstream: 'ok' | 'down';
const json = (status: number, body: unknown) => ({ status, headers: {}, body: JSON.stringify(body) });
const fetcher: Fetcher = async (url) => {
  if (/api\.telegram\.org/.test(url)) {
    if (upstream === 'down') throw new OutboundFailedError('unreachable');
    return url.endsWith('/getMe') ? json(200, { ok: true, result: { id: 424242, is_bot: true, username: 'route_bot' } }) : json(200, { ok: true });
  }
  if (upstream === 'down') throw new OutboundFailedError('unreachable');
  return json(200, { data: [] });
};

const runtime = new FakeRuntime();
function app(withSecrets = true) {
  const service = new InstanceService({
    prisma, runtime, image: IMAGE, production: false, logger: silentLogger,
    masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off', pollIntervalMs: 10, healthTimeoutMs: 2000,
  });
  const secrets = new PrismaSecretStore({ prisma, current: { version: 1, key: randomBytes(32) }, previous: null });
  return buildServer({
    service, logger: silentLogger,
    logs: new LogService({ prisma, runtime, loader: createRuntimeConfigLoader({ prisma, secrets }), masterKey: TEST_MASTER_KEY }),
    config: testConfig(IMAGE, TEST_MASTER_KEY, { betaAllowedEmails: [ALICE] }),
    customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
    integrations: withSecrets
      ? { secrets, kekVersion: 1, telegram: new TelegramService({ prisma, secrets, logger: silentLogger, fetcher }), providers: new ProviderService({ prisma, secrets, logger: silentLogger, fetcher }) }
      : null,
  });
}

async function userWithInstance(a: ReturnType<typeof app>, email = ALICE) {
  const headers = { authorization: `Bearer ${await auth.signToken({ sub: randomUUID(), email })}` };
  const me = (await a.inject({ method: 'GET', url: '/api/v1/me', headers })).json() as { tenantId: string };
  const inst = await prisma.instance.create({ data: { tenantId: me.tenantId, planId: s.plan.id, nodeId: s.node.id, name: 'x', idempotencyKey: randomUUID(), image: IMAGE, status: 'ACTIVE' } });
  return { headers, tenantId: me.tenantId, instanceId: inst.id };
}
const admin = { authorization: `Bearer ${TEST_ADMIN_TOKEN}` };

describe('integration routes', () => {
  beforeAll(async () => { auth = await createTestAuth(); });
  beforeEach(async () => { await resetDb(prisma); s = await seed(prisma); upstream = 'ok'; });
  afterAll(() => prisma.$disconnect());

  it('requires a signed-in user on every route', async () => {
    const a = app();
    const id = randomUUID();
    for (const [method, url] of [
      ['GET', `/api/v1/instances/${id}/providers`], ['PUT', `/api/v1/instances/${id}/providers`], ['POST', `/api/v1/instances/${id}/providers/test`],
      ['DELETE', `/api/v1/instances/${id}/providers/${id}`], ['GET', `/api/v1/instances/${id}/telegram`], ['PUT', `/api/v1/instances/${id}/telegram`],
      ['POST', `/api/v1/instances/${id}/telegram/verify`], ['DELETE', `/api/v1/instances/${id}/telegram`],
    ] as const) {
      expect((await a.inject({ method, url })).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('configures Telegram end to end and never returns the token', async () => {
    const a = app();
    const u = await userWithInstance(a);
    const base = `/api/v1/instances/${u.instanceId}/telegram`;
    expect((await a.inject({ method: 'GET', url: base, headers: u.headers })).json()).toEqual({ telegram: { configured: false } });
    const put = await a.inject({ method: 'PUT', url: base, headers: u.headers, payload: { token: TOKEN, allowedUserIds: ['111'] } });
    expect(put.statusCode).toBe(200);
    expect(put.json().telegram).toMatchObject({ configured: true, botUsername: 'route_bot', keyHint: TOKEN.slice(-4), restartRequired: true });
    const verify = await a.inject({ method: 'POST', url: `${base}/verify`, headers: u.headers });
    expect(verify.json().telegram).toMatchObject({ status: 'OK' });
    const get = await a.inject({ method: 'GET', url: base, headers: u.headers });
    const del = await a.inject({ method: 'DELETE', url: base, headers: u.headers });
    expect(del.statusCode).toBe(200);
    for (const r of [put, verify, get, del]) expect(r.body).not.toContain(TOKEN);
  });

  it('configures a provider end to end and never returns the key', async () => {
    const a = app();
    const u = await userWithInstance(a);
    const base = `/api/v1/instances/${u.instanceId}/providers`;
    expect((await a.inject({ method: 'GET', url: base, headers: u.headers })).json()).toEqual({ providers: [] });
    const put = await a.inject({ method: 'PUT', url: base, headers: u.headers, payload: { baseUrl: 'https://llm.example.com/v1', model: 'm', apiKey: KEY } });
    expect(put.statusCode).toBe(200);
    const provider = put.json().provider as { id: string; keyHint: string };
    expect(provider.keyHint).toBe(KEY.slice(-4));
    const test = await a.inject({ method: 'POST', url: `${base}/test`, headers: u.headers });
    expect(test.json().provider).toMatchObject({ status: 'OK' });
    const list = await a.inject({ method: 'GET', url: base, headers: u.headers });
    const del = await a.inject({ method: 'DELETE', url: `${base}/${provider.id}`, headers: u.headers });
    expect(del.statusCode).toBe(200);
    for (const r of [put, test, list, del]) expect(r.body).not.toContain(KEY);
  });

  it("another tenant's instance is 404 on every route", async () => {
    const a = app();
    const alice = await userWithInstance(a);
    const bob = await userWithInstance(a, 'bob@example.test');
    const t = `/api/v1/instances/${alice.instanceId}`;
    const calls: Array<[string, string, object?]> = [
      ['GET', `${t}/providers`], ['PUT', `${t}/providers`, { baseUrl: 'https://llm.example.com/v1', model: 'm', apiKey: KEY }], ['POST', `${t}/providers/test`],
      ['DELETE', `${t}/providers/${randomUUID()}`], ['GET', `${t}/telegram`], ['PUT', `${t}/telegram`, { token: TOKEN, allowedUserIds: ['1'] }],
      ['POST', `${t}/telegram/verify`], ['DELETE', `${t}/telegram`],
    ];
    for (const [method, url, payload] of calls) {
      const r = await a.inject({ method: method as 'GET', url, headers: bob.headers, ...(payload ? { payload } : {}) });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
      expect(r.body).not.toContain(KEY);
      expect(r.body).not.toContain(TOKEN);
    }
  });

  it('rejects unknown fields, bad shapes and bad ids with a generic 400 that echoes nothing', async () => {
    const a = app();
    const u = await userWithInstance(a);
    const p = `/api/v1/instances/${u.instanceId}/providers`;
    const t = `/api/v1/instances/${u.instanceId}/telegram`;
    const bad: Array<[string, object]> = [
      [p, { baseUrl: 'https://llm.example.com/v1', model: 'm', apiKey: KEY, kind: 'NIBIEROUTER' }],
      [p, { baseUrl: 'https://llm.example.com/v1', model: 'm' }],
      [p, { baseUrl: 5, model: 'm', apiKey: KEY }],
      [t, { token: TOKEN, allowedUserIds: ['1'], webhookUrl: 'https://evil.example' }],
      [t, { token: TOKEN }],
      [t, { token: TOKEN, allowedUserIds: 'all' }],
    ];
    for (const [url, payload] of bad) {
      const r = await a.inject({ method: 'PUT', url, headers: u.headers, payload });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      expect(r.body).not.toContain(KEY);
      expect(r.body).not.toContain(TOKEN);
    }
    expect((await a.inject({ method: 'GET', url: '/api/v1/instances/not-a-uuid/telegram', headers: u.headers })).statusCode).toBe(400);
    expect((await a.inject({ method: 'PUT', url: p, headers: u.headers, payload: { baseUrl: 'http://llm.example.com', model: 'm', apiKey: KEY } })).statusCode).toBe(400);
  });

  it('answers 503 secrets_unavailable when no key-encryption key is configured', async () => {
    const a = app(false);
    const u = await userWithInstance(a);
    for (const [method, url] of [['GET', 'providers'], ['GET', 'telegram']] as const) {
      const r = await a.inject({ method, url: `/api/v1/instances/${u.instanceId}/${url}`, headers: u.headers });
      expect(r.statusCode).toBe(503);
      expect(r.json().error.code).toBe('secrets_unavailable');
    }
  });

  it('rate limits the test and verify endpoints per user', async () => {
    const a = app();
    const u = await userWithInstance(a);
    await a.inject({ method: 'PUT', url: `/api/v1/instances/${u.instanceId}/providers`, headers: u.headers, payload: { baseUrl: 'https://llm.example.com/v1', model: 'm', apiKey: KEY } });
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await a.inject({ method: 'POST', url: `/api/v1/instances/${u.instanceId}/providers/test`, headers: u.headers })).statusCode);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes).toContain(429);
  });

  it('a provider outage on test is a 200 with a FAILED status, not a server error', async () => {
    const a = app();
    const u = await userWithInstance(a);
    await a.inject({ method: 'PUT', url: `/api/v1/instances/${u.instanceId}/providers`, headers: u.headers, payload: { baseUrl: 'https://llm.example.com/v1', model: 'm', apiKey: KEY } });
    upstream = 'down';
    const r = await a.inject({ method: 'POST', url: `/api/v1/instances/${u.instanceId}/providers/test`, headers: u.headers });
    expect(r.statusCode).toBe(200);
    expect(r.json().provider).toMatchObject({ status: 'FAILED', lastErrorCode: 'unreachable' });
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: u.instanceId } })).status).toBe('ACTIVE');
  });

  describe('logs', () => {
    it('returns the scrubbed tail for the owner, and 404 for another tenant', async () => {
      const a = app();
      const u = await userWithInstance(a);
      const bob = await userWithInstance(a, 'bob@example.test');
      await a.inject({ method: 'PUT', url: `/api/v1/instances/${u.instanceId}/providers`, headers: u.headers, payload: { baseUrl: 'https://llm.example.com/v1', model: 'm', apiKey: KEY } });
      runtime.logLines = ['gateway ready', `leaked ${KEY}`, 'Bearer abcdefghijklmnopqrstuvwx'];
      await runtime.ensure({ instanceId: u.instanceId, tenantId: u.tenantId, image: IMAGE, limits: { cpuMillis: 100, memoryMb: 64, pids: 32, storageMb: 64 }, diskQuota: 'off', egressPolicy: 'off', env: {} });
      const ok = await a.inject({ method: 'GET', url: `/api/v1/instances/${u.instanceId}/logs?tail=50`, headers: u.headers });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().lines).toHaveLength(3);
      expect(ok.body).not.toContain(KEY);
      expect(ok.body).not.toContain('abcdefghijklmnopqrstuvwx');
      expect((await a.inject({ method: 'GET', url: `/api/v1/instances/${u.instanceId}/logs`, headers: bob.headers })).statusCode).toBe(404);
      expect((await a.inject({ method: 'GET', url: `/api/v1/instances/${u.instanceId}/logs` })).statusCode).toBe(401);
    });

    it('rejects a bad tail with 400', async () => {
      const a = app();
      const u = await userWithInstance(a);
      for (const tail of ['0', '-1', 'abc', '501', '1.5']) {
        expect((await a.inject({ method: 'GET', url: `/api/v1/instances/${u.instanceId}/logs?tail=${tail}`, headers: u.headers })).statusCode, tail).toBe(400);
      }
    });
  });

  describe('operator', () => {
    it('attaches NibieRouter with the admin token only, and the customer cannot', async () => {
      const a = app();
      const u = await userWithInstance(a);
      const url = `/api/v1/tenants/${u.tenantId}/instances/${u.instanceId}/providers/nibierouter`;
      const payload = { apiKey: KEY2, model: 'nibie-default' };
      expect((await a.inject({ method: 'PUT', url, headers: u.headers, payload })).statusCode).toBe(401);
      expect((await a.inject({ method: 'PUT', url, payload })).statusCode).toBe(401);
      const ok = await a.inject({ method: 'PUT', url, headers: admin, payload });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().provider).toMatchObject({ kind: 'NIBIEROUTER', keyHint: null });
      expect(ok.body).not.toContain(KEY2);
      const list = await a.inject({ method: 'GET', url: `/api/v1/instances/${u.instanceId}/providers`, headers: u.headers });
      expect(list.json().providers[0]).toMatchObject({ kind: 'NIBIEROUTER' });
      expect(list.body).not.toContain(KEY2);
    });

    it('reports secret health and rewraps without exposing keys or values', async () => {
      const a = app();
      const u = await userWithInstance(a);
      await a.inject({ method: 'PUT', url: `/api/v1/instances/${u.instanceId}/telegram`, headers: u.headers, payload: { token: TOKEN, allowedUserIds: ['1'] } });
      const h = await a.inject({ method: 'GET', url: '/api/v1/secrets/health', headers: admin });
      expect(h.json()).toEqual({ kekVersion: 1, secretsByKekVersion: { '1': 1 } });
      const r = await a.inject({ method: 'POST', url: '/api/v1/secrets/rewrap', headers: admin });
      expect(r.json()).toEqual({ rewrapped: 0 });
      expect((await a.inject({ method: 'GET', url: '/api/v1/secrets/health' })).statusCode).toBe(401);
    });
  });
});
