import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Plan } from '@prisma/client';
import { createPrisma } from '../../src/db/client.js';
import { moveWallet } from '../../src/modules/billing/wallet.js';
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

describe('applying a paid plan change', () => {
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
    env = makeBilling(prisma, { wallet: true });
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('paid plan change moves the instance to the new plan and keeps the period end', async () => {
    const sub = await activeSub(hosting);
    const beforeInst = await prisma.instance.findUniqueOrThrow({ where: { id: sub.instanceId! } });
    env.clock.advanceDays(15);
    const { payment } = await env.billing.changePlan({
      tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id, planId: pro.id, idempotencyKey: randomUUID(),
    });
    const orderId = (await prisma.payment.findUniqueOrThrow({ where: { id: payment!.id } })).merchantOrderId;
    const out = await payOrder(orderId, payment!.amountIdr);
    expect(out).toMatchObject({ accepted: true, outcome: 'activated' });

    const afterSub = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(afterSub.planId).toBe(pro.id);
    expect(afterSub.currentPeriodEnd).toEqual(sub.currentPeriodEnd);

    const afterInst = await prisma.instance.findUniqueOrThrow({ where: { id: sub.instanceId! } });
    expect(afterInst.planId).toBe(pro.id);
    expect(afterInst.configRevision).toBe(beforeInst.configRevision + 1);
    const ev = await prisma.instanceEvent.findFirst({ where: { instanceId: sub.instanceId!, type: 'plan.changed' } });
    expect(ev?.message).toBe('Plan changed after payment');
  });

  it('applying a paid plan change expires a renewal invoice opened on the old plan', async () => {
    const sub = await activeSub(hosting);
    env.clock.advanceDays(15);
    const { payment } = await env.billing.changePlan({
      tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id, planId: pro.id, idempotencyKey: randomUUID(),
    });
    // Opened after the change was requested, so the renewal_open guard did not see it; priced on Hosting.
    const renewal = await env.billing.renew({ tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id });
    expect(renewal.payment.amountIdr).toBe(25_000);
    const orderId = (await prisma.payment.findUniqueOrThrow({ where: { id: payment!.id } })).merchantOrderId;
    await payOrder(orderId, payment!.amountIdr);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: renewal.payment.id } })).status).toBe('EXPIRED');
  });

  it('paid plan change to a Kredit plan creates a credit grant with the prorated amount', async () => {
    const sub = await activeSub(hosting);
    env.clock.advanceDays(15);
    const { payment } = await env.billing.changePlan({
      tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id, planId: hostingKredit.id, idempotencyKey: randomUUID(),
    });
    const orderId = (await prisma.payment.findUniqueOrThrow({ where: { id: payment!.id } })).merchantOrderId;
    await payOrder(orderId, payment!.amountIdr);

    const grants = await prisma.creditGrant.findMany({ where: { paymentId: payment!.id } });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      tenantId: s.tenant.id,
      paymentId: payment!.id,
      subscriptionId: null,
      amountNano: 1_000_000_000n,
      amountIdr: null,
      idempotencyKey: null,
      status: 'PENDING',
    });
  });

  it('late payment of a replaced plan change goes to the wallet', async () => {
    const sub = await activeSub(hosting);
    const first = await env.billing.changePlan({
      tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id, planId: hostingKredit.id, idempotencyKey: randomUUID(),
    });
    await env.billing.changePlan({
      tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id, planId: pro.id, idempotencyKey: randomUUID(),
    });
    const firstOrder = (await prisma.payment.findUniqueOrThrow({ where: { id: first.payment!.id } })).merchantOrderId;
    const out = await payOrder(firstOrder, first.payment!.amountIdr);
    expect(out).toMatchObject({ accepted: true, outcome: 'credited_to_wallet' });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).planId).toBe(hosting.id);
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: sub.instanceId! } })).planId).toBe(hosting.id);
    expect((await prisma.wallet.findUnique({ where: { tenantId: s.tenant.id } }))?.balanceIdr).toBe(first.payment!.amountIdr);
    expect(await prisma.walletEntry.findFirstOrThrow({ where: { kind: 'TOPUP', refId: `plan-change:${first.payment!.id}` } })).toMatchObject({
      amountIdr: first.payment!.amountIdr,
      note: 'Ganti paket tidak diterapkan, dana masuk ke saldo',
    });
    expect(await prisma.creditGrant.count({ where: { paymentId: first.payment!.id } })).toBe(0);
  });

  it('plan change paid after the subscription ended goes to the wallet', async () => {
    const sub = await activeSub(hosting);
    const { payment } = await env.billing.changePlan({
      tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id, planId: pro.id, idempotencyKey: randomUUID(),
    });
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'ENDED' } });
    const orderId = (await prisma.payment.findUniqueOrThrow({ where: { id: payment!.id } })).merchantOrderId;
    const out = await payOrder(orderId, payment!.amountIdr);
    expect(out).toMatchObject({ accepted: true, outcome: 'credited_to_wallet' });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe('ENDED');
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).planId).toBe(hosting.id);
    expect((await prisma.wallet.findUnique({ where: { tenantId: s.tenant.id } }))?.balanceIdr).toBe(payment!.amountIdr);
  });

  it('plan change paid from the wallet applies the same way', async () => {
    const sub = await activeSub(hosting);
    env.clock.advanceDays(15);
    const { payment } = await env.billing.changePlan({
      tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id, planId: hostingKredit.id, idempotencyKey: randomUUID(),
    });
    await prisma.$transaction((tx) => moveWallet(tx, { tenantId: s.tenant.id, amountIdr: payment!.amountIdr, kind: 'ADMIN_CREDIT', refId: randomUUID() }));
    const res = await env.billing.payWithWallet(s.tenant.id, payment!.id);
    await res.postActions();

    const afterSub = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(afterSub.planId).toBe(hostingKredit.id);
    expect(afterSub.currentPeriodEnd).toEqual(sub.currentPeriodEnd);
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: sub.instanceId! } })).planId).toBe(hostingKredit.id);
    expect((await prisma.wallet.findUnique({ where: { tenantId: s.tenant.id } }))?.balanceIdr).toBe(0);
    expect(await prisma.creditGrant.findUniqueOrThrow({ where: { paymentId: payment!.id } })).toMatchObject({ amountNano: 1_000_000_000n });
    expect(await prisma.invoice.findUniqueOrThrow({ where: { paymentId: payment!.id } })).toMatchObject({ kind: 'HOSTING_PLAN_CHANGE' });
  });

  it('invoice kind is HOSTING_PLAN_CHANGE', async () => {
    const sub = await activeSub(hosting);
    const { payment } = await env.billing.changePlan({
      tenantId: s.tenant.id, email: s.user.email, subscriptionId: sub.id, planId: pro.id, idempotencyKey: randomUUID(),
    });
    const orderId = (await prisma.payment.findUniqueOrThrow({ where: { id: payment!.id } })).merchantOrderId;
    await payOrder(orderId, payment!.amountIdr);

    const inv = await prisma.invoice.findUniqueOrThrow({ where: { paymentId: payment!.id } });
    expect(inv).toMatchObject({
      kind: 'HOSTING_PLAN_CHANGE',
      planName: 'Pro',
      instanceName: 'agent-1',
      amountIdr: payment!.amountIdr,
    });
  });
});

