import type { RouterProvisioner } from '../nibierouter/router-provisioner.js';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Payment, PaymentPurpose, PaymentStatus, Plan, Prisma, PrismaClient, Subscription, SubscriptionStatus } from '@prisma/client';
import { AppError, CapacityFullError, ConflictError, InstanceLimitError, NotFoundError, PlanSoldOutError, ValidationError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import { isUuid } from '../../shared/uuid.js';
import type { InstanceCommands } from '../instances/instance-commands.js';
import { validateName } from '../instances/instance-service.js';
import { renderEmail, type EmailKind } from './email-templates.js';
import { periodAfterPayment } from './lifecycle.js';
import type { Mailer } from './mailer.js';
import { hasStock, stockLeft, totalLoad } from '../instances/capacity.js';
import type { PaymentClient } from './payment-client.js';
import { SUMOPOD_MIN_AMOUNT_IDR } from './sumopod-client.js';
import { verifySvixSignature, type SvixHeaders } from './svix.js';

/** How long an invoice stays payable. QRIS allows 60 minutes at most. */
export const INVOICE_EXPIRY_MINUTES = 60;

export class PlanNotForSaleError extends AppError {
  constructor() {
    super('This plan is not available for purchase', 409, 'plan_not_for_sale');
  }
}

export interface PaymentView {
  id: string;
  subscriptionId: string;
  status: PaymentStatus;
  purpose: PaymentPurpose;
  amountIdr: number;
  /** Only while the invoice can still be paid. */
  paymentUrl: string | null;
  expiresAt: Date;
  paidAt: Date | null;
}

export interface SubscriptionView {
  id: string;
  planId: string;
  planName: string;
  instanceId: string | null;
  name: string;
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  graceEndsAt: Date | null;
  retentionEndsAt: Date | null;
  createdAt: Date;
  latestPayment: PaymentView | null;
}

export interface BillingDeps {
  prisma: PrismaClient;
  /** Creates invoices (SumoPod). */
  paymentClient: PaymentClient;
  /**
   * SumoPod webhook authentication, or null. With `webhookSecret` (the Svix signing secret, `whsec_...`) a valid signature
   * over the raw body is required and the token is not consulted; without it, the `X-Webhook-Token` is checked.
   */
  sumopodAuth?: { webhookToken: string; webhookSecret?: string | null } | null;
  commands: InstanceCommands;
  mailer: Mailer;
  dashboardOrigin: string;
  maxInstancesPerTenant: number;
  /** Whole-server cap (see capacity.ts). Absent or null: no cap. */
  maxTotalInstances?: number | null;
  logger: Logger;
  /** NibieRouter key and credit for a freshly created paid instance. Absent: the operator attaches a provider by hand. */
  router?: Pick<RouterProvisioner, 'begin'>;
  now?: () => Date;
}

/** What a SumoPod webhook request carries for authentication. `rawBody` is the exact body received (needed for Svix). */
export interface SumoPodCredentials {
  token: string;
  svix?: SvixHeaders;
  rawBody?: string;
}

export type CallbackOutcome =
  | 'activated' | 'duplicate' | 'unknown_order' | 'amount_mismatch' | 'failed' | 'ignored_failure' | 'already_paid' | 'paid_after_end';

export type CallbackResult =
  | { accepted: false }
  | { accepted: true; outcome: CallbackOutcome; postActions: () => Promise<void> };

/** SumoPod `status` values that mean the money arrived. */
const SUMOPOD_PAID_STATUSES = new Set(['paid', 'completed', 'success', 'succeeded', 'settled']);

const none = async (): Promise<void> => undefined;

const newOrderId = (): string => `nc-${randomUUID().replaceAll('-', '')}`;

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Constant-time token check: both sides are hashed to equal length first, so neither content nor length leaks. */
function tokenMatches(given: string, expected: string): boolean {
  return given.length > 0 && timingSafeEqual(sha256(given), sha256(expected));
}

export function paymentView(p: Payment, now: Date): PaymentView {
  const payable = p.status === 'PENDING' && p.expiresAt.getTime() > now.getTime();
  return {
    id: p.id, subscriptionId: p.subscriptionId, status: p.status, purpose: p.purpose, amountIdr: p.amountIdr,
    paymentUrl: payable ? p.paymentUrl : null, expiresAt: p.expiresAt, paidAt: p.paidAt,
  };
}

function subscriptionView(s: Subscription & { plan: Plan; payments: Payment[] }, now: Date): SubscriptionView {
  return {
    id: s.id, planId: s.planId, planName: s.plan.name, instanceId: s.instanceId, name: s.intendedName, status: s.status,
    currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd, graceEndsAt: s.graceEndsAt,
    retentionEndsAt: s.retentionEndsAt, createdAt: s.createdAt,
    latestPayment: s.payments[0] ? paymentView(s.payments[0], now) : null,
  };
}

export class BillingService {
  private readonly now: () => Date;

  constructor(private readonly d: BillingDeps) {
    this.now = d.now ?? (() => new Date());
  }

  // ---- customer operations -------------------------------------------------------------------

  /**
   * Starts a purchase: records the intent (a subscription that carries the instance name and plan) and a
   * SumoPod invoice. No instance exists until the first payment is verified. Replaying the same
   * `Idempotency-Key` returns the same invoice while it is still payable.
   */
  async checkout(i: { tenantId: string; email: string; planId: string; name: string; idempotencyKey: string }): Promise<{ subscription: SubscriptionView; payment: PaymentView }> {
    validateName(i.name);
    if (!i.idempotencyKey || i.idempotencyKey.length > 128) throw new ValidationError('invalid idempotency key');
    if (!isUuid(i.planId)) throw new NotFoundError('Plan not found');
    const plan = await this.d.prisma.plan.findUnique({ where: { id: i.planId } });
    if (!plan || !plan.active) throw new NotFoundError('Plan not found');
    const price = plan.monthlyPriceIdr;
    if (price === null || price < SUMOPOD_MIN_AMOUNT_IDR) throw new PlanNotForSaleError();

    const now = this.now();
    const prepared = await this.d.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${i.tenantId}))`;
      const existing = await tx.subscription.findFirst({ where: { tenantId: i.tenantId, idempotencyKey: i.idempotencyKey } });
      if (existing) {
        // The key is bound to its original request: reuse with another payload is a client error.
        if (existing.intendedName !== i.name || existing.planId !== plan.id) throw new ConflictError('Idempotency-Key was already used with a different request');
        return this.replay(tx, existing, price, now);
      }
      // Starting a new checkout means the customer walked away from any earlier unpaid one: release its slot now,
      // instead of locking them out until the 60 minute invoice expires. If that old invoice is paid after all, the
      // verified payment is still honored (see the "paid after expiry" path), so no money is lost.
      await tx.payment.updateMany({
        where: { status: 'PENDING', subscription: { tenantId: i.tenantId, status: 'PENDING_PAYMENT', instanceId: null } },
        data: { status: 'EXPIRED' },
      });
      await this.assertCapacity(tx, i.tenantId, now);
      // A new purchase is refused before any invoice exists when the server is full; paying customers are never blocked here.
      if (this.d.maxTotalInstances != null && (await totalLoad(tx, now)) >= this.d.maxTotalInstances) throw new CapacityFullError();
      await this.assertStock(tx, plan, now);
      const subscription = await tx.subscription.create({
        data: { tenantId: i.tenantId, planId: plan.id, intendedName: i.name, idempotencyKey: i.idempotencyKey },
      });
      const payment = await tx.payment.create({ data: this.newPayment(subscription.id, 'NEW', price, now) });
      return { subscription, payment, needsInvoice: true };
    });

    const payment = prepared.needsInvoice ? await this.issueInvoice(prepared.payment, plan, i.email) : prepared.payment;
    return { subscription: await this.viewOf(prepared.subscription.id), payment: paymentView(payment, now) };
  }

  /**
   * Moves a free instance to a paid plan, keeping the instance and its data: a subscription that already points at the
   * instance, plus an invoice. The instance changes plan only once the first payment is verified (`applyPlanChange`).
   * It adds no instance, so only the plan's stock is checked, not the per-tenant or server cap.
   */
  async upgrade(i: { tenantId: string; email: string; instanceId: string; planId: string; idempotencyKey: string }): Promise<{ subscription: SubscriptionView; payment: PaymentView }> {
    if (!i.idempotencyKey || i.idempotencyKey.length > 128) throw new ValidationError('invalid idempotency key');
    if (!isUuid(i.instanceId)) throw new NotFoundError('Instance not found');
    if (!isUuid(i.planId)) throw new NotFoundError('Plan not found');
    const plan = await this.d.prisma.plan.findUnique({ where: { id: i.planId } });
    if (!plan || !plan.active) throw new NotFoundError('Plan not found');
    const price = plan.monthlyPriceIdr;
    if (price === null || price < SUMOPOD_MIN_AMOUNT_IDR) throw new PlanNotForSaleError();

    const now = this.now();
    const prepared = await this.d.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${i.tenantId}))`;
      const inst = await tx.instance.findFirst({ where: { id: i.instanceId, tenantId: i.tenantId }, include: { plan: true } });
      if (!inst || inst.status === 'DELETING' || inst.status === 'DELETED') throw new NotFoundError('Instance not found');
      let existing = await tx.subscription.findUnique({ where: { instanceId: inst.id } });
      if (existing?.status === 'ENDED') {
        // An ended subscription still linked to a live instance (e.g. ended elsewhere) must not block a new upgrade.
        await tx.subscription.update({ where: { id: existing.id }, data: { instanceId: null, idempotencyKey: null } });
        existing = null;
      }
      if (existing && existing.status !== 'PENDING_PAYMENT') throw new AppError('This instance already has a paid plan', 409, 'already_subscribed');
      if (inst.plan.monthlyPriceIdr !== null) throw new AppError('Only a free instance can be upgraded', 409, 'not_free');
      if (existing) {
        if (existing.idempotencyKey === i.idempotencyKey) {
          if (existing.planId !== plan.id) throw new ConflictError('Idempotency-Key was already used with a different request');
          return this.replay(tx, existing, price, now);
        }
        // A new upgrade request replaces the open one. Ending it and unlinking the instance means a late payment of its
        // invoice lands on an ended subscription (`paid_after_end`, logged for the operator), never on another plan. Its key
        // is released, so going back to that plan later in the same visit is a new request, not a unique-key clash.
        await tx.payment.updateMany({ where: { subscriptionId: existing.id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
        await tx.subscription.update({ where: { id: existing.id }, data: { status: 'ENDED', instanceId: null, idempotencyKey: null } });
      }
      await this.assertStock(tx, plan, now);
      const subscription = await tx.subscription.create({
        data: { tenantId: i.tenantId, planId: plan.id, instanceId: inst.id, intendedName: inst.name, idempotencyKey: i.idempotencyKey },
      });
      const payment = await tx.payment.create({ data: this.newPayment(subscription.id, 'NEW', price, now) });
      return { subscription, payment, needsInvoice: true };
    });

    // The gateway brings the customer back to this instance's billing page, which shows the upgrade's outcome.
    const back = `/dashboard/instances/${i.instanceId}/billing`;
    const payment = prepared.needsInvoice ? await this.issueInvoice(prepared.payment, plan, i.email, back) : prepared.payment;
    return { subscription: await this.viewOf(prepared.subscription.id), payment: paymentView(payment, now) };
  }

  /** A new invoice for the next period of an existing subscription (active, in grace, or suspended). */
  async renew(i: { tenantId: string; email: string; subscriptionId: string }): Promise<{ subscription: SubscriptionView; payment: PaymentView }> {
    const now = this.now();
    const sub = await this.findOwned(i.tenantId, i.subscriptionId);
    if (sub.status !== 'ACTIVE' && sub.status !== 'GRACE' && sub.status !== 'SUSPENDED') {
      throw new AppError('This subscription cannot be renewed', 409, 'subscription_not_renewable');
    }
    const plan = await this.d.prisma.plan.findUniqueOrThrow({ where: { id: sub.planId } });
    const price = plan.monthlyPriceIdr;
    if (price === null || price < SUMOPOD_MIN_AMOUNT_IDR) throw new PlanNotForSaleError();
    // Pressing the button twice must not create two invoices.
    const open = await this.d.prisma.payment.findFirst({
      where: { subscriptionId: sub.id, purpose: 'RENEWAL', status: 'PENDING', paymentUrl: { not: null }, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    if (open) return { subscription: await this.viewOf(sub.id), payment: paymentView(open, now) };
    const created = await this.d.prisma.payment.create({ data: this.newPayment(sub.id, 'RENEWAL', price, now) });
    const payment = await this.issueInvoice(created, plan, i.email);
    return { subscription: await this.viewOf(sub.id), payment: paymentView(payment, now) };
  }

  /** Non-renewal at the end of the paid period. The instance keeps running until then (PRD 10.4). */
  async cancel(tenantId: string, subscriptionId: string): Promise<SubscriptionView> {
    const sub = await this.findOwned(tenantId, subscriptionId);
    if (sub.status !== 'ACTIVE' && sub.status !== 'GRACE' && sub.status !== 'SUSPENDED') {
      throw new AppError('This subscription cannot be cancelled', 409, 'subscription_not_cancellable');
    }
    await this.d.prisma.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
    return this.viewOf(sub.id);
  }

  async list(tenantId: string): Promise<SubscriptionView[]> {
    const rows = await this.d.prisma.subscription.findMany({
      where: { tenantId }, orderBy: { createdAt: 'desc' },
      include: { plan: true, payments: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    const now = this.now();
    return rows.map((r) => subscriptionView(r, now));
  }

  async get(tenantId: string, subscriptionId: string): Promise<SubscriptionView> {
    await this.findOwned(tenantId, subscriptionId);
    return this.viewOf(subscriptionId);
  }

  async getPayment(tenantId: string, paymentId: string): Promise<PaymentView> {
    if (!isUuid(paymentId)) throw new NotFoundError('Payment not found');
    const p = await this.d.prisma.payment.findFirst({ where: { id: paymentId, subscription: { tenantId } } });
    if (!p) throw new NotFoundError('Payment not found');
    return paymentView(p, this.now());
  }

  /** The subscription behind an instance, for the customer start/restart guard. */
  async subscriptionOfInstance(instanceId: string): Promise<{ status: SubscriptionStatus } | null> {
    return this.d.prisma.subscription.findUnique({ where: { instanceId }, select: { status: true } });
  }

  /**
   * The customer deleted the instance: the subscription ends with it (no refund, PRD 10.4 does not apply). An unpaid
   * upgrade ends too, so paying its invoice afterwards is reported as `paid_after_end` instead of being kept silently.
   */
  async endForInstance(tenantId: string, instanceId: string): Promise<void> {
    await this.d.prisma.subscription.updateMany({
      where: { tenantId, instanceId, status: { in: ['PENDING_PAYMENT', 'ACTIVE', 'GRACE', 'SUSPENDED'] } },
      data: { status: 'ENDED', graceEndsAt: null, retentionEndsAt: null },
    });
  }

  // ---- SumoPod webhook ---------------------------------------------------------------------

  /** True when the request is from SumoPod: a valid Svix signature when a signing secret is configured, else the token. */
  private sumoPodAuthentic(c: SumoPodCredentials): boolean {
    const auth = this.d.sumopodAuth;
    if (!auth) return false;
    if (auth.webhookSecret) {
      // The signature covers the whole body (status and amount included) and a timestamp, so a captured or edited
      // webhook cannot be replayed later or turned into a payment.
      return c.svix !== undefined && c.rawBody !== undefined && verifySvixSignature(auth.webhookSecret, c.svix, c.rawBody, this.now().getTime());
    }
    return tokenMatches(c.token, auth.webhookToken);
  }

  /**
   * Authenticates a SumoPod webhook (Svix signature, or the `X-Webhook-Token` header when no signing secret is set), before
   * any database access, then applies it. Returns `accepted: false` for anything that fails authentication (the caller
   * answers 400). The returned `postActions` (provisioning, restart, receipt email) run after the response, so a slow
   * instance start can never make SumoPod retry; a crash before they finish is repaired by the billing tick. SumoPod
   * wraps the event in a svix-style envelope: `{ event_type, data: { order_id, payment_id, amount, status } }`. Flat
   * payloads are still accepted (older/manual calls).
   */
  async handleSumoPodWebhook(credentials: SumoPodCredentials, body: Record<string, unknown>): Promise<CallbackResult> {
    if (!this.sumoPodAuthentic(credentials)) return { accepted: false };
    const envelope = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, unknown>;
    // SumoPod's "Save & Test" sends event_type payment.test with no order: acknowledge, never apply.
    if (body.event_type === 'payment.test') return { accepted: true, outcome: 'ignored_failure', postActions: none };
    const { order_id, payment_id, amount: rawAmount, status } = envelope;
    if (typeof order_id !== 'string' || typeof status !== 'string') return { accepted: false };
    const amountIdr = typeof rawAmount === 'number' ? rawAmount : (typeof rawAmount === 'string' ? parseAmount(rawAmount) : null);
    if (amountIdr === null || order_id.length > 128) return { accepted: false };
    const reference = (typeof payment_id === 'string' ? payment_id : '').slice(0, 100);
    // SumoPod reports a word (`paid`/`completed`/`failed`). Stored as `resultCode` '00' for paid (the convention of the
    // existing PaymentEvent and Payment rows), so the apply path keeps its single '00 means paid' rule.
    const resultCode = SUMOPOD_PAID_STATUSES.has(status.toLowerCase()) ? '00' : status.slice(0, 10);

    let result: { outcome: CallbackOutcome; activation?: Activation };
    try {
      result = await this.d.prisma.$transaction(async (tx) => this.applyInTransaction(tx, { merchantOrderId: order_id, reference, resultCode, amountIdr }));
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return { accepted: true, outcome: 'duplicate', postActions: none };
      throw e;
    }
    if (result.outcome === 'paid_after_end') {
      this.d.logger.error({ merchantOrderId: order_id }, 'payment received for an ended subscription: operator must refund or reinstate');
    }
    const activation = result.activation;
    return { accepted: true, outcome: result.outcome, postActions: activation ? () => this.afterActivation(activation) : none };
  }

  private async applyInTransaction(
    tx: Prisma.TransactionClient,
    c: { merchantOrderId: string; reference: string; resultCode: string; amountIdr: number },
  ): Promise<{ outcome: CallbackOutcome; activation?: Activation }> {
    // The unique key makes a redelivered callback a no-op: the second insert fails and the caller maps it to `duplicate`.
    const event = await tx.paymentEvent.create({
      data: { merchantOrderId: c.merchantOrderId, reference: c.reference, resultCode: c.resultCode, amountIdr: c.amountIdr, outcome: 'received' },
    });
    const finish = async (outcome: CallbackOutcome, activation?: Activation) => {
      await tx.paymentEvent.update({ where: { id: event.id }, data: { outcome } });
      return activation ? { outcome, activation } : { outcome };
    };

    const payment = await tx.payment.findUnique({ where: { merchantOrderId: c.merchantOrderId } });
    if (!payment) return finish('unknown_order');
    if (c.amountIdr !== payment.amountIdr) return finish('amount_mismatch');

    // Serializes payments of one subscription, so two invoices paid together extend the period twice, correctly.
    await tx.$queryRaw`SELECT id FROM "Subscription" WHERE id = ${payment.subscriptionId}::uuid FOR UPDATE`;
    const now = this.now();

    if (c.resultCode !== '00') {
      // Anything but 00 is "not paid". A paid invoice is never downgraded.
      const changed = await tx.payment.updateMany({ where: { id: payment.id, status: 'PENDING' }, data: { status: 'FAILED', resultCode: c.resultCode } });
      return finish(changed.count === 1 ? 'failed' : 'ignored_failure');
    }

    // Money arrived: honored even for an invoice we already marked expired or failed.
    const marked = await tx.payment.updateMany({
      where: { id: payment.id, status: { not: 'PAID' } },
      data: { status: 'PAID', resultCode: c.resultCode, reference: c.reference || payment.reference, paidAt: now },
    });
    if (marked.count === 0) return finish('already_paid');

    const sub = await tx.subscription.findUniqueOrThrow({ where: { id: payment.subscriptionId } });
    if (sub.status === 'ENDED') return finish('paid_after_end');
    const { end } = periodAfterPayment({ now, status: sub.status, currentPeriodEnd: sub.currentPeriodEnd });
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        status: 'ACTIVE', currentPeriodEnd: end, cancelAtPeriodEnd: false, graceEndsAt: null, suspendedAt: null, retentionEndsAt: null,
        ...(sub.status === 'SUSPENDED' ? { restartPending: true } : {}),
      },
    });
    return finish('activated', {
      subscriptionId: sub.id, tenantId: sub.tenantId, wasSuspended: sub.status === 'SUSPENDED', instanceId: sub.instanceId,
      periodEnd: end, amountIdr: payment.amountIdr,
    });
  }

  private async afterActivation(a: Activation): Promise<void> {
    try {
      await this.ensureInstance(a.subscriptionId);
      await this.applyPlanChange(a.subscriptionId);
      if (a.wasSuspended) await this.restartIfPending(a.subscriptionId);
    } catch (e) {
      // Nothing is lost: the subscription is paid and the billing tick repairs a missing or stopped instance.
      this.d.logger.error({ subscriptionId: a.subscriptionId, errName: (e as Error).name }, 'post-payment instance action failed; the billing tick will retry');
    }
    await this.sendEmail(a.tenantId, 'payment_received', { subscriptionId: a.subscriptionId, periodEnd: a.periodEnd, amountIdr: a.amountIdr });
  }

  /** Starts the kept instance of a subscription that was reinstated after suspension, then clears the flag. */
  async restartIfPending(subscriptionId: string): Promise<void> {
    const sub = await this.d.prisma.subscription.findUnique({ where: { id: subscriptionId }, include: { instance: true } });
    if (!sub || !sub.restartPending) return;
    if (!sub.instance || sub.instance.status === 'DELETED' || sub.instance.status === 'DELETING') {
      await this.d.prisma.subscription.update({ where: { id: sub.id }, data: { restartPending: false } });
      return;
    }
    // Reinstating a suspended instance: the volume was kept, so this is an ordinary start (a no-op if it already runs).
    await this.d.commands.start(sub.tenantId, sub.instance.id);
    await this.d.prisma.subscription.update({ where: { id: sub.id }, data: { restartPending: false } });
  }

  /** Creates the instance for a paid subscription that has none yet. Idempotent per first payment. */
  async ensureInstance(subscriptionId: string): Promise<void> {
    const sub = await this.d.prisma.subscription.findUnique({ where: { id: subscriptionId } });
    if (!sub || sub.instanceId || sub.status === 'PENDING_PAYMENT' || sub.status === 'ENDED') return;
    const first = await this.d.prisma.payment.findFirst({
      where: { subscriptionId, purpose: 'NEW', status: 'PAID' }, orderBy: { paidAt: 'asc' },
    });
    if (!first) return;
    const { instance } = await this.d.commands.provision({
      tenantId: sub.tenantId, name: sub.intendedName, planId: sub.planId, idempotencyKey: `pay-${first.merchantOrderId}`,
    });
    await this.d.prisma.subscription.updateMany({ where: { id: sub.id, instanceId: null }, data: { instanceId: instance.id } });
    // The AI provider (router user, key, one-time credit) never fails the payment: `begin` swallows its own errors,
    // and the billing tick retries whatever is left.
    await this.d.router?.begin({ tenantId: sub.tenantId, instanceId: instance.id, subscriptionId: sub.id });
  }

  /**
   * Puts an upgraded instance on its subscription's plan once paid. The NibieRouter step (the plan's credit) runs first,
   * so a crash before the plan change is repaired by the billing tick, which calls this again. The new CPU, memory and
   * process limits apply when the container is recreated: a running instance is restarted now, a stopped one on its next
   * start. The volume keeps the quota it was created with; raising it is a host step (docs/disk-quota-host-notes.md).
   * Idempotent.
   */
  async applyPlanChange(subscriptionId: string): Promise<void> {
    const sub = await this.d.prisma.subscription.findUnique({ where: { id: subscriptionId }, include: { instance: true } });
    const inst = sub?.instance;
    if (!sub || !inst || sub.status === 'PENDING_PAYMENT' || sub.status === 'ENDED') return;
    if (inst.planId === sub.planId) return;
    if (inst.status === 'DELETING' || inst.status === 'DELETED') {
      // Deleted outside the customer route (which ends an unpaid upgrade first) and paid afterwards.
      this.d.logger.error({ subscriptionId: sub.id, instanceId: inst.id }, 'upgrade paid for a deleted instance: operator must refund');
      return;
    }
    await this.d.router?.begin({ tenantId: sub.tenantId, instanceId: inst.id, subscriptionId: sub.id });
    const changed = await this.d.prisma.$transaction(async (tx) => {
      const n = await tx.instance.updateMany({ where: { id: inst.id, planId: inst.planId }, data: { planId: sub.planId, configRevision: { increment: 1 } } });
      if (n.count === 1) await tx.instanceEvent.create({ data: { instanceId: inst.id, type: 'plan.changed', message: 'Plan upgraded after payment' } });
      return n.count === 1;
    });
    if (!changed) return;
    // Error level so it is not missed: until the quota is raised, writes fail at the old size and the disk monitor
    // (which measures against the new plan) does not warn first.
    this.d.logger.error({ instanceId: inst.id, planId: sub.planId }, 'plan upgraded: raise the volume quota on the host (docs/disk-quota-host-notes.md)');
    if (inst.status === 'ACTIVE' || inst.status === 'DEGRADED') await this.d.commands.restart(sub.tenantId, inst.id);
  }

  // ---- email ---------------------------------------------------------------------------------

  /** Owner's address for a tenant, or null. Only used to address billing mail. */
  async ownerEmail(tenantId: string): Promise<string | null> {
    const m = await this.d.prisma.tenantMember.findFirst({ where: { tenantId, role: 'OWNER' }, include: { user: true } });
    return m?.user.email ?? null;
  }

  /** Sends one email; failure is logged and returned as false, never thrown into a payment path. */
  async sendEmail(
    tenantId: string,
    kind: EmailKind,
    ctx: { subscriptionId: string; periodEnd: Date | null; graceEndsAt?: Date | null; retentionEndsAt?: Date | null; amountIdr?: number },
  ): Promise<boolean> {
    if (!this.d.mailer.enabled) {
      this.d.logger.warn({ kind }, 'mail is not configured; billing email skipped');
      return false;
    }
    try {
      const to = await this.ownerEmail(tenantId);
      if (!to) return false;
      const sub = await this.d.prisma.subscription.findUnique({ where: { id: ctx.subscriptionId }, select: { intendedName: true } });
      const msg = renderEmail(kind, {
        instanceName: sub?.intendedName ?? '', periodEnd: ctx.periodEnd, graceEndsAt: ctx.graceEndsAt, retentionEndsAt: ctx.retentionEndsAt,
        ...(ctx.amountIdr !== undefined ? { amountIdr: ctx.amountIdr } : {}),
        dashboardUrl: `${this.d.dashboardOrigin}/dashboard/instances`,
      });
      await this.d.mailer.send({ to, ...msg });
      return true;
    } catch (e) {
      this.d.logger.warn({ kind, errName: (e as Error).name }, 'billing email not sent');
      return false;
    }
  }

  // ---- internals -----------------------------------------------------------------------------

  private newPayment(subscriptionId: string, purpose: PaymentPurpose, amountIdr: number, now: Date): Prisma.PaymentUncheckedCreateInput {
    return { subscriptionId, merchantOrderId: newOrderId(), amountIdr, purpose, expiresAt: new Date(now.getTime() + INVOICE_EXPIRY_MINUTES * 60_000) };
  }

  /** Replays a request with a known Idempotency-Key: the still-payable invoice, or a fresh one while the purchase is unpaid. */
  private async replay(tx: Prisma.TransactionClient, existing: Subscription, price: number, now: Date): Promise<{ subscription: Subscription; payment: Payment; needsInvoice: boolean }> {
    const latest = await tx.payment.findFirst({ where: { subscriptionId: existing.id }, orderBy: { createdAt: 'desc' } });
    const live = latest && latest.status === 'PENDING' && latest.paymentUrl !== null && latest.expiresAt.getTime() > now.getTime();
    if (existing.status !== 'PENDING_PAYMENT' || live) return { subscription: existing, payment: latest as Payment, needsInvoice: false };
    if (latest && latest.status === 'PENDING' && latest.paymentUrl === null) {
      await tx.payment.update({ where: { id: latest.id }, data: { status: 'FAILED' } });
    }
    const payment = await tx.payment.create({ data: this.newPayment(existing.id, 'NEW', price, now) });
    return { subscription: existing, payment, needsInvoice: true };
  }

  /**
   * The plan's stock. Purchases of the same plan by different tenants queue on this lock (always taken after the tenant
   * lock, so the order is fixed), so two buyers can never both take the last unit.
   */
  private async assertStock(tx: Prisma.TransactionClient, plan: Plan, now: Date): Promise<void> {
    if (!hasStock(plan)) return;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`plan-stock:${plan.id}`}))`;
    const fresh = await tx.plan.findUniqueOrThrow({ where: { id: plan.id }, select: { id: true, monthlyPriceIdr: true, stockLimit: true } });
    if ((await stockLeft(tx, fresh, now)) === 0) throw new PlanSoldOutError();
  }

  /** Calls the payment client outside any transaction. A failure marks the row FAILED so a retry makes a fresh invoice. */
  private async issueInvoice(payment: Payment, plan: Plan, email: string, returnPath = '/dashboard/instances'): Promise<Payment> {
    try {
      const invoice = await this.d.paymentClient.createInvoice({
        merchantOrderId: payment.merchantOrderId,
        amountIdr: payment.amountIdr,
        productDetails: `Nibie Cloud ${plan.name} (30 hari)`.slice(0, 255),
        email,
        returnUrl: `${this.d.dashboardOrigin}${returnPath}?payment=${payment.merchantOrderId}`,
        expiryMinutes: INVOICE_EXPIRY_MINUTES,
      });
      return await this.d.prisma.payment.update({ where: { id: payment.id }, data: { reference: invoice.reference, paymentUrl: invoice.paymentUrl } });
    } catch (e) {
      await this.d.prisma.payment.updateMany({ where: { id: payment.id, status: 'PENDING', paymentUrl: null }, data: { status: 'FAILED' } });
      throw e;
    }
  }

  /** Instances, plus paid subscriptions still waiting for theirs, plus purchases in progress, against the cap. */
  private async assertCapacity(tx: Prisma.TransactionClient, tenantId: string, now: Date): Promise<void> {
    const [instances, unfulfilled, inProgress] = await Promise.all([
      tx.instance.count({ where: { tenantId, status: { not: 'DELETED' } } }),
      tx.subscription.count({ where: { tenantId, instanceId: null, status: { in: ['ACTIVE', 'GRACE', 'SUSPENDED'] } } }),
      tx.subscription.count({
        where: { tenantId, status: 'PENDING_PAYMENT', payments: { some: { status: 'PENDING', expiresAt: { gt: now } } } },
      }),
    ]);
    if (instances + unfulfilled + inProgress >= this.d.maxInstancesPerTenant) throw new InstanceLimitError();
  }

  private async findOwned(tenantId: string, subscriptionId: string): Promise<Subscription> {
    if (!isUuid(subscriptionId)) throw new NotFoundError('Subscription not found');
    const sub = await this.d.prisma.subscription.findFirst({ where: { id: subscriptionId, tenantId } });
    if (!sub) throw new NotFoundError('Subscription not found');
    return sub;
  }

  private async viewOf(subscriptionId: string): Promise<SubscriptionView> {
    const row = await this.d.prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId }, include: { plan: true, payments: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    return subscriptionView(row, this.now());
  }
}

interface Activation {
  subscriptionId: string;
  tenantId: string;
  wasSuspended: boolean;
  instanceId: string | null;
  periodEnd: Date;
  amountIdr: number;
}

/** An amount sent as text: whole rupiah, optionally with a zero fraction. */
function parseAmount(raw: string): number | null {
  const m = /^(\d{1,10})(?:\.0+)?$/.exec(raw);
  return m ? Number(m[1]) : null;
}
