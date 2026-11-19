import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { IdentityService } from '../../src/modules/auth/identity-service.js';
import { BillingTick } from '../../src/modules/billing/billing-tick.js';
import { moveWallet } from '../../src/modules/billing/wallet.js';
import { createTestAuth, testConfig } from '../helpers/auth.js';
import { PRICE, WEBHOOK_TOKEN, makeBilling, seedBilling, webhookBody } from '../helpers/billing-env.js';
import { resetDb } from '../helpers/db.js';
import { TEST_MASTER_KEY, silentLogger } from '../helpers/service-env.js';

// Part 2 of the wallet: paying hosting invoices from the balance, and auto-renew from it.

const prisma = createPrisma(process.env.DATABASE_URL!);
const DAY = 86_400_000;
let env: ReturnType<typeof makeBilling>;
let s: Awaited<ReturnType<typeof seedBilling>>;

const balance = async () => (await prisma.wallet.findUnique({ where: { tenantId: s.tenant.id } }))?.balanceIdr ?? 0;
const credit = (amountIdr: number) =>
  prisma.$transaction((tx) => moveWallet(tx, { tenantId: s.tenant.id, amountIdr, kind: 'ADMIN_CREDIT', refId: randomUUID() }));
const checkout = () =>
  env.billing.checkout({ tenantId: s.tenant.id, email: s.user.email, planId: s.plan.id, name: 'My agent', idempotencyKey: randomUUID() });
const orderOf = async (paymentId: string) => (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).merchantOrderId;
const payQris = async (paymentId: string, reference = 'REF-Q') =>
  env.billing.handleSumoPodWebhook({ token: WEBHOOK_TOKEN }, webhookBody({ orderId: await orderOf(paymentId), amount: PRICE, reference }) as Record<string, unknown>);
const tick = (autoRenew: boolean) =>
  new BillingTick({ prisma, billing: env.billing, commands: env.commands, mailer: env.mailer, logger: silentLogger, now: () => env.clock.now, autoRenew }).runOnce();
/** A paid, active subscription (first payment by QRIS). */
const active = async () => {
  const r = await checkout();
  const out = await payQris(r.payment.id, 'REF-FIRST');
  if (out.accepted) await out.postActions();
  return prisma.subscription.findUniqueOrThrow({ where: { id: r.subscription.id } });
};

