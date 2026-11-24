import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { BillingTick } from '../../src/modules/billing/billing-tick.js';
import { NotFoundError } from '../../src/shared/errors.js';
import { resetDb } from '../helpers/db.js';
import { WEBHOOK_TOKEN, makeBilling, seedBilling, webhookBody } from '../helpers/billing-env.js';

// Upgrading a free instance to a paid plan. Needs Postgres only: the runtime, SumoPod and SMTP are in-memory fakes.
const prisma = createPrisma(process.env.DATABASE_URL!);
let s: Awaited<ReturnType<typeof seedBilling>>;
let env: ReturnType<typeof makeBilling>;
let routerCalls: Array<{ tenantId: string; instanceId: string; subscriptionId: string | null }>;
let freeInstanceId: string;

const upgrade = (key: string = randomUUID(), instanceId = freeInstanceId, tenantId = s.tenant.id) =>
  env.billing.upgrade({ tenantId, email: s.user.email, instanceId, planId: s.plan.id, idempotencyKey: key });

async function pay(paymentId: string) {
  const { merchantOrderId } = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const r = await env.billing.handleSumoPodWebhook({ token: WEBHOOK_TOKEN }, webhookBody({ orderId: merchantOrderId }));
  if (r.accepted) await r.postActions();
  return r;
}

