import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/env.js';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { IdentityService } from '../../src/modules/auth/identity-service.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { createTestAuth, testConfig } from '../helpers/auth.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { TEST_MASTER_KEY, seed, silentLogger } from '../helpers/service-env.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const IMAGE = 'hermes-stub:0.2.0';
const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';

let auth: Awaited<ReturnType<typeof createTestAuth>>;
let s: Awaited<ReturnType<typeof seed>>;

function app(cfg: Partial<Config> = {}) {
  const service = new InstanceService({
    prisma, runtime: new FakeRuntime(), image: IMAGE, production: false, logger: silentLogger,
    masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off', pollIntervalMs: 10, healthTimeoutMs: 2000,
  });
  return buildServer({
    service, logger: silentLogger,
    config: testConfig(IMAGE, TEST_MASTER_KEY, { betaAllowedEmails: [ALICE, BOB], ...cfg }),
    customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
  });
}

/** A signed-in user: stable sub so every request maps to the same tenant. */
async function user(email: string) {
  const token = await auth.signToken({ sub: randomUUID(), email });
  return { authorization: `Bearer ${token}` };
}
const create = (a: ReturnType<typeof app>, headers: Record<string, string>, body: unknown = { name: 'agent', planId: s.plan.id }, key: string = randomUUID()) =>
  a.inject({ method: 'POST', url: '/api/v1/instances', headers: { ...headers, 'idempotency-key': key }, payload: body as object });

