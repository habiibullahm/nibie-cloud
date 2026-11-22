import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { AuditService } from '../../src/modules/admin/audit-service.js';
import { IdentityService } from '../../src/modules/auth/identity-service.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { AiAccountService, nanoToIdr } from '../../src/modules/nibierouter/ai-account.js';
import type { CatalogModel } from '../../src/modules/nibierouter/model-catalog.js';
import { NANO_PER_USD, type NibieRouterClient, type RouterKeyRow, type RouterUsage } from '../../src/modules/nibierouter/nibierouter-client.js';
import { RouterUnavailableError } from '../../src/shared/errors.js';
import { createTestAuth, testConfig } from '../helpers/auth.js';
import { makeBilling, seedBilling } from '../helpers/billing-env.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { TEST_MASTER_KEY, silentLogger } from '../helpers/service-env.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const IMAGE = 'hermes-stub:0.2.0';
const BOSS = 'boss@nibie.app';
const HOUR = 3_600_000;

/** Only the calls the AI account uses; the rest are never reached here. */
class FakeRouter {
  balances = new Map<string, bigint>();
  keys = new Map<string, RouterKeyRow[]>();
  revoked: string[] = [];
  private seq = 0;
  async listKeys(userId: string) {
    return (this.keys.get(userId) ?? []).map((k) => ({ ...k }));
  }
  async createKey(userId: string, input: { name: string; rpmLimit: number }) {
    const id = `k-${++this.seq}`;
    this.keys.set(userId, [...(this.keys.get(userId) ?? []), { id, name: input.name, revoked: false, createdAt: null, rpmLimit: input.rpmLimit, settings: {} }]);
    return { id, secret: `sk-secret-${id}-0123456789` };
  }
  async revokeKey(userId: string, keyId: string) {
    this.revoked.push(keyId);
    for (const k of this.keys.get(userId) ?? []) if (k.id === keyId) k.revoked = true;
  }
  rate: number | null = 18_600;
  down = false;
  usageCalls = 0;
  async getUsage(userId: string): Promise<RouterUsage> {
    this.usageCalls += 1;
    if (this.down) throw new RouterUnavailableError('unreachable');
    return {
      balanceNano: this.balances.get(userId) ?? 0n,
      spend30dNano: NANO_PER_USD / 2n,
      daily: [{ day: '2026-11-19', requests: 3, costNano: NANO_PER_USD / 2n }],
      models: [{ model: 'paid-model', requests: 3, costNano: NANO_PER_USD / 2n }],
    };
  }
  async getIdrPerUsd() {
    if (this.down) throw new RouterUnavailableError('unreachable');
    return this.rate;
  }
}

let auth: Awaited<ReturnType<typeof createTestAuth>>;
let router: FakeRouter;
let clock: number;
let ai: AiAccountService;

const MODELS: CatalogModel[] = [
  { id: 'free-model', name: 'Free model', contextLength: null, promptUsdPerM: 0, completionUsdPerM: 0, free: true },
  { id: 'paid-model', name: 'Paid model', contextLength: 8192, promptUsdPerM: 0.3, completionUsdPerM: 2.16, free: false },
];
const catalog = { list: async () => MODELS };

const service = () => new AiAccountService({ prisma, client: router as unknown as NibieRouterClient, logger: silentLogger, catalog, now: () => clock });

