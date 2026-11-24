import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { moveWallet } from '../../src/modules/billing/wallet.js';
import { CapacityFullError, ConflictError, InstanceLimitError, NotFoundError, PaymentProviderUnavailableError, PlanSoldOutError } from '../../src/shared/errors.js';
import { PlanNotForSaleError } from '../../src/modules/billing/billing-service.js';
import { resetDb } from '../helpers/db.js';
import { PRICE, WEBHOOK_TOKEN, makeBilling, makeClock, seedBilling, webhookBody } from '../helpers/billing-env.js';

// Needs Postgres only: the runtime, SumoPod and SMTP are in-memory fakes.
const prisma = createPrisma(process.env.DATABASE_URL!);
let s: Awaited<ReturnType<typeof seedBilling>>;
let env: ReturnType<typeof makeBilling>;

const checkout = (key = randomUUID(), name = 'My agent') =>
  env.billing.checkout({ tenantId: s.tenant.id, email: s.user.email, planId: s.plan.id, name, idempotencyKey: key });

const webhook = (orderId: string, o: { amount?: number; status?: string; reference?: string } = {}, token = WEBHOOK_TOKEN) =>
  env.billing.handleSumoPodWebhook({ token }, webhookBody({ orderId, ...o }));

/** Pays an invoice: delivers an authenticated webhook and runs the post-commit actions. */
async function pay(orderId: string, o: { amount?: number; status?: string; reference?: string } = {}) {
  const r = await webhook(orderId, o);
  if (r.accepted) await r.postActions();
  return r;
}
const orderIdOf = async (paymentId: string) => (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).merchantOrderId;
const counts = async () => ({
  instances: await prisma.instance.count(),
  payments: await prisma.payment.count({ where: { status: 'PAID' } }),
  events: await prisma.paymentEvent.count(),
});

