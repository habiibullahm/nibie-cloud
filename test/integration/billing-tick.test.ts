import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { BillingTick } from '../../src/modules/billing/billing-tick.js';
import { Reconciler } from '../../src/modules/instances/reconciler.js';
import { resetDb } from '../helpers/db.js';
import { callbackForm, makeBilling, seedBilling } from '../helpers/billing-env.js';
import { TEST_MASTER_KEY } from '../helpers/service-env.js';

// Needs Postgres only: runtime, Duitku and SMTP are in-memory fakes, and the clock is injected.
const prisma = createPrisma(process.env.DATABASE_URL!);
let s: Awaited<ReturnType<typeof seedBilling>>;
let env: ReturnType<typeof makeBilling>;
let tick: BillingTick;

const kinds = () => env.mailer.sent.map((m) => m.subject);
const sub = () => prisma.subscription.findFirstOrThrow({ include: { instance: true } });

/** Checkout and pay at the current clock time: an ACTIVE subscription with a running instance. */
async function activate() {
  const { payment } = await env.billing.checkout({ tenantId: s.tenant.id, email: s.user.email, planId: s.plan.id, name: 'agent', idempotencyKey: randomUUID() });
  const orderId = (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).merchantOrderId;
  const r = await env.billing.handleCallback(callbackForm({ orderId }));
  if (r.accepted) await r.postActions();
  env.mailer.sent.length = 0; // forget the receipt
}
const at = async (days: number) => {
  env.clock.now = new Date(new Date('2026-12-01T00:00:00.000Z').getTime() + days * 86_400_000);
  return tick.runOnce();
};

