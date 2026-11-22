import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function app(cfg: Partial<Config> = {}, backupMetadataDir?: string) {
  const service = new InstanceService({
    prisma, runtime: new FakeRuntime(), image: IMAGE, production: false, logger: silentLogger,
    masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off', pollIntervalMs: 10, healthTimeoutMs: 2000,
  });
  return buildServer({
    service, logger: silentLogger,
    config: testConfig(IMAGE, TEST_MASTER_KEY, { betaAllowedEmails: [ALICE, BOB], ...cfg }),
    customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma, backupMetadataDir },
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

  it('scopes backup metadata to the owner and distinguishes snapshots from verification', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hermes-backup-metadata-'));
    const a = app({}, dir);
    try {
      const alice = await user(ALICE);
      const bob = await user(BOB);
      const created = await create(a, alice);
      expect(created.statusCode).toBe(202);
      const { id } = created.json().instance as { id: string };
      const url = `/api/v1/instances/${id}/backups`;
      const load = () => a.inject({ method: 'GET', url, headers: alice });
      const observedAt = '2026-11-22T01:00:00Z';
      const snapshotAt = '2026-11-22T04:00:01.166271+08:00';
      const retentionDays = 7;
      const inventory = { observedAt, retentionDays, snapshots: {} };
      const inventoryFile = join(dir, 'snapshots.json');
      const verificationFile = join(dir, `verify-${id}.json`);

      expect((await load()).json()).toEqual({ observedAt: null, snapshotAt: null, retentionDays: null, verification: null });
      await writeFile(inventoryFile, JSON.stringify(inventory));
      expect((await load()).json()).toEqual({ observedAt, snapshotAt: null, retentionDays, verification: null });
      await writeFile(inventoryFile, JSON.stringify({ ...inventory, snapshots: { [id]: snapshotAt, [randomUUID()]: observedAt } }));
      const unverified = await load();
      expect(unverified.statusCode).toBe(200);
      expect(unverified.headers['cache-control']).toBe('no-store');
      expect(unverified.json()).toEqual({ observedAt, snapshotAt, retentionDays, verification: null });

      const verification = { snapshotAt: '2026-11-20T20:00:00Z', checkedAt: observedAt, status: 'failed' };
      await writeFile(verificationFile, JSON.stringify({ ...verification, snapshotId: 'operator-only' }));
      expect((await load()).json()).toEqual({ observedAt, snapshotAt, retentionDays, verification });
      await writeFile(verificationFile, JSON.stringify({ ...verification, status: 'passed' }));
      expect((await load()).json().verification).toEqual({ ...verification, status: 'passed' });

      expect((await a.inject({ method: 'GET', url, headers: bob })).statusCode).toBe(404);
      expect((await a.inject({ method: 'GET', url })).statusCode).toBe(401);
    } finally {
      await a.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists only active plans, with limits and a null price', async () => {
    await prisma.plan.create({ data: { slug: 'retired', name: 'Retired', active: false, cpuMillis: 100, memoryMb: 64, pids: 32, storageMb: 128 } });
    const res = await app().inject({ method: 'GET', url: '/api/v1/plans', headers: await user(ALICE) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      plans: [{ id: s.plan.id, slug: 'test-small', name: 'Test small', cpuMillis: 500, memoryMb: 256, storageMb: 1024, pids: 128, monthlyPriceIdr: null, includedCreditUsd: null, available: true }],
    });
  });

  it('lists every active plan to a stranger, marking the ones they cannot take as unavailable', async () => {
    await prisma.plan.create({ data: { slug: 'paid', name: 'Paid', cpuMillis: 1000, memoryMb: 1024, pids: 256, storageMb: 1024, monthlyPriceIdr: 25_000 } });
    // No free slots and checkout closed: the stranger sees both plans, neither available.
    const res = await app({ freeBetaSlots: 0, paidCheckoutOpen: false }).inject({ method: 'GET', url: '/api/v1/plans', headers: await user('stranger@example.test') });
    expect((res.json().plans as Array<{ slug: string; available: boolean }>).map((p) => [p.slug, p.available])).toEqual([['test-small', false], ['paid', false]]);
  });

  it('refuses a new instance at the whole-server cap, but never a replay and never after one is deleted', async () => {
    const a = app({ maxTotalInstances: 1 });
    const alice = await user(ALICE);
    const key = randomUUID();
    const first = await create(a, alice, undefined, key);
    expect(first.statusCode).toBe(202);
    // Another invited tenant is refused before anything is created.
    const refused = await create(a, await user(BOB));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('capacity_full');
    // The same request replayed is the same instance, not a new one.
    expect((await create(a, alice, undefined, key)).statusCode).toBe(202);
    // Deleting frees the slot.
    await a.inject({ method: 'DELETE', url: `/api/v1/instances/${first.json().instance.id}`, headers: alice });
    expect((await create(a, await user(BOB))).statusCode).toBe(202);
  });

  describe('free beta slots', () => {
    const STRANGER1 = 'stranger1@example.test';
    const STRANGER2 = 'stranger2@example.test';
    const plansFor = async (a: ReturnType<typeof app>, email: string) =>
      ((await a.inject({ method: 'GET', url: '/api/v1/plans', headers: await user(email) })).json().plans as Array<{ slug: string; available: boolean }>).filter((p) => p.available).map((p) => p.slug).sort();

    it('gives the free plan to the first strangers until the slots are used, then hides it and answers beta_full', async () => {
      await prisma.plan.create({ data: { slug: 'paid', name: 'Paid', cpuMillis: 1000, memoryMb: 1024, pids: 256, storageMb: 1024, monthlyPriceIdr: 25_000 } });
      const a = app({ freeBetaSlots: 1 });
      // One token per person: each call to user() would otherwise be a new tenant.
      const h1 = await user(STRANGER1);
      const h2 = await user(STRANGER2);
      const hAlice = await user(ALICE);
      expect(await plansFor(a, STRANGER1)).toEqual(['paid', 'test-small']);
      const key = randomUUID();
      const first = await create(a, h1, undefined, key);
      expect(first.statusCode).toBe(202);
      // Slots are used: the free plan disappears for strangers and creating on it answers beta_full.
      expect(await plansFor(a, STRANGER2)).toEqual(['paid']);
      const full = await create(a, h2);
      expect(full.statusCode).toBe(409);
      expect(full.json().error.code).toBe('beta_full');
      // A replay of the stranger's own request is not a new slot.
      expect((await create(a, h1, undefined, key)).statusCode).toBe(202);
      // Invited accounts are never refused and still see the free plan.
      expect(await plansFor(a, ALICE)).toEqual(['paid', 'test-small']);
      const alice = await create(a, hAlice);
      expect(alice.statusCode).toBe(202);
      // Invited accounts share the same free slots: deleting only the stranger's instance leaves none free...
      await a.inject({ method: 'DELETE', url: `/api/v1/instances/${first.json().instance.id}`, headers: h1 });
      expect((await create(a, h2)).statusCode).toBe(409);
      // ...and deleting the invited one too frees the slot again.
      await a.inject({ method: 'DELETE', url: `/api/v1/instances/${alice.json().instance.id}`, headers: hAlice });
      expect((await create(a, h2)).statusCode).toBe(202);
    });

    it('never lets a stranger create a priced plan through this route, and is off with zero slots', async () => {
      const paid = await prisma.plan.create({ data: { slug: 'paid', name: 'Paid', cpuMillis: 1000, memoryMb: 1024, pids: 256, storageMb: 1024, monthlyPriceIdr: 25_000 } });
      const withSlots = app({ freeBetaSlots: 5 });
      const refused = await create(withSlots, await user(STRANGER1), { name: 'agent', planId: paid.id });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('provisioning_not_enabled');
      const off = await create(app({ freeBetaSlots: 0 }), await user(STRANGER1));
      expect(off.statusCode).toBe(403);
    });

    it('PAID_CHECKOUT_OPEN=false hides the priced plans from strangers only', async () => {
      await prisma.plan.create({ data: { slug: 'paid', name: 'Paid', cpuMillis: 1000, memoryMb: 1024, pids: 256, storageMb: 1024, monthlyPriceIdr: 25_000 } });
      const a = app({ freeBetaSlots: 1, paidCheckoutOpen: false });
      expect(await plansFor(a, STRANGER1)).toEqual(['test-small']);
      expect(await plansFor(a, ALICE)).toEqual(['paid', 'test-small']);
    });

    it('publishes the slot counter without authentication', async () => {
      const a = app({ freeBetaSlots: 2 });
      expect((await a.inject({ method: 'GET', url: '/api/v1/public/beta-slots' })).json()).toEqual({ total: 2, remaining: 2 });
      await create(a, await user(STRANGER1));
      const res = await a.inject({ method: 'GET', url: '/api/v1/public/beta-slots' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ total: 2, remaining: 1 });
      expect(res.headers['cache-control']).toBe('public, max-age=15');
      expect((await app({ freeBetaSlots: 0 }).inject({ method: 'GET', url: '/api/v1/public/beta-slots' })).json()).toEqual({ total: 0, remaining: 0 });
    });
  });

  it('shows the unpriced beta preview plan only to invited accounts', async () => {
    await prisma.plan.create({ data: { slug: 'paid', name: 'Paid', cpuMillis: 1000, memoryMb: 1024, pids: 256, storageMb: 1024, monthlyPriceIdr: 25_000 } });
    const slugs = async (email: string) => {
      const res = await app().inject({ method: 'GET', url: '/api/v1/plans', headers: await user(email) });
      return (res.json().plans as Array<{ slug: string; available: boolean }>).filter((p) => p.available).map((p) => p.slug).sort();
    };
    expect(await slugs(ALICE)).toEqual(['paid', 'test-small']);
    expect(await slugs('stranger@example.test')).toEqual(['paid']);
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

  it('says on /me whether the caller is an admin, and only the caller', async () => {
    const a = app({ adminEmails: [BOB] });
    expect((await a.inject({ method: 'GET', url: '/api/v1/me', headers: await user(ALICE) })).json().admin).toBe(false);
    expect((await a.inject({ method: 'GET', url: '/api/v1/me', headers: await user('Bob@Example.test') })).json().admin).toBe(true);
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
