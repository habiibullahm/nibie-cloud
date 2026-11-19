import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { IdentityService } from '../../src/modules/auth/identity-service.js';
import { invoicePeriod } from '../../src/modules/billing/invoices.js';
import { createTestAuth, testConfig } from '../helpers/auth.js';
import { PRICE, WEBHOOK_TOKEN, makeBilling, seedBilling, webhookBody } from '../helpers/billing-env.js';
import { resetDb } from '../helpers/db.js';
import { TEST_MASTER_KEY, silentLogger } from '../helpers/service-env.js';

// Invoices: one per paid hosting payment or top-up, issued by the webhook, numbered per month without gaps.

const prisma = createPrisma(process.env.DATABASE_URL!);
let env: ReturnType<typeof makeBilling>;
let s: Awaited<ReturnType<typeof seedBilling>>;

const pay = (orderId: string, o: { amount?: number; reference?: string } = {}) =>
  env.billing.handleSumoPodWebhook({ token: WEBHOOK_TOKEN }, webhookBody({ orderId, ...o }) as Record<string, unknown>);
const paidTopup = async (amountIdr: number) => {
  const t = await env.billing.wallet!.startTopup({ tenantId: s.tenant.id, email: s.user.email, amountIdr, idempotencyKey: randomUUID() });
  const order = (await prisma.walletTopup.findUniqueOrThrow({ where: { id: t.id } })).merchantOrderId;
  await pay(order, { amount: amountIdr, reference: `REF-${t.id.slice(0, 6)}` });
  return { topup: t, order };
};
const paidCheckout = async (name = 'My agent') => {
  const r = await env.billing.checkout({ tenantId: s.tenant.id, email: s.user.email, planId: s.plan.id, name, idempotencyKey: randomUUID() });
  const order = (await prisma.payment.findUniqueOrThrow({ where: { id: r.payment.id } })).merchantOrderId;
  await pay(order, { amount: PRICE, reference: 'REF-HOST' });
  return r;
};

describe('invoices', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seedBilling(prisma);
    env = makeBilling(prisma, { wallet: true });
  });
  afterAll(() => prisma.$disconnect());

  it('takes the month from Asia/Jakarta time', () => {
    expect(invoicePeriod(new Date('2026-11-30T16:59:59.000Z'))).toBe('2026/11');
    expect(invoicePeriod(new Date('2026-11-30T17:00:00.000Z'))).toBe('2026/12');
  });

  it('issues one invoice per paid top-up and hosting payment, numbered in order, never twice', async () => {
    const { order } = await paidTopup(25_000);
    await paidCheckout();
    // A redelivered webhook and a second paid event with another reference add nothing.
    await pay(order, { amount: 25_000, reference: 'REF-AGAIN' });

    const all = await prisma.invoice.findMany({ orderBy: { number: 'asc' } });
    expect(all.map((i) => [i.number, i.kind, i.amountIdr])).toEqual([
      ['INV/2026/12/0001', 'TOPUP', 25_000],
      ['INV/2026/12/0002', 'HOSTING_NEW', PRICE],
    ]);
    expect(all[1]).toMatchObject({ planName: 'Test small', instanceName: 'My agent', tenantId: s.tenant.id });
  });

  it('starts again at 0001 in a new month', async () => {
    await paidTopup(10_000);
    env.clock.advanceDays(31);
    await paidTopup(10_000);
    const numbers = (await prisma.invoice.findMany({ orderBy: { paidAt: 'asc' } })).map((i) => i.number);
    expect(numbers).toEqual(['INV/2026/12/0001', 'INV/2027/01/0001']);
  });

  it('issues nothing for an amount mismatch or a failed payment', async () => {
    const t = await env.billing.wallet!.startTopup({ tenantId: s.tenant.id, email: s.user.email, amountIdr: 40_000, idempotencyKey: randomUUID() });
    const order = (await prisma.walletTopup.findUniqueOrThrow({ where: { id: t.id } })).merchantOrderId;
    await pay(order, { amount: 400_000 });
    await env.billing.handleSumoPodWebhook({ token: WEBHOOK_TOKEN }, webhookBody({ orderId: order, amount: 40_000, status: 'failed', reference: 'F' }) as Record<string, unknown>);
    expect(await prisma.invoice.count()).toBe(0);
  });

  describe('routes', () => {
    let auth: Awaited<ReturnType<typeof createTestAuth>>;
    beforeAll(async () => { auth = await createTestAuth(); });
    const as = async (email: string) => ({ authorization: `Bearer ${await auth.signToken({ sub: randomUUID(), email, aal: 'aal1' })}` });
    const app = () => buildServer({
      service: env.service, commands: env.commands, logger: silentLogger,
      config: testConfig('hermes-stub:0.2.0', TEST_MASTER_KEY, {
        billing: { sumopod: { apiKey: 'k', webhookToken: WEBHOOK_TOKEN, env: 'sandbox', callbackUrl: 'https://example.test/hook' } },
      }),
      customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
      billing: env.billing,
    });

    it('lists the tenant invoices and shows one with the billed-to address; other tenants get 404', async () => {
      const a = app();
      // A new user gets their own tenant on first sign-in; pay a top-up for that tenant.
      const me = await as('buyer@example.test');
      const { tenantId } = (await a.inject({ method: 'GET', url: '/api/v1/me', headers: me })).json() as { tenantId: string };
      s = { ...s, tenant: await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }) };
      await paidTopup(30_000);

      const list = await a.inject({ method: 'GET', url: '/api/v1/invoices', headers: me });
      expect(list.statusCode).toBe(200);
      const [inv] = list.json().invoices;
      expect(inv).toMatchObject({ number: 'INV/2026/12/0001', kind: 'TOPUP', amountIdr: 30_000 });

      const one = await a.inject({ method: 'GET', url: `/api/v1/invoices/${inv.id}`, headers: me });
      expect(one.statusCode).toBe(200);
      expect(one.json().invoice).toMatchObject({ id: inv.id, billedTo: 'buyer@example.test' });
      expect(one.json().invoice.reference).toMatch(/^REF-/);
      expect(JSON.stringify(one.json())).not.toContain('tenantId');

      expect((await a.inject({ method: 'GET', url: `/api/v1/invoices/${inv.id}`, headers: await as('other@example.test') })).statusCode).toBe(404);
      expect((await a.inject({ method: 'GET', url: '/api/v1/invoices/not-a-uuid', headers: me })).statusCode).toBe(404);
    });
  });
});