function app(withAi = true) {
  const inst = new InstanceService({ prisma, runtime: new FakeRuntime(), image: IMAGE, production: false, logger: silentLogger, masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off' });
  return buildServer({
    service: inst, logger: silentLogger,
    config: testConfig(IMAGE, TEST_MASTER_KEY, { adminEmails: [BOSS] }),
    customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
    admin: { verify: auth.verify, prisma, audit: new AuditService({ prisma }) },
    ai: withAi ? ai : null,
  });
}
type App = ReturnType<typeof app>;

async function customer(a: App) {
  const headers = { authorization: `Bearer ${await auth.signToken({ sub: randomUUID(), email: `c-${randomUUID().slice(0, 8)}@example.test` })}` };
  const me = (await a.inject({ method: 'GET', url: '/api/v1/me', headers })).json() as { tenantId: string };
  return { headers, tenantId: me.tenantId };
}
const boss = async (aal = 'aal2') => ({ authorization: `Bearer ${await auth.signToken({ sub: randomUUID(), email: BOSS, aal })}` });

/** A tenant that has a router user and once received AI credit, so the reminder checks it. */
async function creditedTenant(tenantId: string, userId: string, balanceUsd: number) {
  await prisma.tenant.update({ where: { id: tenantId }, data: { routerUserId: userId } });
  const s = await seedSub(tenantId);
  await prisma.creditGrant.create({ data: { tenantId, subscriptionId: s, amountNano: 2n * NANO_PER_USD, note: `n-${s}`, status: 'DONE' } });
  router.balances.set(userId, BigInt(Math.round(balanceUsd * 1e9)));
}
let seeded: Awaited<ReturnType<typeof seedBilling>>;
let plan: { id: string };
async function seedSub(tenantId: string) {
  const sub = await prisma.subscription.create({ data: { tenantId, planId: plan.id, intendedName: 'x', status: 'ACTIVE', currentPeriodEnd: new Date('2027-01-01T00:00:00Z') } });
  return sub.id;
}

describe('AI account (NibieRouter balance in Rupiah)', () => {
  beforeAll(async () => { auth = await createTestAuth(); });
  beforeEach(async () => {
    await resetDb(prisma);
    seeded = await seedBilling(prisma);
    plan = seeded.plan;
    router = new FakeRouter();
    clock = Date.parse('2026-12-01T00:00:00Z');
    ai = service();
  });
  afterAll(() => prisma.$disconnect());

  it('converts nano-USD to Rupiah, rounding down', () => {
    expect(nanoToIdr(NANO_PER_USD, 18_600)).toBe(18_600);
    expect(nanoToIdr(NANO_PER_USD / 3n, 18_600)).toBe(6_199);
    expect(nanoToIdr(0n, 18_600)).toBe(0);
  });

  it('uses the router rate by default, the admin rate when set, and US$ only when neither exists', async () => {
    expect(await ai.rate()).toEqual({ idrPerUsd: 18_600, source: 'router' });
    await prisma.billingSetting.create({ data: { id: 1, aiCreditIdrPerUsd: 20_000 } });
    expect(await ai.rate()).toEqual({ idrPerUsd: 20_000, source: 'admin' });
    await prisma.billingSetting.update({ where: { id: 1 }, data: { aiCreditIdrPerUsd: null } });
    router.rate = null;
    expect(await service().rate()).toEqual({ idrPerUsd: null, source: null });
  });

  it('keeps the last router rate while the router is down', async () => {
    expect((await ai.rate()).idrPerUsd).toBe(18_600);
    router.down = true;
    clock += 11 * 60_000;
    expect((await ai.rate()).idrPerUsd).toBe(18_600);
  });

  it('GET /ai: Rupiah balance and usage for the caller\'s tenant only, cached for a minute; 404 without NibieRouter', async () => {
    const a = app();
    const c = await customer(a);
    const empty = (await a.inject({ method: 'GET', url: '/api/v1/ai', headers: c.headers })).json();
    expect(empty).toMatchObject({ hasAccount: false, balanceIdr: 0, daily: [], alert: { enabled: true, thresholdIdr: 10_000 } });

    await prisma.tenant.update({ where: { id: c.tenantId }, data: { routerUserId: 'ru-1' } });
    router.balances.set('ru-1', 2n * NANO_PER_USD);
    const res = await a.inject({ method: 'GET', url: '/api/v1/ai', headers: c.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      rate: { idrPerUsd: 18_600, source: 'router' }, hasAccount: true, balanceUsd: 2, balanceIdr: 37_200, spend30dIdr: 9_300,
      daily: [{ day: '2026-11-19', requests: 3, costIdr: 9_300 }], models: [{ model: 'paid-model', costIdr: 9_300 }],
    });
    await a.inject({ method: 'GET', url: '/api/v1/ai', headers: c.headers });
    expect(router.usageCalls).toBe(1);

    router.down = true;
    clock += 61_000;
    expect((await a.inject({ method: 'GET', url: '/api/v1/ai', headers: c.headers })).statusCode).toBe(503);
    expect((await app(false).inject({ method: 'GET', url: '/api/v1/ai', headers: c.headers })).statusCode).toBe(404);
  });

  it('customer keys: only usr- keys are shown, created with the rpm limit, at most 5 active, revoked only by their tenant', async () => {
    const a = app();
    const c = await customer(a);
    const url = '/api/v1/ai/keys';
    expect((await a.inject({ method: 'GET', url, headers: c.headers })).json()).toEqual({ baseUrl: 'https://router.nibie.app/v1', hasAccount: false, keys: [] });
    const none = await a.inject({ method: 'POST', url, headers: c.headers, payload: { name: 'script' } });
    expect([none.statusCode, none.json().error.code]).toEqual([409, 'ai_account_missing']);

    await prisma.tenant.update({ where: { id: c.tenantId }, data: { routerUserId: 'ru-k' } });
    router.keys.set('ru-k', [{ id: 'inst-key', name: `inst-${randomUUID()}`, revoked: false, createdAt: null, rpmLimit: 20, settings: {} }]);
    for (const bad of [{ name: '' }, { name: 'x'.repeat(41) }, { name: 'a/b' }, { name: 'ok', extra: 1 }]) {
      expect((await a.inject({ method: 'POST', url, headers: c.headers, payload: bad })).statusCode).toBe(400);
    }

    const made = await a.inject({ method: 'POST', url, headers: c.headers, payload: { name: ' my script ' } });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ key: { id: 'k-1', name: 'my script', revoked: false }, secret: 'sk-secret-k-1-0123456789', baseUrl: 'https://router.nibie.app/v1' });
    expect(router.keys.get('ru-k')!.find((k) => k.id === 'k-1')).toMatchObject({ name: 'usr-my script', rpmLimit: 20 });

    const list = (await a.inject({ method: 'GET', url, headers: c.headers })).json();
    expect(list.keys).toEqual([{ id: 'k-1', name: 'my script', createdAt: null, revoked: false }]);
    expect(JSON.stringify(list)).not.toContain('sk-');

    for (let i = 2; i <= 5; i++) expect((await a.inject({ method: 'POST', url, headers: c.headers, payload: { name: `k${i}` } })).statusCode).toBe(201);
    const full = await a.inject({ method: 'POST', url, headers: c.headers, payload: { name: 'k6' } });
    expect([full.statusCode, full.json().error.code]).toEqual([409, 'key_limit']);

    // The instance key and another tenant's key are not this customer's to revoke.
    expect((await a.inject({ method: 'POST', url: `${url}/inst-key/revoke`, headers: c.headers })).statusCode).toBe(404);
    const other = await customer(a);
    await prisma.tenant.update({ where: { id: other.tenantId }, data: { routerUserId: 'ru-other' } });
    expect((await a.inject({ method: 'POST', url: `${url}/k-1/revoke`, headers: other.headers })).statusCode).toBe(404);
    expect(router.revoked).toEqual([]);

    expect((await a.inject({ method: 'POST', url: `${url}/k-1/revoke`, headers: c.headers })).statusCode).toBe(204);
    expect(router.revoked).toEqual(['k-1']);
    expect((await a.inject({ method: 'POST', url: `${url}/k-1/revoke`, headers: c.headers })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url, headers: c.headers, payload: { name: 'k6' } })).statusCode).toBe(201);
    expect((await a.inject({ method: 'GET', url })).statusCode).toBe(401);
  });

  it('GET /ai/models: free models only without an instance on a priced plan, all with one; 404 without NibieRouter', async () => {
    const a = app();
    const c = await customer(a);
    const url = '/api/v1/ai/models';
    const ids = async () => {
      const res = await a.inject({ method: 'GET', url, headers: c.headers });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { baseUrl: string; freeOnly: boolean; models: CatalogModel[] };
      expect(body.baseUrl).toBe('https://router.nibie.app/v1');
      return [body.freeOnly, body.models.map((m) => m.id)];
    };
    expect(await ids()).toEqual([true, ['free-model']]);

    const freePlan = await prisma.plan.create({ data: { slug: 'free', name: 'Free', cpuMillis: 500, memoryMb: 256, pids: 128, storageMb: 1024, monthlyPriceIdr: null } });
    const inst = (planId: string) => prisma.instance.create({ data: { tenantId: c.tenantId, planId, nodeId: seeded.node.id, name: `i-${randomUUID().slice(0, 8)}`, idempotencyKey: randomUUID(), image: IMAGE, status: 'ACTIVE' } });
    await inst(freePlan.id);
    expect(await ids()).toEqual([true, ['free-model']]);

    // A positive AI balance unlocks paid models even when the tenant only has a free-plan instance.
    await prisma.tenant.update({ where: { id: c.tenantId }, data: { routerUserId: 'ru-models' } });
    router.balances.set('ru-models', 2n * NANO_PER_USD);
    clock += 61_000;
    expect(await ids()).toEqual([false, ['free-model', 'paid-model']]);
    router.balances.set('ru-models', 0n);
    clock += 61_000;
    expect(await ids()).toEqual([true, ['free-model']]);

    const paid = await inst(plan.id);
    expect(await ids()).toEqual([false, ['free-model', 'paid-model']]);
    // A deleted paid instance no longer counts; another tenant's paid instance never did.
    await prisma.instance.update({ where: { id: paid.id }, data: { status: 'DELETED', deletedAt: new Date() } });
    await prisma.instance.create({ data: { tenantId: seeded.other.id, planId: plan.id, nodeId: seeded.node.id, name: 'other', idempotencyKey: randomUUID(), image: IMAGE, status: 'ACTIVE' } });
    expect(await ids()).toEqual([true, ['free-model']]);

    expect((await a.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await app(false).inject({ method: 'GET', url, headers: c.headers })).statusCode).toBe(404);
  });

  it('PUT /ai/alert saves the switch and threshold, validated, and starts the reminder afresh', async () => {
    const a = app();
    const c = await customer(a);
    await prisma.tenant.update({ where: { id: c.tenantId }, data: { aiLowNotifiedAt: new Date() } });
    for (const bad of [{ enabled: true, thresholdIdr: 999 }, { enabled: true, thresholdIdr: 1_000_001 }, { enabled: 'yes', thresholdIdr: 5_000 }, { enabled: true, thresholdIdr: 5_000, extra: 1 }]) {
      expect((await a.inject({ method: 'PUT', url: '/api/v1/ai/alert', headers: c.headers, payload: bad })).statusCode).toBe(400);
    }
    const ok = await a.inject({ method: 'PUT', url: '/api/v1/ai/alert', headers: c.headers, payload: { enabled: false, thresholdIdr: 25_000 } });
    expect(ok.json()).toEqual({ alert: { enabled: false, thresholdIdr: 25_000 } });
    expect(await prisma.tenant.findUniqueOrThrow({ where: { id: c.tenantId } })).toMatchObject({ aiLowAlert: false, aiLowThresholdIdr: 25_000, aiLowNotifiedAt: null });
    expect((await a.inject({ method: 'PUT', url: '/api/v1/ai/alert', payload: { enabled: true, thresholdIdr: 5_000 } })).statusCode).toBe(401);
  });

  it('reminds once per drop below the threshold, only tenants that ever had credit, at most once an hour', async () => {
    const s = seeded;
    const { billing, mailer } = makeBilling(prisma);
    const send = (tenantId: string, c: { balanceIdr: number; thresholdIdr: number }) =>
      billing.sendEmail(tenantId, 'ai_low_balance', { periodEnd: null, amountIdr: c.thresholdIdr, balanceIdr: c.balanceIdr, dashboardPath: '/dashboard/billing' });

    await creditedTenant(s.tenant.id, 'ru-low', 0.25); // Rp 4.650, below Rp 10.000
    // A free tenant with a router user but never any credit: balance 0, never mailed.
    await prisma.tenant.update({ where: { id: s.other.id }, data: { routerUserId: 'ru-free' } });

    expect(await ai.checkLowBalances(send)).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.subject).toBe('Saldo AI hampir habis - Nibie Cloud');
    expect(mailer.sent[0]!.text).toContain('Rp 4.650');

    // Within the hour: not checked. After it: still low, already reminded, no second email.
    expect(await ai.checkLowBalances(send)).toBe(0);
    clock += HOUR;
    expect(await ai.checkLowBalances(send)).toBe(0);
    expect(mailer.sent).toHaveLength(1);

    // Topped up above the threshold, then low again: a second reminder.
    router.balances.set('ru-low', NANO_PER_USD);
    clock += HOUR;
    await ai.checkLowBalances(send);
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: s.tenant.id } })).aiLowNotifiedAt).toBeNull();
    router.balances.set('ru-low', 0n);
    clock += HOUR;
    expect(await ai.checkLowBalances(send)).toBe(1);
    expect(mailer.sent).toHaveLength(2);

    // Switched off: nothing.
    await prisma.tenant.update({ where: { id: s.tenant.id }, data: { aiLowAlert: false, aiLowNotifiedAt: null } });
    clock += HOUR;
    expect(await ai.checkLowBalances(send)).toBe(0);
  });

  it('a failed send gives the claim back so the next check tries again; a router outage changes nothing', async () => {
    const s = seeded;
    const { billing, mailer } = makeBilling(prisma);
    const send = (tenantId: string, c: { balanceIdr: number; thresholdIdr: number }) =>
      billing.sendEmail(tenantId, 'ai_low_balance', { periodEnd: null, amountIdr: c.thresholdIdr, balanceIdr: c.balanceIdr });
    await creditedTenant(s.tenant.id, 'ru-x', 0);

    mailer.failNext = true;
    expect(await ai.checkLowBalances(send)).toBe(0);
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: s.tenant.id } })).aiLowNotifiedAt).toBeNull();

    router.down = true;
    clock += 11 * 60_000 + HOUR;
    expect(await service().checkLowBalances(send)).toBe(0);
    router.down = false;
    clock += HOUR;
    expect(await ai.checkLowBalances(send)).toBe(1);
  });

  it('admin rate: aal2, range-checked, audited once per change, null goes back to the router rate; shown on /system', async () => {
    const a = app();
    const url = '/api/v1/admin/settings/ai-credit-rate';
    expect((await a.inject({ method: 'POST', url, headers: await boss('aal1'), payload: { idrPerUsd: 20_000, reason: 'margin' } })).statusCode).toBe(403);
    expect((await a.inject({ method: 'POST', url, headers: await boss(), payload: { idrPerUsd: 4_999, reason: 'too low' } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'POST', url, headers: await boss(), payload: { idrPerUsd: 20_000 } })).statusCode).toBe(400);

    const ok = await a.inject({ method: 'POST', url, headers: await boss(), payload: { idrPerUsd: 20_000, reason: 'margin for AI credit' } });
    expect(ok.json()).toEqual({ adminIdrPerUsd: 20_000 });
    await a.inject({ method: 'POST', url, headers: await boss(), payload: { idrPerUsd: 20_000, reason: 'same again' } });
    const audits = await prisma.auditLog.findMany({ where: { action: 'POST /settings/ai-credit-rate' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ reason: 'margin for AI credit', detail: { from: null, to: 20_000 } });
    expect(await ai.rate()).toEqual({ idrPerUsd: 20_000, source: 'admin' });

    const sys = (await a.inject({ method: 'GET', url: '/api/v1/admin/system', headers: await boss() })).json();
    expect(sys.settings.ai.creditRate).toEqual({ adminIdrPerUsd: 20_000, routerIdrPerUsd: 18_600 });

    await a.inject({ method: 'POST', url, headers: await boss(), payload: { idrPerUsd: null, reason: 'back to router rate' } });
    expect(await ai.rate()).toEqual({ idrPerUsd: 18_600, source: 'router' });
    expect((await app(false).inject({ method: 'POST', url, headers: await boss(), payload: { idrPerUsd: 20_000, reason: 'no router' } })).statusCode).toBe(404);
  });
});
