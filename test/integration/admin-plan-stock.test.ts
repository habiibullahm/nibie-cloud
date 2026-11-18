import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/env.js';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { AuditService } from '../../src/modules/admin/audit-service.js';
import { IdentityService } from '../../src/modules/auth/identity-service.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { createTestAuth, testConfig } from '../helpers/auth.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { TEST_MASTER_KEY, seed, silentLogger } from '../helpers/service-env.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const IMAGE = 'hermes-stub:0.2.0';
const BOSS = 'boss@nibie.app';
const GUEST = 'guest@example.test';

let auth: Awaited<ReturnType<typeof createTestAuth>>;
let s: Awaited<ReturnType<typeof seed>>;
let paid: { id: string };

function app(cfg: Partial<Config> = {}) {
  const service = new InstanceService({ prisma, runtime: new FakeRuntime(), image: IMAGE, production: false, logger: silentLogger, masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off' });
  return buildServer({
    service, logger: silentLogger,
    config: testConfig(IMAGE, TEST_MASTER_KEY, { adminEmails: [BOSS], freeBetaSlots: 0, paidCheckoutOpen: true, ...cfg }),
    customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
    admin: { verify: auth.verify, prisma, audit: new AuditService({ prisma }) },
  });
}

const as = async (email: string, aal: string | null = 'aal2') => ({ authorization: `Bearer ${await auth.signToken({ sub: randomUUID(), email, aal })}` });
const setStock = (a: ReturnType<typeof app>, headers: Record<string, string>, planId: string, body: unknown) =>
  a.inject({ method: 'POST', url: `/api/v1/admin/plans/${planId}/stock`, headers, payload: body as object });
const adminPlans = async (a: ReturnType<typeof app>) =>
  (await a.inject({ method: 'GET', url: '/api/v1/admin/plans', headers: await as(BOSS) })).json().plans as Array<{ slug: string; stockLimit: number | null; stockUsed: number; stockLeft: number | null }>;
const paidAvailable = async (a: ReturnType<typeof app>, headers: Record<string, string>) =>
  ((await a.inject({ method: 'GET', url: '/api/v1/plans', headers })).json().plans as Array<{ slug: string; available: boolean }>).find((p) => p.slug === 'paid')!.available;
/** A paid subscription still waiting for its instance: it holds one unit of stock. */
const holdUnit = () => prisma.subscription.create({ data: { tenantId: s.tenant.id, planId: paid.id, intendedName: 'held', status: 'ACTIVE' } });

describe('admin plan stock', () => {
  beforeAll(async () => { auth = await createTestAuth(); });
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seed(prisma);
    paid = await prisma.plan.create({ data: { slug: 'paid', name: 'Paid', cpuMillis: 1000, memoryMb: 1024, pids: 256, storageMb: 1024, monthlyPriceIdr: 50_000 } });
  });
  afterAll(() => prisma.$disconnect());

  it('refuses everyone but an allowlisted admin with a second factor', async () => {
    const a = app();
    expect((await a.inject({ method: 'POST', url: `/api/v1/admin/plans/${paid.id}/stock`, payload: { stockLimit: 1, reason: 'test reason' } })).statusCode).toBe(401);
    expect((await setStock(a, await as(GUEST), paid.id, { stockLimit: 1, reason: 'test reason' })).statusCode).toBe(403);
    const mfa = await setStock(a, await as(BOSS, 'aal1'), paid.id, { stockLimit: 1, reason: 'test reason' });
    expect(mfa.statusCode).toBe(403);
    expect(mfa.json().error.code).toBe('mfa_required');
    expect((await prisma.plan.findUniqueOrThrow({ where: { id: paid.id } })).stockLimit).toBeNull();
  });

  it('sets, keeps and clears the stock with one audit entry per real change', async () => {
    const a = app();
    const boss = await as(BOSS);
    const res = await setStock(a, boss, paid.id, { stockLimit: 3, reason: 'launch batch' });
    expect(res.statusCode).toBe(200);
    expect(res.json().plan).toEqual({ id: paid.id, slug: 'paid', stockLimit: 3 });
    // The same value again changes nothing and is not recorded.
    expect((await setStock(a, boss, paid.id, { stockLimit: 3, reason: 'launch batch' })).statusCode).toBe(200);
    expect((await setStock(a, boss, paid.id, { stockLimit: null, reason: 'no limit' })).json().plan.stockLimit).toBeNull();
    const rows = await prisma.auditLog.findMany({ where: { targetType: 'plan' }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => [r.reason, r.detail])).toEqual([
      ['launch batch', { slug: 'paid', from: null, to: 3 }],
      ['no limit', { slug: 'paid', from: 3, to: null }],
    ]);
    expect(rows.every((r) => r.actorEmail === BOSS && r.targetId === paid.id)).toBe(true);
  });

  it('refuses the free plan, an unknown plan and invalid bodies', async () => {
    const a = app();
    const boss = await as(BOSS);
    const free = await setStock(a, boss, s.plan.id, { stockLimit: 5, reason: 'test reason' });
    expect(free.statusCode).toBe(409);
    expect(free.json().error.code).toBe('free_plan_stock');
    expect((await setStock(a, boss, randomUUID(), { stockLimit: 5, reason: 'test reason' })).statusCode).toBe(404);
    expect((await setStock(a, boss, paid.id, { stockLimit: -1, reason: 'test reason' })).statusCode).toBe(400);
    expect((await setStock(a, boss, paid.id, { stockLimit: 1.5, reason: 'test reason' })).statusCode).toBe(400);
    expect((await setStock(a, boss, paid.id, { stockLimit: 5 })).statusCode).toBe(400);
    expect((await setStock(a, boss, paid.id, { stockLimit: 5, reason: 'test reason', extra: 1 })).statusCode).toBe(400);
    expect(await prisma.auditLog.count({ where: { targetType: 'plan' } })).toBe(0);
  });

  it('lists stock used and left; the free plan has no stock', async () => {
    await prisma.plan.update({ where: { id: paid.id }, data: { stockLimit: 2 } });
    await holdUnit();
    const plans = await adminPlans(app());
    expect(plans.find((p) => p.slug === 'paid')).toMatchObject({ stockLimit: 2, stockUsed: 1, stockLeft: 1 });
    expect(plans.find((p) => p.slug === 'test-small')).toMatchObject({ stockLimit: null, stockLeft: null });
  });

  it('a sold-out plan shows as unavailable to customers, invited or not, and opens again when stock is added', async () => {
    const a = app({ betaAllowedEmails: ['vip@example.test'] });
    const boss = await as(BOSS);
    const guest = await as(GUEST);
    const vip = await as('vip@example.test');
    await setStock(a, boss, paid.id, { stockLimit: 1, reason: 'one unit' });
    expect(await paidAvailable(a, guest)).toBe(true);
    await holdUnit();
    expect(await paidAvailable(a, guest)).toBe(false);
    expect(await paidAvailable(a, vip)).toBe(false);
    await setStock(a, boss, paid.id, { stockLimit: 2, reason: 'more units' });
    expect(await paidAvailable(a, guest)).toBe(true);
  });
});