describe('BillingService.upgrade', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seedBilling(prisma);
    routerCalls = [];
    env = makeBilling(prisma, { router: { begin: async (x) => { routerCalls.push(x); return 'done'; } } });
    const free = await prisma.plan.create({
      data: { slug: 'free', name: 'Free', cpuMillis: 500, memoryMb: 256, pids: 128, storageMb: 1024, monthlyPriceIdr: null },
    });
    const { instance } = await env.commands.provision({ tenantId: s.tenant.id, name: 'free-agent', planId: free.id, idempotencyKey: 'free-1' });
    freeInstanceId = instance.id;
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('opens an invoice for the existing instance, which keeps its plan until paid', async () => {
    const { subscription, payment } = await upgrade();
    expect(subscription).toMatchObject({ status: 'PENDING_PAYMENT', instanceId: freeInstanceId, planId: s.plan.id, name: 'free-agent' });
    expect(payment.purpose).toBe('NEW');
    expect(env.sumopod.invoices[0]!.returnUrl).toMatch(new RegExp(`/dashboard/instances/${freeInstanceId}/billing\\?payment=nc-`));
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: freeInstanceId } })).planId).not.toBe(s.plan.id);
  });

  it('a verified payment moves the same instance onto the paid plan and links the router credit', async () => {
    const before = await prisma.instance.findUniqueOrThrow({ where: { id: freeInstanceId } });
    const { subscription, payment } = await upgrade();
    const r = await pay(payment.id);
    expect(r).toMatchObject({ accepted: true, outcome: 'activated' });

    const after = await prisma.instance.findUniqueOrThrow({ where: { id: freeInstanceId } });
    expect(after.planId).toBe(s.plan.id);
    expect(after.configRevision).toBe(before.configRevision + 1);
    expect(await prisma.instance.count()).toBe(1);
    expect(await prisma.instanceEvent.count({ where: { instanceId: freeInstanceId, type: 'plan.changed' } })).toBe(1);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(sub.status).toBe('ACTIVE');
    expect(sub.currentPeriodEnd).not.toBeNull();
    expect(routerCalls).toEqual([{ tenantId: s.tenant.id, instanceId: freeInstanceId, subscriptionId: subscription.id }]);

    // Idempotent: running it again (the billing tick's repair) changes nothing.
    await env.billing.applyPlanChange(subscription.id);
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: freeInstanceId } })).configRevision).toBe(after.configRevision);
  });

  it('replays the same key, refuses a paid instance and another tenant', async () => {
    const key = randomUUID();
    const a = await upgrade(key);
    const b = await upgrade(key);
    expect(b.payment.id).toBe(a.payment.id);
    expect(env.sumopod.invoices).toHaveLength(1);

    await expect(upgrade(randomUUID(), freeInstanceId, s.other.id)).rejects.toBeInstanceOf(NotFoundError);
    await pay(a.payment.id);
    await expect(upgrade()).rejects.toMatchObject({ code: 'already_subscribed' });
  });

  it('refuses an instance that is already on a priced plan', async () => {
    await prisma.instance.update({ where: { id: freeInstanceId }, data: { planId: s.plan.id } });
    await expect(upgrade()).rejects.toMatchObject({ code: 'not_free' });
  });

  it('a second request ends the first; paying the old invoice later never changes the plan', async () => {
    const first = await upgrade();
    const second = await upgrade();
    expect(second.subscription.id).not.toBe(first.subscription.id);
    const old = await prisma.subscription.findUniqueOrThrow({ where: { id: first.subscription.id } });
    expect(old).toMatchObject({ status: 'ENDED', instanceId: null });

    const r = await pay(first.payment.id);
    expect(r).toMatchObject({ accepted: true, outcome: 'paid_after_end' });
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: freeInstanceId } })).planId).not.toBe(s.plan.id);
  });

  it('an ended upgrade still linked to the instance does not block a new one', async () => {
    const first = await upgrade();
    await prisma.subscription.update({ where: { id: first.subscription.id }, data: { status: 'ENDED' } });
    const second = await upgrade();
    expect(second.subscription.instanceId).toBe(freeInstanceId);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: first.subscription.id } })).instanceId).toBeNull();
  });

  it('going back to a plan already tried in the same visit makes a new invoice', async () => {
    const other = await prisma.plan.create({
      data: { slug: 'other', name: 'Other', cpuMillis: 500, memoryMb: 256, pids: 128, storageMb: 2048, monthlyPriceIdr: 30_000 },
    });
    const keyA = 'visit-1:a';
    await upgrade(keyA);
    await env.billing.upgrade({ tenantId: s.tenant.id, email: s.user.email, instanceId: freeInstanceId, planId: other.id, idempotencyKey: 'visit-1:b' });
    const again = await upgrade(keyA);
    expect(again.subscription).toMatchObject({ status: 'PENDING_PAYMENT', instanceId: freeInstanceId, planId: s.plan.id });
    expect(env.sumopod.invoices).toHaveLength(3);
  });

  it('the billing tick ends an upgrade left unpaid for 7 days and lets the instance be upgraded again', async () => {
    const { subscription } = await upgrade();
    const tick = new BillingTick({ prisma, billing: env.billing, commands: env.commands, mailer: env.mailer, logger: env.logger, now: () => env.clock.now });
    env.clock.advanceDays(8);
    expect((await tick.runOnce()).abandoned).toBe(1);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).toMatchObject({ status: 'ENDED', instanceId: null });
    expect((await upgrade()).subscription.instanceId).toBe(freeInstanceId);
  });

  it('deleting the instance ends an unpaid upgrade', async () => {
    const { subscription } = await upgrade();
    await env.billing.endForInstance(s.tenant.id, freeInstanceId);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).status).toBe('ENDED');
  });

  it('upgrade of a free instance on a Singapore node is refused', async () => {
    const sg = await prisma.runtimeNode.create({ data: { name: 'jkt-2', region: 'sg-singapore' } });
    await prisma.instance.update({ where: { id: freeInstanceId }, data: { nodeId: sg.id } });
    const pinned = makeBilling(prisma, { paidNodeRegions: ['id-jakarta'] });
    const beforeSubs = await prisma.subscription.count();

    await expect(
      pinned.billing.upgrade({
        tenantId: s.tenant.id, email: s.user.email, instanceId: freeInstanceId, planId: s.plan.id, idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 409, code: 'region_not_for_paid' });
    expect(await prisma.subscription.count()).toBe(beforeSubs);
  });
});