describe('BillingService', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seedBilling(prisma);
    env = makeBilling(prisma);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  describe('checkout', () => {
    it('creates a pending subscription and an invoice, and no instance', async () => {
      const { subscription, payment } = await checkout();
      expect(subscription.status).toBe('PENDING_PAYMENT');
      expect(subscription.instanceId).toBeNull();
      expect(payment.status).toBe('PENDING');
      expect(payment.amountIdr).toBe(PRICE);
      expect(payment.paymentUrl).toMatch(/^https:\/\/sandbox\.sumopod\.test\/pay\/nc-/);
      expect(env.sumopod.invoices).toHaveLength(1);
      expect(env.sumopod.invoices[0]).toMatchObject({ amountIdr: PRICE, email: 'owner@example.test', expiryMinutes: 60 });
      expect(env.sumopod.invoices[0]!.returnUrl).toMatch(/^https:\/\/cloud\.example\.test\/dashboard\/instances\?payment=nc-/);
      expect(env.sumopod.invoices[0]!.merchantOrderId.length).toBeLessThanOrEqual(50);
      expect(await prisma.instance.count()).toBe(0);
    });

    it('replaying the same Idempotency-Key returns the same invoice, without a second SumoPod call', async () => {
      const key = randomUUID();
      const a = await checkout(key);
      const b = await checkout(key);
      expect(b.payment.id).toBe(a.payment.id);
      expect(b.payment.paymentUrl).toBe(a.payment.paymentUrl);
      expect(env.sumopod.invoices).toHaveLength(1);
      expect(await prisma.subscription.count()).toBe(1);
    });

    it('rejects reuse of a key with another name or plan', async () => {
      const key = randomUUID();
      await checkout(key, 'one');
      await expect(checkout(key, 'two')).rejects.toBeInstanceOf(ConflictError);
    });

    it('after the invoice expired, the same key gets a fresh invoice on the same subscription', async () => {
      const key = randomUUID();
      const a = await checkout(key);
      env.clock.advanceDays(1);
      const b = await checkout(key);
      expect(b.subscription.id).toBe(a.subscription.id);
      expect(b.payment.id).not.toBe(a.payment.id);
      expect(env.sumopod.invoices).toHaveLength(2);
    });

    it('refuses a plan without a price, an unknown plan, a bad name', async () => {
      await prisma.plan.update({ where: { id: s.plan.id }, data: { monthlyPriceIdr: null } });
      await expect(checkout()).rejects.toBeInstanceOf(PlanNotForSaleError);
      await prisma.plan.update({ where: { id: s.plan.id }, data: { monthlyPriceIdr: 999 } });
      await expect(checkout()).rejects.toBeInstanceOf(PlanNotForSaleError);
      await expect(env.billing.checkout({ tenantId: s.tenant.id, email: 'a@b.test', planId: randomUUID(), name: 'x', idempotencyKey: 'k' })).rejects.toBeInstanceOf(NotFoundError);
      await prisma.plan.update({ where: { id: s.plan.id }, data: { monthlyPriceIdr: PRICE } });
      await expect(checkout(randomUUID(), '')).rejects.toThrow();
      expect(env.sumopod.invoices).toHaveLength(0);
    });

    it('a new checkout releases the slot of an earlier unpaid one instead of waiting for it to expire', async () => {
      const first = await checkout();
      const second = await checkout();
      expect(second.payment.id).not.toBe(first.payment.id);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: first.payment.id } })).status).toBe('EXPIRED');
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: second.payment.id } })).status).toBe('PENDING');
    });

    it('still applies the per-tenant instance cap to a paid purchase', async () => {
      const { payment } = await checkout();
      await pay(await orderIdOf(payment.id));
      await expect(checkout()).rejects.toBeInstanceOf(InstanceLimitError);
    });

    it('an old invoice that is paid after a newer checkout started is still honored', async () => {
      const first = await checkout();
      await checkout();
      const r = await pay(await orderIdOf(first.payment.id));
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: first.payment.id } })).status).toBe('PAID');
      expect(r).toBeDefined();
    });

    it('refuses a new purchase at the whole-server cap before any invoice exists, and never blocks a paying customer', async () => {
      env = makeBilling(prisma, { maxTotal: 1 });
      const first = await checkout();
      const other = await prisma.tenant.create({ data: { name: 'other' } });
      await expect(env.billing.checkout({ tenantId: other.id, email: 'o@example.test', planId: s.plan.id, name: 'x', idempotencyKey: randomUUID() }))
        .rejects.toBeInstanceOf(CapacityFullError);
      expect(await prisma.subscription.count()).toBe(1);
      expect(env.sumopod.invoices).toHaveLength(1);
      // The first customer, already counted, pays and is fulfilled even though the server is at its cap.
      await pay(await orderIdOf(first.payment.id));
      expect((await prisma.instance.count({ where: { status: 'ACTIVE' } }))).toBe(1);
    });

    it('refuses a new purchase once the plan stock is used, counting open invoices, and never blocks the paying customer', async () => {
      await prisma.plan.update({ where: { id: s.plan.id }, data: { stockLimit: 1 } });
      const first = await checkout();
      const other = await prisma.tenant.create({ data: { name: 'other' } });
      const buy = () => env.billing.checkout({ tenantId: other.id, email: 'o@example.test', planId: s.plan.id, name: 'x', idempotencyKey: randomUUID() });
      // The open invoice holds the only unit.
      await expect(buy()).rejects.toBeInstanceOf(PlanSoldOutError);
      expect(env.sumopod.invoices).toHaveLength(1);
      // The holder pays and is fulfilled; the instance now holds the unit.
      await pay(await orderIdOf(first.payment.id));
      expect(await prisma.instance.count({ where: { status: 'ACTIVE' } })).toBe(1);
      await expect(buy()).rejects.toBeInstanceOf(PlanSoldOutError);
      // Raising the stock (or removing the limit) opens the plan again.
      await prisma.plan.update({ where: { id: s.plan.id }, data: { stockLimit: 2 } });
      await expect(buy()).resolves.toBeDefined();
    });

    it('two buyers racing for the last unit: exactly one gets an invoice', async () => {
      await prisma.plan.update({ where: { id: s.plan.id }, data: { stockLimit: 1 } });
      const other = await prisma.tenant.create({ data: { name: 'other' } });
      const results = await Promise.allSettled([
        checkout(),
        env.billing.checkout({ tenantId: other.id, email: 'o@example.test', planId: s.plan.id, name: 'x', idempotencyKey: randomUUID() }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toBeInstanceOf(PlanSoldOutError);
      expect(await prisma.subscription.count()).toBe(1);
    });

    it('a SumoPod outage answers 503, marks the attempt failed and a retry works', async () => {
      env.sumopod.failNext = true;
      const key = randomUUID();
      await expect(checkout(key)).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
      expect(await prisma.payment.count({ where: { status: 'FAILED' } })).toBe(1);
      const ok = await checkout(key);
      expect(ok.payment.status).toBe('PENDING');
      expect(ok.payment.paymentUrl).not.toBeNull();
    });
  });

  describe('verified payment', () => {
    it('first payment: payment PAID, subscription ACTIVE for 30 days, instance created and ACTIVE, one receipt', async () => {
      const { payment } = await checkout();
      const orderId = await orderIdOf(payment.id);
      const r = await pay(orderId);
      expect(r).toMatchObject({ accepted: true, outcome: 'activated' });
      const sub = await prisma.subscription.findFirstOrThrow({ include: { payments: true } });
      expect(sub.status).toBe('ACTIVE');
      expect(sub.currentPeriodEnd).toEqual(new Date('2026-12-31T00:00:00.000Z'));
      expect(sub.payments[0]!.status).toBe('PAID');
      expect(sub.instanceId).not.toBeNull();
      const inst = await prisma.instance.findUniqueOrThrow({ where: { id: sub.instanceId! } });
      expect(inst.status).toBe('ACTIVE');
      expect(inst.name).toBe('My agent');
      expect(inst.idempotencyKey).toBe(`pay-${orderId}`);
      expect(env.mailer.sent).toHaveLength(1);
      expect(env.mailer.sent[0]!.to).toBe('owner@example.test');
    });

    it('hands the new instance to the router provisioner once, and a router that throws never undoes the payment', async () => {
      const begun: { tenantId: string; instanceId: string; subscriptionId: string | null }[] = [];
      let explode = false;
      env = makeBilling(prisma, { maxInstances: 5, router: { begin: async (i) => { begun.push(i); if (explode) throw new Error('router exploded'); return 'done'; } } });
      const { payment } = await checkout();
      const orderId = await orderIdOf(payment.id);
      await pay(orderId);
      const sub = await prisma.subscription.findFirstOrThrow();
      expect(begun).toEqual([{ tenantId: s.tenant.id, instanceId: sub.instanceId, subscriptionId: sub.id }]);

      await pay(orderId); // the same callback again: no second hand-over
      expect(begun).toHaveLength(1);

      explode = true;
      const second = await checkout(randomUUID(), 'second');
      env.mailer.sent.length = 0;
      const r = await pay(await orderIdOf(second.payment.id), { reference: 'REF-2' });
      expect(r).toMatchObject({ accepted: true });
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: second.payment.id } })).status).toBe('PAID');
      expect(env.mailer.sent).toHaveLength(1); // the receipt still goes out
    });

    it('the same callback twice changes nothing', async () => {
      const { payment } = await checkout();
      const orderId = await orderIdOf(payment.id);
      await pay(orderId);
      const before = await counts();
      const again = await pay(orderId);
      expect(again).toMatchObject({ accepted: true, outcome: 'duplicate' });
      expect(await counts()).toEqual(before);
      expect(env.mailer.sent).toHaveLength(1);
      expect((await prisma.subscription.findFirstOrThrow()).currentPeriodEnd).toEqual(new Date('2026-12-31T00:00:00.000Z'));
    });

    it('a different delivery for an already paid invoice (new reference) is ignored', async () => {
      const { payment } = await checkout();
      const orderId = await orderIdOf(payment.id);
      await pay(orderId);
      const again = await pay(orderId, { reference: 'OTHER-REF' });
      expect(again).toMatchObject({ outcome: 'already_paid' });
      expect(await prisma.instance.count()).toBe(1);
      expect(env.mailer.sent).toHaveLength(1);
    });

    it('two simultaneous identical callbacks activate exactly once', async () => {
      const { payment } = await checkout();
      const orderId = await orderIdOf(payment.id);
      const results = await Promise.all([1, 2, 3].map(() => webhook(orderId)));
      await Promise.all(results.map((r) => (r.accepted ? r.postActions() : undefined)));
      expect(results.filter((r) => r.accepted && r.outcome === 'activated')).toHaveLength(1);
      expect(await prisma.instance.count()).toBe(1);
      expect(env.mailer.sent).toHaveLength(1);
    });

    it('a wrong amount is recorded and ignored', async () => {
      const { payment } = await checkout();
      const orderId = await orderIdOf(payment.id);
      const r = await pay(orderId, { amount: 10_000 });
      expect(r).toMatchObject({ accepted: true, outcome: 'amount_mismatch' });
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('PENDING');
      expect(await prisma.instance.count()).toBe(0);
      expect((await prisma.paymentEvent.findFirstOrThrow()).outcome).toBe('amount_mismatch');
    });

    it.each(['failed', 'expired', 'cancelled'])('status %s marks the payment failed and activates nothing', async (status) => {
      const { payment } = await checkout();
      const r = await pay(await orderIdOf(payment.id), { status });
      expect(r).toMatchObject({ accepted: true, outcome: 'failed' });
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('FAILED');
      expect((await prisma.subscription.findFirstOrThrow()).status).toBe('PENDING_PAYMENT');
      expect(await prisma.instance.count()).toBe(0);
    });

    it('a failure callback never downgrades a paid invoice', async () => {
      const { payment } = await checkout();
      const orderId = await orderIdOf(payment.id);
      await pay(orderId);
      const r = await pay(orderId, { status: 'failed' });
      expect(r).toMatchObject({ outcome: 'ignored_failure' });
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('PAID');
      expect((await prisma.subscription.findFirstOrThrow()).status).toBe('ACTIVE');
    });

    it('a paid invoice that was already marked expired is still honored', async () => {
      const { payment } = await checkout();
      await prisma.payment.update({ where: { id: payment.id }, data: { status: 'EXPIRED' } });
      const r = await pay(await orderIdOf(payment.id));
      expect(r).toMatchObject({ outcome: 'activated' });
      expect(await prisma.instance.count()).toBe(1);
    });

    it('unknown order id with a valid signature is accepted (so SumoPod stops retrying) and changes nothing', async () => {
      const r = await pay('nc-doesnotexist');
      expect(r).toMatchObject({ accepted: true, outcome: 'unknown_order' });
      expect(await counts()).toEqual({ instances: 0, payments: 0, events: 1 });
    });

    it.each([
      ['wrong token', 'not-the-webhook-token'],
      ['missing token', ''],
    ])('%s is not accepted and records nothing', async (_l, token) => {
      const { payment } = await checkout();
      expect(await webhook(await orderIdOf(payment.id), {}, token)).toEqual({ accepted: false });
      expect(await counts()).toEqual({ instances: 0, payments: 0, events: 0 });
    });

    it('a crash after commit leaves a paid subscription without an instance, which ensureInstance repairs once', async () => {
      const { payment } = await checkout();
      const orderId = await orderIdOf(payment.id);
      const r = await webhook(orderId); // postActions deliberately not run
      expect(r).toMatchObject({ outcome: 'activated' });
      const sub = await prisma.subscription.findFirstOrThrow();
      expect(sub.status).toBe('ACTIVE');
      expect(sub.instanceId).toBeNull();
      await env.billing.ensureInstance(sub.id);
      await env.billing.ensureInstance(sub.id);
      expect(await prisma.instance.count()).toBe(1);
      expect((await prisma.subscription.findFirstOrThrow()).instanceId).not.toBeNull();
    });

    it('a mail outage does not undo the activation', async () => {
      env.mailer.failNext = true;
      const { payment } = await checkout();
      await pay(await orderIdOf(payment.id));
      expect((await prisma.subscription.findFirstOrThrow()).status).toBe('ACTIVE');
      expect(await prisma.instance.count()).toBe(1);
    });
  });

  describe('renewal and cancel', () => {
    async function active() {
      const { payment, subscription } = await checkout();
      await pay(await orderIdOf(payment.id));
      return subscription.id;
    }

    it('renewing while active extends from the current end, once, even when the button is pressed twice', async () => {
      const id = await active();
      env.clock.advanceDays(10);
      const a = await env.billing.renew({ tenantId: s.tenant.id, email: s.user.email, subscriptionId: id });
      const b = await env.billing.renew({ tenantId: s.tenant.id, email: s.user.email, subscriptionId: id });
      expect(b.payment.id).toBe(a.payment.id);
      expect(a.payment.purpose).toBe('RENEWAL');
      await pay(await orderIdOf(a.payment.id), { reference: 'REF-R' });
      const sub = await prisma.subscription.findUniqueOrThrow({ where: { id } });
      expect(sub.currentPeriodEnd).toEqual(new Date('2027-01-30T00:00:00.000Z'));
      expect(await prisma.instance.count()).toBe(1);
    });

    it('renewing a suspended subscription restarts the stopped instance and clears the suspension', async () => {
      const id = await active();
      const sub = await prisma.subscription.findUniqueOrThrow({ where: { id } });
      await env.commands.stop(s.tenant.id, sub.instanceId!);
      env.clock.advanceDays(40);
      await prisma.subscription.update({
        where: { id }, data: { status: 'SUSPENDED', suspendedAt: env.clock.now, retentionEndsAt: new Date(env.clock.now.getTime() + 30 * 86_400_000) },
      });
      const r = await env.billing.renew({ tenantId: s.tenant.id, email: s.user.email, subscriptionId: id });
      await pay(await orderIdOf(r.payment.id), { reference: 'REF-R' });
      const after = await prisma.subscription.findUniqueOrThrow({ where: { id } });
      expect(after.status).toBe('ACTIVE');
      expect(after.suspendedAt).toBeNull();
      expect(after.retentionEndsAt).toBeNull();
      expect(after.currentPeriodEnd).toEqual(new Date(env.clock.now.getTime() + 30 * 86_400_000));
      expect((await prisma.instance.findUniqueOrThrow({ where: { id: sub.instanceId! } })).status).toBe('ACTIVE');
    });

    it('cancel schedules non-renewal and paying again clears it', async () => {
      const id = await active();
      const c = await env.billing.cancel(s.tenant.id, id);
      expect(c.cancelAtPeriodEnd).toBe(true);
      expect(c.status).toBe('ACTIVE');
      const r = await env.billing.renew({ tenantId: s.tenant.id, email: s.user.email, subscriptionId: id });
      await pay(await orderIdOf(r.payment.id), { reference: 'REF-R' });
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id } })).cancelAtPeriodEnd).toBe(false);
    });

    it('refuses to renew or cancel a purchase that was never paid, or an ended subscription', async () => {
      const { subscription } = await checkout();
      await expect(env.billing.renew({ tenantId: s.tenant.id, email: s.user.email, subscriptionId: subscription.id })).rejects.toMatchObject({ code: 'subscription_not_renewable' });
      await expect(env.billing.cancel(s.tenant.id, subscription.id)).rejects.toMatchObject({ code: 'subscription_not_cancellable' });
      await prisma.subscription.update({ where: { id: subscription.id }, data: { status: 'ENDED' } });
      await expect(env.billing.renew({ tenantId: s.tenant.id, email: s.user.email, subscriptionId: subscription.id })).rejects.toMatchObject({ code: 'subscription_not_renewable' });
    });

    it('a payment that arrives after the subscription ended is recorded loudly and does not resurrect it', async () => {
      const id = await active();
      const r = await env.billing.renew({ tenantId: s.tenant.id, email: s.user.email, subscriptionId: id });
      await prisma.subscription.update({ where: { id }, data: { status: 'ENDED' } });
      const out = await pay(await orderIdOf(r.payment.id), { reference: 'REF-R' });
      expect(out).toMatchObject({ outcome: 'paid_after_end' });
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id } })).status).toBe('ENDED');
    });

    it('renewal of a Kredit plan creates one PENDING credit grant keyed on the payment', async () => {
      await prisma.plan.update({ where: { id: s.plan.id }, data: { slug: 'hosting-kredit', includedCreditNano: 2_000_000_000n } });
      const id = await active();
      const r = await env.billing.renew({ tenantId: s.tenant.id, email: s.user.email, subscriptionId: id });
      await pay(await orderIdOf(r.payment.id), { reference: 'REF-R-KREDIT' });
      const grants = await prisma.creditGrant.findMany({ where: { paymentId: { not: null } } });
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({
        tenantId: s.tenant.id,
        paymentId: r.payment.id,
        amountNano: 2_000_000_000n,
        subscriptionId: null,
        status: 'PENDING',
      });
    });

    it('renewal of a plan without credit creates no grant', async () => {
      const id = await active();
      const r = await env.billing.renew({ tenantId: s.tenant.id, email: s.user.email, subscriptionId: id });
      await pay(await orderIdOf(r.payment.id), { reference: 'REF-R-NOCREDIT' });
      expect(await prisma.creditGrant.count({ where: { paymentId: { not: null } } })).toBe(0);
    });

    it('wallet auto-renew of a Kredit plan grants the credit', async () => {
      env = makeBilling(prisma, { wallet: true });
      await prisma.plan.update({ where: { id: s.plan.id }, data: { slug: 'hosting-kredit', includedCreditNano: 2_000_000_000n } });
      const id = await active();
      await prisma.$transaction((tx) => moveWallet(tx, { tenantId: s.tenant.id, amountIdr: PRICE, kind: 'ADMIN_CREDIT', refId: randomUUID() }));
      env.clock.advanceDays(29.5);
      expect(await env.billing.autoRenew(id, env.clock.now)).toBe(true);
      const grants = await prisma.creditGrant.findMany({ where: { paymentId: { not: null } } });
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({
        tenantId: s.tenant.id,
        amountNano: 2_000_000_000n,
        subscriptionId: null,
        status: 'PENDING',
      });
    });

    it('renewal paid by wallet then by QRIS grants once', async () => {
      env = makeBilling(prisma, { wallet: true });
      await prisma.plan.update({ where: { id: s.plan.id }, data: { slug: 'hosting-kredit', includedCreditNano: 2_000_000_000n } });
      const id = await active();
      await prisma.$transaction((tx) => moveWallet(tx, { tenantId: s.tenant.id, amountIdr: PRICE, kind: 'ADMIN_CREDIT', refId: randomUUID() }));
      const r = await env.billing.renew({ tenantId: s.tenant.id, email: s.user.email, subscriptionId: id });
      await env.billing.payWithWallet(s.tenant.id, r.payment.id);
      const cb = await pay(await orderIdOf(r.payment.id), { reference: 'REF-R-QRIS-DUP' });
      expect(cb).toMatchObject({ accepted: true, outcome: 'credited_to_wallet' });
      const grants = await prisma.creditGrant.findMany({ where: { paymentId: { not: null } } });
      expect(grants).toHaveLength(1);
      expect(grants[0]!.paymentId).toBe(r.payment.id);
    });

    it('payment for an ended subscription grants nothing', async () => {
      await prisma.plan.update({ where: { id: s.plan.id }, data: { slug: 'hosting-kredit', includedCreditNano: 2_000_000_000n } });
      const id = await active();
      const r = await env.billing.renew({ tenantId: s.tenant.id, email: s.user.email, subscriptionId: id });
      await prisma.subscription.update({ where: { id }, data: { status: 'ENDED' } });
      const out = await pay(await orderIdOf(r.payment.id), { reference: 'REF-R-ENDED' });
      expect(out).toMatchObject({ outcome: 'paid_after_end' });
      expect(await prisma.creditGrant.count({ where: { paymentId: { not: null } } })).toBe(0);
    });
  });

  describe('tenant isolation', () => {
    it('another tenant gets 404 for subscriptions and payments', async () => {
      const { subscription, payment } = await checkout();
      await expect(env.billing.get(s.other.id, subscription.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(env.billing.getPayment(s.other.id, payment.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(env.billing.cancel(s.other.id, subscription.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(env.billing.renew({ tenantId: s.other.id, email: 'x@y.test', subscriptionId: subscription.id })).rejects.toBeInstanceOf(NotFoundError);
      expect(await env.billing.list(s.other.id)).toEqual([]);
      expect(await env.billing.list(s.tenant.id)).toHaveLength(1);
    });

    it('views never expose the provider reference or order id', async () => {
      const { subscription, payment } = await checkout();
      const json = JSON.stringify({ subscription, payment, list: await env.billing.list(s.tenant.id) });
      expect(json).not.toContain('REF-');
      expect(json).not.toContain('merchantOrderId');
    });
  });

  it('the per-tenant cap does not block a paid subscription from being fulfilled', async () => {
    const e = makeBilling(prisma, { clock: makeClock(), maxInstances: 1 });
    env = e;
    const { payment } = await checkout();
    await pay(await orderIdOf(payment.id));
    expect(await prisma.instance.count()).toBe(1);
  });
});
