import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Plan } from '@prisma/client';
import { createPrisma } from '../../src/db/client.js';
import { NodeScheduler } from '../../src/modules/instances/node-scheduler.js';
import { ConflictError, PlanSoldOutError } from '../../src/shared/errors.js';
import { resetDb } from '../helpers/db.js';
import { WEBHOOK_TOKEN, makeBilling, seedBilling, webhookBody } from '../helpers/billing-env.js';

// Paid-to-paid plan changes. Needs Postgres only: the runtime, SumoPod and SMTP are in-memory fakes.
const prisma = createPrisma(process.env.DATABASE_URL!);
let s: Awaited<ReturnType<typeof seedBilling>>;
let env: ReturnType<typeof makeBilling>;
let hosting: Plan;
let hostingKredit: Plan;
let pro: Plan;
let proKredit: Plan;

async function payOrder(orderId: string, amount: number, reference = `REF-${randomUUID().slice(0, 6)}`) {
  const r = await env.billing.handleSumoPodWebhook({ token: WEBHOOK_TOKEN }, webhookBody({ orderId, amount, reference }));
  if (r.accepted) await r.postActions();
  return r;
}

async function activeSub(plan: Plan) {
  const { subscription, payment } = await env.billing.checkout({
    tenantId: s.tenant.id, email: s.user.email, planId: plan.id, name: 'agent-1', idempotencyKey: randomUUID(),
  });
  const orderId = (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).merchantOrderId;
  await payOrder(orderId, plan.monthlyPriceIdr!);
  return prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
}

describe('BillingService.changePlan', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seedBilling(prisma, { price: 25_000 });
    hosting = await prisma.plan.update({
      where: { id: s.plan.id },
      data: { slug: 'hosting', name: 'Hosting', cpuMillis: 1000, memoryMb: 1024, storageMb: 5120, monthlyPriceIdr: 25_000 },
    });
    hostingKredit = await prisma.plan.create({
      data: {
        slug: 'hosting-kredit', name: 'Hosting + Kredit', cpuMillis: 1000, memoryMb: 1024, pids: 128, storageMb: 10240,
        monthlyPriceIdr: 50_000, includedCreditNano: 2_000_000_000n,
      },
    });
    pro = await prisma.plan.create({
      data: { slug: 'pro', name: 'Pro', cpuMillis: 2000, memoryMb: 4096, pids: 256, storageMb: 20480, monthlyPriceIdr: 49_000 },
    });
    proKredit = await prisma.plan.create({
      data: {
        slug: 'pro-kredit', name: 'Pro + Kredit', cpuMillis: 2000, memoryMb: 4096, pids: 256, storageMb: 20480,
        monthlyPriceIdr: 79_000, includedCreditNano: 3_000_000_000n,
      },
    });
    env = makeBilling(prisma);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('creates a PLAN_CHANGE invoice with the prorated amount', async () => {
    const sub = await activeSub(hosting);
    env.clock.advanceDays(15);
    const key = randomUUID();
    const out = await env.billing.changePlan({
      tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id, planId: pro.id, idempotencyKey: key,
    });
    expect(out.payment).not.toBeNull();
    expect(out.payment).toMatchObject({ purpose: 'PLAN_CHANGE', amountIdr: 12_000, status: 'PENDING' });
    expect(env.sumopod.invoices.at(-1)?.returnUrl).toMatch(new RegExp(`/dashboard/instances/${sub.instanceId}/billing\\?payment=nc-`));
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).planId).toBe(hosting.id);
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: sub.instanceId! } })).planId).toBe(hosting.id);

    const replay = await env.billing.changePlan({
      tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id, planId: pro.id, idempotencyKey: key,
    });
    expect(replay.payment?.id).toBe(out.payment?.id);
    await expect(env.billing.changePlan({
      tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id, planId: hostingKredit.id, idempotencyKey: key,
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses while a renewal invoice is open', async () => {
    const sub = await activeSub(hosting);
    await env.billing.renew({ tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id });
    await expect(env.billing.changePlan({
      tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id, planId: pro.id, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ status: 409, code: 'renewal_open' });
  });

  it('refuses a storage downgrade', async () => {
    const sub = await activeSub(hostingKredit);
    await expect(env.billing.changePlan({
      tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id, planId: hosting.id, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ status: 409, code: 'plan_change_not_allowed' });
  });

  it('refuses a suspended subscription', async () => {
    const sub = await activeSub(hosting);
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'SUSPENDED' } });
    await expect(env.billing.changePlan({
      tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id, planId: pro.id, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ status: 409, code: 'subscription_not_changeable' });
  });

  it('a second request expires the first PLAN_CHANGE payment', async () => {
    const sub = await activeSub(hosting);
    const first = await env.billing.changePlan({
      tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id, planId: hostingKredit.id, idempotencyKey: randomUUID(),
    });
    const second = await env.billing.changePlan({
      tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id, planId: pro.id, idempotencyKey: randomUUID(),
    });
    expect(second.payment?.id).not.toBe(first.payment?.id);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: first.payment!.id } })).status).toBe('EXPIRED');
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: second.payment!.id } })).status).toBe('PENDING');
  });

  it('immediate change updates the instance plan without an invoice', async () => {
    const sub = await activeSub(hostingKredit);
    const invoicesBefore = env.sumopod.invoices.length;
    const out = await env.billing.changePlan({
      tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id, planId: pro.id, idempotencyKey: randomUUID(),
    });
    expect(out.payment).toBeNull();
    expect(env.sumopod.invoices).toHaveLength(invoicesBefore);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).planId).toBe(pro.id);
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: sub.instanceId! } })).planId).toBe(pro.id);
    expect(await prisma.instanceEvent.count({ where: { instanceId: sub.instanceId!, type: 'plan.changed' } })).toBe(1);
  });

  it('refuses when the target plan has no stock', async () => {
    const sub = await activeSub(hosting);
    await prisma.plan.update({ where: { id: pro.id }, data: { stockLimit: 0 } });
    await expect(env.billing.changePlan({
      tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id, planId: pro.id, idempotencyKey: randomUUID(),
    })).rejects.toBeInstanceOf(PlanSoldOutError);
  });

  it('checks node placement with paidNodeRegions', async () => {
    await prisma.runtimeNode.update({ where: { id: s.node.id }, data: { name: 'jkt-1', region: 'id-jakarta' } });
    const placement = new NodeScheduler(() => [{ id: s.node.id, cpuMillis: 1500, memoryMb: 4096, storageMb: 40960 }]);
    env = makeBilling(prisma, { placement, paidNodeRegions: ['id-jakarta'] });
    const sub = await activeSub(hosting);
    await expect(env.billing.changePlan({
      tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id, planId: pro.id, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: 'capacity_full' });
    await expect(env.billing.changePlan({
      tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id, planId: proKredit.id, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: 'capacity_full' });
  });
});