describe('wallet payments', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seedBilling(prisma);
    env = makeBilling(prisma, { wallet: true });
  });
  afterAll(() => prisma.$disconnect());

  describe('pay with wallet', () => {
    it('pays a purchase from the balance: active, invoice, instance, receipt', async () => {
      await credit(PRICE + 5_000);
      const r = await checkout();
      const out = await env.billing.payWithWallet(s.tenant.id, r.payment.id);
      expect(out.subscription.status).toBe('ACTIVE');
      expect(out.payment).toMatchObject({ status: 'PAID', method: 'WALLET' });
      await out.postActions();

      expect(await balance()).toBe(5_000);
      expect(await prisma.walletEntry.findFirstOrThrow({ where: { kind: 'HOSTING' } })).toMatchObject({ amountIdr: -PRICE, refId: r.payment.id });
      expect(await prisma.invoice.findFirstOrThrow({ where: { paymentId: r.payment.id } })).toMatchObject({ kind: 'HOSTING_NEW', amountIdr: PRICE });
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: r.subscription.id } })).instanceId).not.toBeNull();
      expect(env.mailer.sent.at(-1)?.subject).toMatch(/Pembayaran/);
    });

    it('refuses a short balance and changes nothing', async () => {
      await credit(PRICE - 1);
      const r = await checkout();
      await expect(env.billing.payWithWallet(s.tenant.id, r.payment.id)).rejects.toMatchObject({ code: 'insufficient_balance' });
      expect(await balance()).toBe(PRICE - 1);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: r.payment.id } })).status).toBe('PENDING');
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: r.subscription.id } })).status).toBe('PENDING_PAYMENT');
      expect(await prisma.invoice.count()).toBe(0);
    });

    it('refuses an expired invoice, one already paid by QRIS, and another tenant\'s invoice', async () => {
      await credit(PRICE * 3);
      const late = await checkout();
      env.clock.advanceDays(1);
      await expect(env.billing.payWithWallet(s.tenant.id, late.payment.id)).rejects.toMatchObject({ code: 'payment_not_payable' });

      const r = await checkout();
      await payQris(r.payment.id);
      await expect(env.billing.payWithWallet(s.tenant.id, r.payment.id)).rejects.toMatchObject({ code: 'payment_not_payable' });
      await expect(env.billing.payWithWallet(s.other.id, r.payment.id)).rejects.toMatchObject({ code: 'not_found' });
      expect(await balance()).toBe(PRICE * 3);
    });

    it('puts a QRIS payment of an invoice already paid from the wallet back into the wallet, once', async () => {
      await credit(PRICE);
      const r = await checkout();
      await env.billing.payWithWallet(s.tenant.id, r.payment.id);
      const end = (await prisma.subscription.findUniqueOrThrow({ where: { id: r.subscription.id } })).currentPeriodEnd;
      expect(await balance()).toBe(0);

      expect(await payQris(r.payment.id)).toMatchObject({ accepted: true, outcome: 'credited_to_wallet' });
      expect(await payQris(r.payment.id)).toMatchObject({ outcome: 'duplicate' });
      expect(await payQris(r.payment.id, 'REF-OTHER')).toMatchObject({ outcome: 'already_paid' });
      expect(await balance()).toBe(PRICE);
      // The period was bought once, not twice.
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: r.subscription.id } })).currentPeriodEnd).toEqual(end);
    });

    it('renews from the wallet: 30 more days from the end of the period', async () => {
      const sub = await active();
      await credit(PRICE);
      const r = await env.billing.renew({ tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id });
      const out = await env.billing.payWithWallet(s.tenant.id, r.payment.id);
      expect(new Date(out.subscription.currentPeriodEnd!).getTime()).toBe(sub.currentPeriodEnd!.getTime() + 30 * DAY);
      expect(await prisma.invoice.findFirstOrThrow({ where: { paymentId: r.payment.id } })).toMatchObject({ kind: 'HOSTING_RENEWAL' });
    });
  });

  describe('auto-renew', () => {
    it('renews once in the last day of the period, and expires an open QRIS renewal invoice', async () => {
      const sub = await active();
      await credit(PRICE * 2);
      const open = await env.billing.renew({ tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id });
      env.clock.advanceDays(29.5);

      const first = await tick(true);
      expect(first.autoRenewed).toBe(1);
      const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(after).toMatchObject({ status: 'ACTIVE' });
      expect(after.currentPeriodEnd!.getTime()).toBe(sub.currentPeriodEnd!.getTime() + 30 * DAY);
      expect(await balance()).toBe(PRICE);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: open.payment.id } })).status).toBe('EXPIRED');
      expect(await prisma.walletEntry.count({ where: { kind: 'AUTO_RENEW' } })).toBe(1);

      // The next ticks find the new period far away: no second charge.
      expect((await tick(true)).autoRenewed).toBe(0);
      expect(await balance()).toBe(PRICE);
    });

    it('does nothing too early, without enough balance, when switched off, or with the env flag off', async () => {
      const sub = await active();
      await credit(PRICE);
      env.clock.advanceDays(27);
      expect((await tick(true)).autoRenewed).toBe(0); // 3 days left: too early

      env.clock.advanceDays(2.5);
      expect((await tick(false)).autoRenewed).toBe(0); // env flag off
      await env.billing.setAutoRenew(s.tenant.id, sub.id, false);
      expect((await tick(true)).autoRenewed).toBe(0); // customer switched it off
      await env.billing.setAutoRenew(s.tenant.id, sub.id, true);
      await prisma.$transaction((tx) => moveWallet(tx, { tenantId: s.tenant.id, amountIdr: -1, kind: 'ADMIN_DEBIT', refId: randomUUID() }));
      expect((await tick(true)).autoRenewed).toBe(0); // short by Rp 1
      expect(await prisma.payment.count({ where: { method: 'WALLET' } })).toBe(0);
    });

    it('renews a subscription that already went into grace', async () => {
      const sub = await active();
      env.clock.advanceDays(31);
      await tick(false);
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe('GRACE');
      await credit(PRICE);
      expect((await tick(true)).autoRenewed).toBe(1);
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe('ACTIVE');
    });
  });

  describe('routes', () => {
    let auth: Awaited<ReturnType<typeof createTestAuth>>;
    beforeAll(async () => { auth = await createTestAuth(); });
    const app = (walletEnabled: boolean) => buildServer({
      service: env.service, commands: env.commands, logger: silentLogger,
      config: testConfig('hermes-stub:0.2.0', TEST_MASTER_KEY, {
        walletEnabled,
        billing: { sumopod: { apiKey: 'k', webhookToken: WEBHOOK_TOKEN, env: 'sandbox', callbackUrl: 'https://example.test/hook' } },
      }),
      customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
      billing: env.billing,
    });

    it('pays with the wallet and toggles auto-renew; 404 when the wallet is off', async () => {
      const me = { authorization: `Bearer ${await auth.signToken({ sub: randomUUID(), email: 'buyer@example.test', aal: 'aal1' })}` };
      const a = app(true);
      const { tenantId } = (await a.inject({ method: 'GET', url: '/api/v1/me', headers: me })).json() as { tenantId: string };
      s = { ...s, tenant: await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }) };
      await credit(PRICE);
      const r = await checkout();

      const paid = await a.inject({ method: 'POST', url: `/api/v1/payments/${r.payment.id}/pay-with-wallet`, headers: me });
      expect(paid.statusCode).toBe(200);
      expect(paid.json().subscription).toMatchObject({ status: 'ACTIVE', autoRenew: true });
      const again = await a.inject({ method: 'POST', url: `/api/v1/payments/${r.payment.id}/pay-with-wallet`, headers: me });
      expect(again.statusCode).toBe(409);

      const off = await a.inject({ method: 'POST', url: `/api/v1/subscriptions/${r.subscription.id}/auto-renew`, headers: me, payload: { enabled: false } });
      expect(off.json().subscription.autoRenew).toBe(false);

      env = makeBilling(prisma, { wallet: false });
      expect((await app(false).inject({ method: 'POST', url: `/api/v1/payments/${r.payment.id}/pay-with-wallet`, headers: me })).statusCode).toBe(404);
    });
  });
});