describe('BillingTick', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "BillingNotice" CASCADE');
    s = await seedBilling(prisma);
    env = makeBilling(prisma);
    tick = new BillingTick({ prisma, billing: env.billing, commands: env.commands, mailer: env.mailer, logger: env.logger, now: () => env.clock.now });
    await activate();
  });
  afterAll(() => prisma.$disconnect());

  it('sends the 7, 3 and 1 day reminders once each, however often it runs', async () => {
    for (const d of [10, 22, 23, 23.1, 24, 26, 27, 27.5, 28, 29, 29.2, 29.9]) await at(d);
    expect(kinds()).toEqual([
      'Langganan berakhir 7 hari lagi - NibieCloud',
      'Langganan berakhir 3 hari lagi - NibieCloud',
      'Langganan berakhir 1 hari lagi - NibieCloud',
    ]);
    expect(env.mailer.sent.every((m) => m.to === 'owner@example.test')).toBe(true);
  });

  it('after downtime sends only the current reminder, not a backlog', async () => {
    await at(29.5);
    expect(kinds()).toEqual(['Langganan berakhir 1 hari lagi - NibieCloud']);
  });

  it('a renewal resets the reminders for the new period', async () => {
    await at(23);
    const r = await env.billing.renew({ tenantId: s.tenant.id, email: s.user.email, subscriptionId: (await sub()).id });
    const orderId = (await prisma.payment.findUniqueOrThrow({ where: { id: r.payment.id } })).merchantOrderId;
    const cb = await env.billing.handleCallback(callbackForm({ orderId, reference: 'REF-R' }));
    if (cb.accepted) await cb.postActions();
    env.mailer.sent.length = 0;
    await at(23.5); // old period would have had its 3-day reminder soon; the new one ends at day 60
    await at(40);
    expect(kinds()).toEqual([]);
    await at(53);
    expect(kinds()).toEqual(['Langganan berakhir 7 hari lagi - NibieCloud']);
  });

  it('expiry: ACTIVE becomes GRACE, the instance keeps running, one email', async () => {
    const sum = await at(30.1);
    expect(sum.graced).toBe(1);
    const row = await sub();
    expect(row.status).toBe('GRACE');
    expect(row.graceEndsAt).toEqual(new Date('2027-01-03T00:00:00.000Z'));
    expect(row.instance!.status).toBe('ACTIVE');
    await at(30.2);
    expect(kinds()).toEqual(['Masa tenggang dimulai - NibieCloud']);
  });

  it('grace over: SUSPENDED, the instance is stopped and its volume kept, with a warning the day before', async () => {
    await at(30.1);
    await at(32.1);
    expect(kinds()).toContain('Instance akan dihentikan besok - NibieCloud');
    const sum = await at(33.1);
    expect(sum.suspended).toBe(1);
    const row = await sub();
    expect(row.status).toBe('SUSPENDED');
    expect(row.retentionEndsAt).toEqual(new Date(env.clock.now.getTime() + 30 * 86_400_000));
    expect(row.instance!.status).toBe('STOPPED');
    expect(kinds().at(-1)).toBe('Instance dihentikan - NibieCloud');
    expect(await prisma.instanceEvent.count({ where: { type: 'billing.suspended' } })).toBe(1);
  });

  it('the reconciler does not restart a suspended instance', async () => {
    await at(33.1);
    await at(33.2);
    const rec = new Reconciler({ prisma, runtime: env.runtime, logger: env.logger, pollIntervalMs: 20, healthTimeoutMs: 300, masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off', containerRuntime: 'runc' });
    await rec.reconcileAll();
    expect((await sub()).instance!.status).toBe('STOPPED');
  });

  it('retention over: the instance is deleted, the subscription ended, one final notice', async () => {
    await at(33.1);
    await at(56.5);
    expect(kinds()).toContain('Data akan dihapus permanen - NibieCloud');
    const sum = await at(64);
    expect(sum.ended).toBe(1);
    const row = await sub();
    expect(row.status).toBe('ENDED');
    expect(row.instance!.status).toBe('DELETED');
    expect(kinds().at(-1)).toBe('Instance dihapus - NibieCloud');
    await at(65);
    expect(kinds().filter((k) => k === 'Instance dihapus - NibieCloud')).toHaveLength(1);
    expect(await prisma.instanceEvent.count({ where: { type: 'billing.retention_elapsed' } })).toBe(1);
  });

  it('a cancelled subscription gets no renewal reminders but follows the same path after the period', async () => {
    await env.billing.cancel(s.tenant.id, (await sub()).id);
    await at(29.5);
    expect(kinds()).toEqual([]);
    await at(30.1);
    expect(kinds()).toEqual(['Masa tenggang dimulai - NibieCloud']);
  });

  it('a payment that lands between reads wins over the tick (compare-and-set)', async () => {
    const id = (await sub()).id;
    env.clock.now = new Date('2026-12-31T00:00:00.000Z');
    const stale = await prisma.subscription.findUniqueOrThrow({ where: { id } });
    // The payment extends the period before the tick's update runs.
    await prisma.subscription.update({ where: { id }, data: { currentPeriodEnd: new Date('2027-01-30T00:00:00.000Z') } });
    const cas = await prisma.subscription.updateMany({ where: { id, status: 'ACTIVE', currentPeriodEnd: stale.currentPeriodEnd }, data: { status: 'GRACE' } });
    expect(cas.count).toBe(0);
    expect((await tick.runOnce()).graced).toBe(0);
    expect((await sub()).status).toBe('ACTIVE');
  });

  it('a busy instance is skipped and stopped on a later tick', async () => {
    const row = await sub();
    await prisma.instance.update({ where: { id: row.instanceId! }, data: { status: 'STARTING' } });
    await at(33.1);
    expect((await sub()).status).toBe('SUSPENDED');
    expect((await sub()).instance!.status).toBe('STARTING');
    await prisma.instance.update({ where: { id: row.instanceId! }, data: { status: 'ACTIVE' } });
    await at(33.2);
    expect((await sub()).instance!.status).toBe('STOPPED');
  });

  it('two ticks at once change a subscription and send an email once', async () => {
    env.clock.now = new Date('2026-12-31T01:00:00.000Z');
    const [a, b] = await Promise.all([tick.runOnce(), tick.runOnce()]);
    expect(a.graced + b.graced).toBe(1);
    expect(kinds()).toEqual(['Masa tenggang dimulai - NibieCloud']);
  });

  it('mail not configured: transitions still happen, nothing is recorded as sent, and the current notice goes out once mail works', async () => {
    env.mailer.enabled = false;
    await at(30.1);
    expect((await sub()).status).toBe('GRACE');
    expect(await prisma.billingNotice.count()).toBe(0);
    env.mailer.enabled = true;
    await at(30.2);
    expect(kinds()).toEqual(['Masa tenggang dimulai - NibieCloud']);
  });

  it('a mail failure releases the claim and the next tick retries', async () => {
    env.mailer.failNext = true;
    await at(30.1);
    expect(await prisma.billingNotice.count()).toBe(0);
    await at(30.2);
    expect(kinds()).toEqual(['Masa tenggang dimulai - NibieCloud']);
    expect(await prisma.billingNotice.count()).toBe(1);
  });

  it('expires unpaid invoices and closes abandoned purchases after 7 days', async () => {
    const other = makeBilling(prisma, { clock: env.clock, maxInstances: 5 });
    const { subscription } = await other.billing.checkout({ tenantId: s.other.id, email: 'x@example.test', planId: s.plan.id, name: 'later', idempotencyKey: randomUUID() });
    // Rows are stamped by the database clock; pin the creation time to the injected one.
    await prisma.subscription.update({ where: { id: subscription.id }, data: { createdAt: env.clock.now } });
    const sum = await at(0.1);
    expect(sum.expiredPayments).toBe(1);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).status).toBe('PENDING_PAYMENT');
    const later = await at(8);
    expect(later.abandoned).toBe(1);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).status).toBe('ENDED');
  });

  it('repairs a paid subscription whose instance was never created (crash after commit)', async () => {
    await resetDb(prisma);
    s = await seedBilling(prisma);
    env = makeBilling(prisma);
    tick = new BillingTick({ prisma, billing: env.billing, commands: env.commands, mailer: env.mailer, logger: env.logger, now: () => env.clock.now });
    const { payment } = await env.billing.checkout({ tenantId: s.tenant.id, email: s.user.email, planId: s.plan.id, name: 'agent', idempotencyKey: randomUUID() });
    await env.billing.handleCallback(callbackForm({ orderId: (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).merchantOrderId })); // postActions never run
    expect((await sub()).instanceId).toBeNull();
    const sum = await tick.runOnce();
    expect(sum.repaired).toBe(1);
    expect((await sub()).instance!.status).toBe('ACTIVE');
    await tick.runOnce();
    expect(await prisma.instance.count()).toBe(1);
  });

  it('repairs a reinstated subscription whose instance was never restarted', async () => {
    await at(33.1);
    expect((await sub()).instance!.status).toBe('STOPPED');
    const r = await env.billing.renew({ tenantId: s.tenant.id, email: s.user.email, subscriptionId: (await sub()).id });
    const cb = await env.billing.handleCallback(callbackForm({ orderId: (await prisma.payment.findUniqueOrThrow({ where: { id: r.payment.id } })).merchantOrderId, reference: 'REF-R' }));
    expect(cb).toMatchObject({ outcome: 'activated' }); // crash: postActions never run
    expect((await sub()).restartPending).toBe(true);
    await tick.runOnce();
    const row = await sub();
    expect(row.restartPending).toBe(false);
    expect(row.instance!.status).toBe('ACTIVE');
  });

  it('ends the subscription quietly when the instance was deleted elsewhere', async () => {
    const row = await sub();
    await env.commands.delete(s.tenant.id, row.instanceId!);
    await at(25);
    expect((await sub()).status).toBe('ENDED');
    expect(kinds()).toEqual([]);
  });

  it('run() is throttled and never throws', async () => {
    const t = new BillingTick({ prisma, billing: env.billing, commands: env.commands, mailer: env.mailer, logger: env.logger, now: () => env.clock.now, minIntervalMs: 60_000 });
    expect(await t.run()).not.toBeNull();
    expect(await t.run()).toBeNull();
  });
});