describe('customer API', () => {
  beforeAll(async () => { auth = await createTestAuth(); });
  beforeEach(async () => { await resetDb(prisma); s = await seed(prisma); });
  afterAll(() => prisma.$disconnect());

  it('lists only active plans, with limits and a null price', async () => {
    await prisma.plan.create({ data: { slug: 'retired', name: 'Retired', active: false, cpuMillis: 100, memoryMb: 64, pids: 32, storageMb: 128 } });
    const res = await app().inject({ method: 'GET', url: '/api/v1/plans', headers: await user(ALICE) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      plans: [{ id: s.plan.id, slug: 'test-small', name: 'Test small', cpuMillis: 500, memoryMb: 256, storageMb: 1024, pids: 128, monthlyPriceIdr: null }],
    });
  });

  it('provisions, lists, reads status and events, restarts, stops, starts and deletes', async () => {
    const a = app();
    const h = await user(ALICE);
    const created = await create(a, h);
    expect(created.statusCode).toBe(202);
    const inst = created.json().instance as { id: string; status: string; tenantId: string; name: string };
    expect(inst).toMatchObject({ status: 'ACTIVE', name: 'agent' });

    const list = await a.inject({ method: 'GET', url: '/api/v1/instances', headers: h });
    expect(list.json().instances.map((i: { id: string }) => i.id)).toEqual([inst.id]);
    expect((await a.inject({ method: 'GET', url: `/api/v1/instances/${inst.id}`, headers: h })).json().instance.id).toBe(inst.id);
    expect((await a.inject({ method: 'GET', url: `/api/v1/instances/${inst.id}/status`, headers: h })).json()).toMatchObject({ status: 'ACTIVE' });
    const events = await a.inject({ method: 'GET', url: `/api/v1/instances/${inst.id}/events`, headers: h });
    expect(events.json().events.length).toBeGreaterThan(0);

    for (const [action, status] of [['restart', 'ACTIVE'], ['stop', 'STOPPED'], ['start', 'ACTIVE']] as const) {
      const res = await a.inject({ method: 'POST', url: `/api/v1/instances/${inst.id}/${action}`, headers: h });
      expect(res.statusCode).toBe(202);
      expect(res.json().instance.status).toBe(status);
    }
    const del = await a.inject({ method: 'DELETE', url: `/api/v1/instances/${inst.id}`, headers: h });
    expect(del.statusCode).toBe(202);
    expect(del.json().instance.status).toBe('DELETED');
  });

  describe('provisioning gate', () => {
    it('refuses users outside the beta allowlist with 403 provisioning_not_enabled', async () => {
      const res = await create(app(), await user('stranger@example.test'));
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('provisioning_not_enabled');
      expect(await prisma.instance.count()).toBe(0);
    });

    it('fails closed: an empty allowlist lets nobody provision', async () => {
      const res = await create(app({ betaAllowedEmails: [] }), await user(ALICE));
      expect(res.statusCode).toBe(403);
    });

    it('matches the allowlist case-insensitively', async () => {
      const res = await create(app(), await user('Alice@Example.Test'));
      expect(res.statusCode).toBe(202);
    });

    it('answers 409 over the per-tenant cap, and frees the slot after a delete', async () => {
      const a = app();
      const h = await user(ALICE);
      const first = await create(a, h);
      expect(first.statusCode).toBe(202);
      const second = await create(a, h);
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('instance_limit_reached');
      await a.inject({ method: 'DELETE', url: `/api/v1/instances/${first.json().instance.id}`, headers: h });
      expect((await create(a, h)).statusCode).toBe(202);
    });

    it('lets an idempotent replay through the cap and rejects key reuse with another body', async () => {
      const a = app();
      const h = await user(ALICE);
      const key = randomUUID();
      const first = await create(a, h, undefined, key);
      const replay = await create(a, h, undefined, key);
      expect(replay.statusCode).toBe(202);
      expect(replay.json().instance.id).toBe(first.json().instance.id);
      const other = await create(a, h, { name: 'different', planId: s.plan.id }, key);
      expect(other.statusCode).toBe(409);
      expect(await prisma.instance.count()).toBe(1);
    });

    it('holds the cap under five concurrent requests with different keys', async () => {
      const a = app();
      const h = await user(ALICE);
      await a.inject({ method: 'GET', url: '/api/v1/me', headers: h }); // tenant exists before the race
      const codes = (await Promise.all(Array.from({ length: 5 }, () => create(a, h)))).map((r) => r.statusCode).sort();
      expect(codes).toEqual([202, 409, 409, 409, 409]);
      expect(await prisma.instance.count({ where: { status: { not: 'DELETED' } } })).toBe(1);
    });

    it('honours a higher MAX_INSTANCES_PER_TENANT', async () => {
      const a = app({ maxInstancesPerTenant: 2 });
      const h = await user(ALICE);
      expect((await create(a, h)).statusCode).toBe(202);
      expect((await create(a, h)).statusCode).toBe(202);
      expect((await create(a, h)).statusCode).toBe(409);
    });

    it('answers 429 on the sixth provisioning request within ten minutes', async () => {
      const a = app();
      const h = await user(ALICE);
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await create(a, h)).statusCode);
      expect(codes.slice(0, 5)).not.toContain(429);
      expect(codes[5]).toBe(429);
      const limited = await create(a, h);
      expect(limited.json()).toEqual({ error: { code: 'rate_limited', message: 'Too many requests' } });
      expect((await a.inject({ method: 'GET', url: '/api/v1/instances', headers: h })).statusCode).toBe(200);
    });
  });

  it('validates the body, the idempotency key and the plan id', async () => {
    const a = app({ maxInstancesPerTenant: 10 });
    const h = await user(ALICE);
    const noKey = await a.inject({ method: 'POST', url: '/api/v1/instances', headers: h, payload: { name: 'x', planId: s.plan.id } });
    expect(noKey.statusCode).toBe(400);
    expect((await create(a, h, { name: 1 })).statusCode).toBe(400);
    expect((await create(a, h, { name: 'x', planId: s.plan.id, tenantId: s.other.id })).statusCode).toBe(400);
    expect((await create(a, h, { name: 'x', planId: 'not-a-uuid' })).statusCode).toBe(400);
    expect((await create(a, h, { name: 'x', planId: randomUUID() })).statusCode).toBe(404);
    expect(await prisma.instance.count()).toBe(0);
  });

  it('refuses an inactive plan with 404 and creates nothing', async () => {
    const retired = await prisma.plan.create({ data: { slug: 'retired', name: 'Retired', active: false, cpuMillis: 100, memoryMb: 64, pids: 32, storageMb: 128 } });
    const res = await create(app(), await user(ALICE), { name: 'x', planId: retired.id });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe('Plan not found');
    expect(await prisma.instance.count()).toBe(0);
  });

  it('never lets one user see or act on another user\'s instance (404 on every verb)', async () => {
    const a = app();
    const alice = await user(ALICE);
    const bob = await user(BOB);
    const id = (await create(a, alice)).json().instance.id as string;

    const attempts: [string, string][] = [
      ['GET', `/api/v1/instances/${id}`],
      ['GET', `/api/v1/instances/${id}/status`],
      ['GET', `/api/v1/instances/${id}/events`],
      ['POST', `/api/v1/instances/${id}/start`],
      ['POST', `/api/v1/instances/${id}/stop`],
      ['POST', `/api/v1/instances/${id}/restart`],
      ['DELETE', `/api/v1/instances/${id}`],
    ];
    for (const [method, url] of attempts) {
      const res = await a.inject({ method: method as 'GET', url, headers: bob });
      expect([method, url, res.statusCode]).toEqual([method, url, 404]);
      expect(res.json().error.code).toBe('not_found');
    }
    expect((await a.inject({ method: 'GET', url: '/api/v1/instances', headers: bob })).json().instances).toEqual([]);
    const row = await prisma.instance.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('ACTIVE');
    expect((await a.inject({ method: 'GET', url: '/api/v1/instances/not-a-uuid', headers: bob })).statusCode).toBe(404);
  });

  it('ignores a tenant id smuggled in the query string', async () => {
    const a = app();
    const alice = await user(ALICE);
    const bob = await user(BOB);
    await create(a, alice);
    const aliceTenant = (await a.inject({ method: 'GET', url: '/api/v1/me', headers: alice })).json().tenantId as string;
    const res = await a.inject({ method: 'GET', url: `/api/v1/instances?tenantId=${aliceTenant}`, headers: bob });
    expect(res.json().instances).toEqual([]);
  });
});
