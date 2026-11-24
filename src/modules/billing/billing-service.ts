import type { RouterProvisioner } from '../nibierouter/router-provisioner.js';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { InvoiceKind, Payment, PaymentMethod, PaymentPurpose, PaymentStatus, Plan, Prisma, PrismaClient, Subscription, SubscriptionStatus } from '@prisma/client';
import { AppError, CapacityFullError, ConflictError, InstanceLimitError, NotFoundError, PlanSoldOutError, ValidationError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import { isUuid } from '../../shared/uuid.js';
import type { InstanceCommands } from '../instances/instance-commands.js';
import { validateName } from '../instances/instance-service.js';
import { renderEmail, type EmailKind } from './email-templates.js';
import { periodAfterPayment } from './lifecycle.js';
import type { Mailer } from './mailer.js';
import { canChangePlan, quotePlanChange, type PlanTerms } from './plan-change.js';
import { hasStock, stockLeft, totalLoad } from '../instances/capacity.js';
import type { NodeScheduler } from '../instances/node-scheduler.js';
import type { PaymentClient } from './payment-client.js';
import { SUMOPOD_MIN_AMOUNT_IDR } from './sumopod-client.js';
import { verifySvixSignature, type SvixHeaders } from './svix.js';
import { getInvoice, issueInvoice, listInvoices, type InvoiceView } from './invoices.js';
import { InsufficientBalanceError, moveWallet, WalletService } from './wallet.js';

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
  method: PaymentMethod;
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
  /** Renew from the wallet near the end of the period. */
  autoRenew: boolean;
  graceEndsAt: Date | null;
  retentionEndsAt: Date | null;
  createdAt: Date;
  latestPayment: PaymentView | null;
}

export interface BillingDeps {
  placement?: NodeScheduler;
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
  /** Regions where priced plans may be placed and upgraded. Empty or absent: any region. */
  paidNodeRegions?: readonly string[];
  logger: Logger;
  /** NibieRouter key and credit for a freshly created paid instance. Absent: the operator attaches a provider by hand. */
  router?: Pick<RouterProvisioner, 'begin'>;
  /** `WALLET_ENABLED`: the customer wallet routes exist. A paid top-up is credited by the webhook either way. */
  walletEnabled?: boolean;
  /** `WALLET_AUTO_RENEW` (with the wallet on): shown to the dashboard; the billing tick does the renewing. */
  walletAutoRenew?: boolean;
  now?: () => Date;
}

/** What a SumoPod webhook request carries for authentication. `rawBody` is the exact body received (needed for Svix). */
export interface SumoPodCredentials {
  token: string;
  svix?: SvixHeaders;
  rawBody?: string;
}

export type CallbackOutcome =
  | 'activated' | 'topped_up' | 'credited_to_wallet' | 'duplicate' | 'unknown_order' | 'amount_mismatch' | 'failed' | 'ignored_failure' | 'already_paid' | 'paid_after_end'
  | 'ignored_event';

export type CallbackResult =
  | { accepted: false }
  | { accepted: true; outcome: CallbackOutcome; merchantOrderId?: string; postActions: () => Promise<void> };

/** SumoPod `status` values that mean the money arrived (only read for a body without `event_type`). */
const SUMOPOD_PAID_STATUSES = new Set(['paid', 'completed', 'success', 'succeeded', 'settled']);
/** SumoPod `status` values that mean the money will not arrive (only read for a body without `event_type`). */
const SUMOPOD_UNPAID_STATUSES = new Set(['failed', 'expired', 'cancelled', 'canceled']);
/** SumoPod's documented event types (dashboard Quick Start, 2026-11-20) and the `resultCode` each one stores. */
const SUMOPOD_EVENTS = new Map([['payment.completed', '00'], ['payment.failed', 'failed'], ['payment.expired', 'expired']]);
/** SumoPod's QR expires with our own row, so its `payment.expired` often lands before the billing tick: keep it EXPIRED. */
const unpaidStatus = (resultCode: string): PaymentStatus => (resultCode === 'expired' ? 'EXPIRED' : 'FAILED');

const none = async (): Promise<void> => undefined;

/** Auto-renew charges the wallet at most this long before the paid period ends. */
const AUTO_RENEW_WINDOW_MS = 86_400_000;

const newOrderId = (): string => `nc-${randomUUID().replaceAll('-', '')}`;

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Constant-time token check: both sides are hashed to equal length first, so neither content nor length leaks. */
function tokenMatches(given: string, expected: string): boolean {
  return given.length > 0 && timingSafeEqual(sha256(given), sha256(expected));
}

export function paymentView(p: Payment, now: Date): PaymentView {
  const payable = p.status === 'PENDING' && p.expiresAt.getTime() > now.getTime();
  return {
    id: p.id, subscriptionId: p.subscriptionId, status: p.status, purpose: p.purpose, method: p.method, amountIdr: p.amountIdr,
    paymentUrl: payable ? p.paymentUrl : null, expiresAt: p.expiresAt, paidAt: p.paidAt,
  };
}

function subscriptionView(s: Subscription & { plan: Plan; payments: Payment[] }, now: Date): SubscriptionView {
  return {
    id: s.id, planId: s.planId, planName: s.plan.name, instanceId: s.instanceId, name: s.intendedName, status: s.status,
    currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd, autoRenew: s.autoRenew, graceEndsAt: s.graceEndsAt,
    retentionEndsAt: s.retentionEndsAt, createdAt: s.createdAt,
    latestPayment: s.payments[0] ? paymentView(s.payments[0], now) : null,
  };
}

export class BillingService {
  private readonly now: () => Date;
  /** Customer wallet (top-up saldo), or null when `WALLET_ENABLED` is off. */
  readonly wallet: WalletService | null;

  constructor(private readonly d: BillingDeps) {
    this.now = d.now ?? (() => new Date());
    this.wallet = d.walletEnabled
      ? new WalletService({ prisma: d.prisma, paymentClient: d.paymentClient, dashboardOrigin: d.dashboardOrigin, autoRenew: d.walletAutoRenew, now: this.now })
      : null;
  }

  private get paidRegions(): readonly string[] | undefined {
    return this.d.paidNodeRegions?.length ? this.d.paidNodeRegions : undefined;
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
      await this.assertStock(tx, plan, now);
      const reservedNodeId = await this.d.placement?.select(tx, plan, now, this.paidRegions ? { regions: this.paidRegions } : undefined);
      // A new purchase is refused before any invoice exists when the server is full; paying customers are never blocked here.
      if (this.d.maxTotalInstances != null && (await totalLoad(tx, now)) >= this.d.maxTotalInstances) throw new CapacityFullError();
      const subscription = await tx.subscription.create({
        data: { tenantId: i.tenantId, planId: plan.id, intendedName: i.name, idempotencyKey: i.idempotencyKey, reservedNodeId },
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
      const inst = await tx.instance.findFirst({
        where: { id: i.instanceId, tenantId: i.tenantId },
        include: { plan: true, node: { select: { region: true } } },
      });
      if (!inst || inst.status === 'DELETING' || inst.status === 'DELETED') throw new NotFoundError('Instance not found');
      if (inst.recoveryNodeId) throw new ConflictError('Instance is being restored by an operator');
      let existing = await tx.subscription.findUnique({ where: { instanceId: inst.id } });
      if (existing?.status === 'ENDED') {
        // An ended subscription still linked to a live instance (e.g. ended elsewhere) must not block a new upgrade.
        await tx.subscription.update({ where: { id: existing.id }, data: { instanceId: null, idempotencyKey: null } });
        existing = null;
      }
      if (existing && existing.status !== 'PENDING_PAYMENT') throw new AppError('This instance already has a paid plan', 409, 'already_subscribed');
      if (inst.plan.monthlyPriceIdr !== null) throw new AppError('Only a free instance can be upgraded', 409, 'not_free');
      if (this.paidRegions && !this.paidRegions.includes(inst.node.region)) {
        throw new AppError('Paid plans run in Jakarta only', 409, 'region_not_for_paid');
      }
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
      const reservedNodeId = await this.d.placement?.select(tx, plan, now, {
        fixedNodeId: inst.nodeId, currentPlan: inst.plan, ...(this.paidRegions ? { regions: this.paidRegions } : {}),
      });
      const subscription = await tx.subscription.create({
        data: { tenantId: i.tenantId, planId: plan.id, instanceId: inst.id, intendedName: inst.name, idempotencyKey: i.idempotencyKey, reservedNodeId },
      });
      const payment = await tx.payment.create({ data: this.newPayment(subscription.id, 'NEW', price, now) });
      return { subscription, payment, needsInvoice: true };
    });

    // The gateway brings the customer back to this instance's billing page, which shows the upgrade's outcome.
    const back = `/dashboard/instances/${i.instanceId}/billing`;
    const payment = prepared.needsInvoice ? await this.issueInvoice(prepared.payment, plan, i.email, back) : prepared.payment;
    return { subscription: await this.viewOf(prepared.subscription.id), payment: paymentView(payment, now) };
  }

  /**
   * Moves an active paid subscription to another paid plan without changing its period end. Charges the prorated
   * difference when >= SUMOPOD_MIN_AMOUNT_IDR; smaller differences (including price decreases) apply immediately without
   * an invoice or credit. Refuses downgrades, ended/unpaid/late subscriptions, and open renewals.
   */
  async changePlan(i: {
    tenantId: string; email: string; subscriptionId: string; planId: string; idempotencyKey: string;
  }): Promise<{ subscription: SubscriptionView; payment: PaymentView | null }> {
    if (!i.idempotencyKey || i.idempotencyKey.length > 128) throw new ValidationError('invalid idempotency key');
    if (!isUuid(i.subscriptionId)) throw new NotFoundError('Subscription not found');
    if (!isUuid(i.planId)) throw new NotFoundError('Plan not found');
    const target = await this.d.prisma.plan.findUnique({ where: { id: i.planId } });
    if (!target || !target.active) throw new NotFoundError('Plan not found');
    if (target.monthlyPriceIdr === null || target.monthlyPriceIdr < SUMOPOD_MIN_AMOUNT_IDR) throw new PlanNotForSaleError();

    const now = this.now();
    const changeKey = `pc:${i.subscriptionId}:${target.id}:${i.idempotencyKey}`;
    const prepared = await this.d.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${i.tenantId}))`;
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Subscription" WHERE id = ${i.subscriptionId}::uuid AND "tenantId" = ${i.tenantId}::uuid FOR UPDATE`;
      if (!locked) throw new NotFoundError('Subscription not found');
      const sub = await tx.subscription.findUniqueOrThrow({
        where: { id: locked.id },
        include: { plan: true, instance: { include: { plan: true } } },
      });
      if (sub.status !== 'ACTIVE' || !sub.currentPeriodEnd || sub.currentPeriodEnd.getTime() <= now.getTime()) {
        throw new AppError('This subscription cannot change plan right now', 409, 'subscription_not_changeable');
      }
      const inst = sub.instance;
      if (!inst || inst.status === 'DELETING' || inst.status === 'DELETED') {
        throw new AppError('This subscription cannot change plan right now', 409, 'subscription_not_changeable');
      }
      if (inst.recoveryNodeId) throw new ConflictError('Instance is being restored by an operator');

      const prefix = `pc:${sub.id}:`;
      if (sub.idempotencyKey?.startsWith(prefix)) {
        const rest = sub.idempotencyKey.slice(prefix.length);
        const recordedPlanId = rest.slice(0, 36);
        const recordedKey = rest.slice(37);
        if (recordedKey === i.idempotencyKey) {
          if (recordedPlanId !== target.id) throw new ConflictError('Idempotency-Key was already used with a different request');
          const latest = await tx.payment.findFirst({
            where: { subscriptionId: sub.id, purpose: 'PLAN_CHANGE', targetPlanId: target.id },
            orderBy: { createdAt: 'desc' },
          });
          if (sub.planId === target.id) {
            return { subscription: sub, payment: latest?.status === 'PAID' ? latest : null, needsInvoice: false, applyImmediate: false };
          }
          if (latest && latest.status === 'PENDING' && latest.paymentUrl !== null && latest.expiresAt.getTime() > now.getTime()) {
            return { subscription: sub, payment: latest, needsInvoice: false, applyImmediate: false };
          }
          if (latest && latest.status === 'PENDING' && latest.paymentUrl === null) {
            await tx.payment.update({ where: { id: latest.id }, data: { status: 'FAILED' } });
          }
        }
      }

      const currentPrice = sub.plan.monthlyPriceIdr;
      if (currentPrice === null || target.id === sub.planId) {
        throw new AppError('Cannot change to this plan', 409, 'plan_change_not_allowed');
      }
      const currentTerms: PlanTerms = {
        monthlyPriceIdr: currentPrice, includedCreditNano: sub.plan.includedCreditNano,
        cpuMillis: sub.plan.cpuMillis, memoryMb: sub.plan.memoryMb, storageMb: sub.plan.storageMb,
      };
      const targetTerms: PlanTerms = {
        monthlyPriceIdr: target.monthlyPriceIdr!, includedCreditNano: target.includedCreditNano,
        cpuMillis: target.cpuMillis, memoryMb: target.memoryMb, storageMb: target.storageMb,
      };
      if (!canChangePlan(currentTerms, targetTerms)) {
        throw new AppError('Cannot change to this plan', 409, 'plan_change_not_allowed');
      }

      const openRenewal = await tx.payment.findFirst({
        where: { subscriptionId: sub.id, purpose: 'RENEWAL', status: 'PENDING', expiresAt: { gt: now } },
        select: { id: true },
      });
      if (openRenewal) throw new AppError('Pay or let the open renewal invoice expire first', 409, 'renewal_open');

      await this.assertStock(tx, target, now);
      await this.d.placement?.select(tx, target, now, {
        fixedNodeId: inst.nodeId, currentPlan: inst.plan, subscriptionId: sub.id,
        ...(this.paidRegions ? { regions: this.paidRegions } : {}),
      });

      const quote = quotePlanChange({ current: currentTerms, target: targetTerms, now, periodEnd: sub.currentPeriodEnd });
      await tx.payment.updateMany({ where: { subscriptionId: sub.id, purpose: 'PLAN_CHANGE', status: 'PENDING' }, data: { status: 'EXPIRED' } });

      if (quote.immediate) {
        const updated = await tx.subscription.update({
          where: { id: sub.id },
          data: { planId: target.id, idempotencyKey: changeKey, ...(this.d.placement ? { reservedNodeId: inst.nodeId } : {}) },
        });
        return { subscription: updated, payment: null, needsInvoice: false, applyImmediate: true };
      }

      await tx.subscription.update({ where: { id: sub.id }, data: { idempotencyKey: changeKey } });
      const payment = await tx.payment.create({
        data: {
          ...this.newPayment(sub.id, 'PLAN_CHANGE', quote.amountIdr, now),
          fromPlanId: sub.planId,
          targetPlanId: target.id,
          creditNano: quote.creditNano,
        },
      });
      return { subscription: sub, payment, needsInvoice: true, applyImmediate: false };
    });

    if (prepared.applyImmediate) {
      try {
        await this.applyPlanChange(prepared.subscription.id);
      } catch (e) {
        this.d.logger.error({ subscriptionId: prepared.subscription.id, errName: (e as Error).name }, 'immediate plan change instance action failed; retried');
      }
      return { subscription: await this.viewOf(prepared.subscription.id), payment: null };
    }
    const back = `/dashboard/instances/${prepared.subscription.instanceId}/billing`;
    const payment = prepared.needsInvoice ? await this.issueInvoice(prepared.payment!, target, i.email, back) : prepared.payment;
    return { subscription: await this.viewOf(prepared.subscription.id), payment: payment ? paymentView(payment, now) : null };
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

  /** Invoices of every paid hosting payment and top-up, newest first. */
  async invoices(tenantId: string): Promise<InvoiceView[]> {
    return listInvoices(this.d.prisma, tenantId);
  }

  /** One invoice, with the account owner's address it is billed to. */
  async invoice(tenantId: string, invoiceId: string): Promise<InvoiceView & { billedTo: string | null }> {
    const [inv, billedTo] = await Promise.all([getInvoice(this.d.prisma, tenantId, invoiceId), this.ownerEmail(tenantId)]);
    return { ...inv, billedTo };
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
    const eventType = typeof body.event_type === 'string' ? body.event_type : undefined;
    if (typeof order_id !== 'string' || (eventType === undefined && typeof status !== 'string')) return { accepted: false };
    const amountIdr = typeof rawAmount === 'number' ? rawAmount : (typeof rawAmount === 'string' ? parseAmount(rawAmount) : null);
    if (amountIdr === null || order_id.length > 128) return { accepted: false };
    const reference = (typeof payment_id === 'string' ? payment_id : '').slice(0, 100);
    // Stored as `resultCode` '00' for paid (the convention of the existing PaymentEvent and Payment rows), so the apply
    // path keeps its single '00 means paid' rule. A known event type decides; only a body without one falls back to the
    // status word. Anything not known to mean paid or unpaid is acknowledged and left alone, never written FAILED.
    const word = typeof status === 'string' ? status.toLowerCase() : '';
    const resultCode = eventType !== undefined
      ? SUMOPOD_EVENTS.get(eventType)
      : SUMOPOD_PAID_STATUSES.has(word) ? '00' : SUMOPOD_UNPAID_STATUSES.has(word) ? word.slice(0, 10) : undefined;
    if (resultCode === undefined) {
      this.d.logger.warn({ merchantOrderId: order_id, eventType: eventType?.slice(0, 64), status: word.slice(0, 32) }, 'sumopod webhook ignored: unknown event or status');
      return { accepted: true, outcome: 'ignored_event', merchantOrderId: order_id, postActions: none };
    }

    let result: { outcome: CallbackOutcome; activation?: Activation; topup?: TopupCredit };
    try {
      result = await this.d.prisma.$transaction(async (tx) => this.applyInTransaction(tx, { merchantOrderId: order_id, reference, resultCode, amountIdr }));
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return { accepted: true, outcome: 'duplicate', merchantOrderId: order_id, postActions: none };
      throw e;
    }
    if (result.outcome === 'paid_after_end') {
      this.d.logger.error({ merchantOrderId: order_id }, 'payment received for an ended subscription: operator must refund or reinstate');
    } else if (result.outcome === 'amount_mismatch') {
      this.d.logger.error({ merchantOrderId: order_id, amountIdr }, 'sumopod payment amount mismatch: paid but not credited, check the SumoPod fee setting');
    } else if (result.outcome === 'unknown_order') {
      this.d.logger.warn({ merchantOrderId: order_id }, 'sumopod webhook for an unknown order: wrong SumoPod project or mode?');
    }
    const { activation, topup } = result;
    let postActions = none;
    if (activation) postActions = () => this.afterActivation(activation);
    else if (topup) postActions = () => this.afterTopup(topup);
    return { accepted: true, outcome: result.outcome, merchantOrderId: order_id, postActions };
  }

  private async applyInTransaction(
    tx: Prisma.TransactionClient,
    c: { merchantOrderId: string; reference: string; resultCode: string; amountIdr: number },
  ): Promise<{ outcome: CallbackOutcome; activation?: Activation; topup?: TopupCredit }> {
    // The unique key makes a redelivered callback a no-op: the second insert fails and the caller maps it to `duplicate`.
    const event = await tx.paymentEvent.create({
      data: { merchantOrderId: c.merchantOrderId, reference: c.reference, resultCode: c.resultCode, amountIdr: c.amountIdr, outcome: 'received' },
    });
    const finish = async (outcome: CallbackOutcome, activation?: Activation) => {
      await tx.paymentEvent.update({ where: { id: event.id }, data: { outcome } });
      return activation ? { outcome, activation } : { outcome };
    };

    const payment = await tx.payment.findUnique({ where: { merchantOrderId: c.merchantOrderId } });
    if (!payment) {
      // Not a hosting invoice: maybe a wallet top-up. Its tenant comes from our row, never from the webhook body.
      const topup = await tx.walletTopup.findUnique({ where: { merchantOrderId: c.merchantOrderId } });
      if (!topup) return finish('unknown_order');
      if (c.amountIdr !== topup.amountIdr) return finish('amount_mismatch');
      if (c.resultCode !== '00') {
        const changed = await tx.walletTopup.updateMany({ where: { id: topup.id, status: 'PENDING' }, data: { status: unpaidStatus(c.resultCode), resultCode: c.resultCode } });
        return finish(changed.count === 1 ? 'failed' : 'ignored_failure');
      }
      // Money arrived: credited in full even after expiry or above the wallet cap, so a payment is never lost.
      const paidAt = this.now();
      const marked = await tx.walletTopup.updateMany({
        where: { id: topup.id, status: { not: 'PAID' } },
        data: { status: 'PAID', resultCode: c.resultCode, reference: c.reference || topup.reference, paidAt },
      });
      if (marked.count === 0) return finish('already_paid');
      const { balanceIdr } = await moveWallet(tx, { tenantId: topup.tenantId, amountIdr: topup.amountIdr, kind: 'TOPUP', refId: topup.id, note: 'Top-up QRIS' });
      await issueInvoice(tx, { tenantId: topup.tenantId, kind: 'TOPUP', amountIdr: topup.amountIdr, paidAt, walletTopupId: topup.id });
      return { ...(await finish('topped_up')), topup: { tenantId: topup.tenantId, amountIdr: topup.amountIdr, balanceIdr } };
    }
    if (c.amountIdr !== payment.amountIdr) return finish('amount_mismatch');

    // Serializes payments of one subscription, so two invoices paid together extend the period twice, correctly.
    await tx.$queryRaw`SELECT id FROM "Subscription" WHERE id = ${payment.subscriptionId}::uuid FOR UPDATE`;
    const now = this.now();

    if (c.resultCode !== '00') {
      // Anything but 00 is "not paid". A paid invoice is never downgraded.
      const changed = await tx.payment.updateMany({ where: { id: payment.id, status: 'PENDING' }, data: { status: unpaidStatus(c.resultCode), resultCode: c.resultCode } });
      return finish(changed.count === 1 ? 'failed' : 'ignored_failure');
    }

    // Money arrived: honored even for an invoice we already marked expired or failed.
    const marked = await tx.payment.updateMany({
      where: { id: payment.id, status: { not: 'PAID' } },
      data: { status: 'PAID', resultCode: c.resultCode, reference: c.reference || payment.reference, paidAt: now },
    });
    if (marked.count === 0) {
      // Re-read under the subscription lock: the invoice may have been paid from the wallet since it was first read.
      const current = await tx.payment.findUniqueOrThrow({ where: { id: payment.id }, include: { subscription: { select: { tenantId: true } } } });
      if (current.method !== 'WALLET') return finish('already_paid');
      // Paid twice, from the wallet and then by this QRIS invoice: the second payment goes to the wallet, never lost.
      const back = await moveWallet(tx, {
        tenantId: current.subscription.tenantId, amountIdr: payment.amountIdr, kind: 'TOPUP', refId: `qris:${payment.id}`,
        note: 'Pembayaran QRIS ganda, masuk ke saldo',
      });
      return finish(back.applied ? 'credited_to_wallet' : 'already_paid');
    }

    const activated = await this.activate(tx, payment, now);
    return activated.outcome === 'activated' ? finish('activated', activated.activation) : finish(activated.outcome);
  }

  /**
   * What a paid hosting invoice buys, inside the transaction that marked it paid: its invoice, then either a mid-period
   * plan change (keeping the period end, or crediting the wallet if superseded/ended) or 30 more days (from the end of
   * a running period, else from now).
   */
  private async activate(tx: Prisma.TransactionClient, payment: Payment, now: Date): Promise<ActivateResult> {
    const sub = await tx.subscription.findUniqueOrThrow({
      where: { id: payment.subscriptionId },
      include: { plan: { select: { name: true, includedCreditNano: true } }, instance: { select: { nodeId: true } } },
    });
    const targetPlan = payment.purpose === 'PLAN_CHANGE' && payment.targetPlanId
      ? await tx.plan.findUnique({ where: { id: payment.targetPlanId }, select: { id: true, name: true } })
      : null;
    const invoiceKind: InvoiceKind =
      payment.purpose === 'RENEWAL' ? 'HOSTING_RENEWAL' : payment.purpose === 'PLAN_CHANGE' ? 'HOSTING_PLAN_CHANGE' : 'HOSTING_NEW';
    await issueInvoice(tx, {
      tenantId: sub.tenantId, kind: invoiceKind, amountIdr: payment.amountIdr,
      paidAt: now, planName: targetPlan?.name ?? sub.plan.name, instanceName: sub.intendedName, paymentId: payment.id,
    });
    if (payment.purpose === 'PLAN_CHANGE') {
      const newer = await tx.payment.findFirst({
        where: {
          subscriptionId: sub.id,
          purpose: 'PLAN_CHANGE',
          id: { not: payment.id },
          OR: [{ status: 'PENDING' }, { createdAt: { gt: payment.createdAt } }],
        },
        select: { id: true },
      });
      const applicable =
        (sub.status === 'ACTIVE' || sub.status === 'GRACE') &&
        payment.fromPlanId !== null &&
        targetPlan !== null &&
        sub.planId === payment.fromPlanId &&
        newer === null;
      if (!applicable) {
        await moveWallet(tx, {
          tenantId: sub.tenantId,
          amountIdr: payment.amountIdr,
          kind: 'TOPUP',
          refId: `plan-change:${payment.id}`,
          note: 'Ganti paket tidak diterapkan, dana masuk ke saldo',
        });
        return { outcome: 'credited_to_wallet' };
      }
      await tx.subscription.update({
        where: { id: sub.id },
        data: {
          planId: targetPlan.id,
          ...(this.d.placement && sub.instance ? { reservedNodeId: sub.instance.nodeId } : {}),
        },
      });
      if (payment.creditNano && payment.creditNano > 0n) {
        await tx.creditGrant.upsert({
          where: { paymentId: payment.id },
          create: {
            tenantId: sub.tenantId,
            paymentId: payment.id,
            amountNano: payment.creditNano,
            note: `nibie-cloud credit payment ${payment.id}`,
          },
          update: {},
        });
      }
      return {
        outcome: 'activated',
        activation: {
          subscriptionId: sub.id, tenantId: sub.tenantId, wasSuspended: false, instanceId: sub.instanceId,
          periodEnd: sub.currentPeriodEnd, amountIdr: payment.amountIdr,
        },
      };
    }
    if (sub.status === 'ENDED') return { outcome: 'paid_after_end' };
    if (payment.purpose === 'RENEWAL' && sub.plan.includedCreditNano && sub.plan.includedCreditNano > 0n) {
      // shortcut: credit lands within about 7 minutes of a renewal, deliver inline if customers ask
      await tx.creditGrant.upsert({
        where: { paymentId: payment.id },
        create: {
          tenantId: sub.tenantId,
          paymentId: payment.id,
          amountNano: sub.plan.includedCreditNano,
          note: `nibie-cloud credit payment ${payment.id}`,
        },
        update: {},
      });
    }
    const { end } = periodAfterPayment({ now, status: sub.status, currentPeriodEnd: sub.currentPeriodEnd });
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        status: 'ACTIVE', currentPeriodEnd: end, cancelAtPeriodEnd: false, graceEndsAt: null, suspendedAt: null, retentionEndsAt: null,
        ...(sub.status === 'SUSPENDED' ? { restartPending: true } : {}),
      },
    });
    return {
      outcome: 'activated',
      activation: {
        subscriptionId: sub.id, tenantId: sub.tenantId, wasSuspended: sub.status === 'SUSPENDED', instanceId: sub.instanceId,
        periodEnd: end, amountIdr: payment.amountIdr,
      },
    };
  }

  // ---- wallet payments -----------------------------------------------------------------------

  /**
   * Debits the wallet for one hosting invoice and activates it, inside the caller's transaction, which must hold the
   * subscription row lock. The ledger entry is keyed on the payment id, so an invoice is charged at most once; a balance
   * that is too low throws `insufficient_balance` and the transaction rolls back.
   */
  private async chargeWallet(tx: Prisma.TransactionClient, payment: Payment, kind: 'HOSTING' | 'AUTO_RENEW', now: Date): Promise<Activation | null> {
    const sub = await tx.subscription.findUniqueOrThrow({ where: { id: payment.subscriptionId }, select: { tenantId: true, status: true } });
    if (sub.status === 'ENDED') throw new AppError('This subscription has ended', 409, 'subscription_ended');
    await moveWallet(tx, {
      tenantId: sub.tenantId, amountIdr: -payment.amountIdr, kind, refId: payment.id,
      note: kind === 'AUTO_RENEW' ? 'Perpanjangan otomatis' : 'Pembayaran hosting',
    });
    const paid = await tx.payment.update({ where: { id: payment.id }, data: { status: 'PAID', method: 'WALLET', resultCode: '00', paidAt: now } });
    const res = await this.activate(tx, paid, now);
    if (res.outcome === 'paid_after_end') throw new AppError('This subscription has ended', 409, 'subscription_ended');
    return res.outcome === 'activated' ? res.activation : null;
  }

  /**
   * Pays an open hosting invoice (a purchase, an upgrade, a plan change, or a renewal) from the wallet instead of QRIS.
   * Only an invoice that is still payable: an expired purchase gets a new invoice first, so capacity and stock are checked
   * again. The returned `postActions` (instance, plan change, receipt) run after the response, like the webhook's.
   */
  async payWithWallet(tenantId: string, paymentId: string): Promise<{ subscription: SubscriptionView; payment: PaymentView; postActions: () => Promise<void> }> {
    if (!isUuid(paymentId)) throw new NotFoundError('Payment not found');
    const found = await this.d.prisma.payment.findFirst({ where: { id: paymentId, subscription: { tenantId } } });
    if (!found) throw new NotFoundError('Payment not found');
    const now = this.now();
    const activation = await this.d.prisma.$transaction(async (tx) => {
      // The same lock as the webhook: a QRIS payment and a wallet payment of one invoice can never both apply.
      await tx.$queryRaw`SELECT id FROM "Subscription" WHERE id = ${found.subscriptionId}::uuid FOR UPDATE`;
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: found.id } });
      if (payment.status !== 'PENDING' || payment.expiresAt.getTime() <= now.getTime()) {
        throw new AppError('This invoice can no longer be paid', 409, 'payment_not_payable');
      }
      return this.chargeWallet(tx, payment, 'HOSTING', now);
    });
    if (!activation) {
      const payment = await this.d.prisma.payment.findUniqueOrThrow({ where: { id: found.id } });
      return { subscription: await this.viewOf(found.subscriptionId), payment: paymentView(payment, now), postActions: none };
    }
    // The customer is waiting on this response: create a new purchase's instance now, so the dashboard can open it. The
    // post actions call this again (a no-op then); a failure here is repaired by them or by the billing tick.
    try {
      await this.ensureInstance(found.subscriptionId);
    } catch (e) {
      this.d.logger.error({ subscriptionId: found.subscriptionId, errName: (e as Error).name }, 'instance after wallet payment not created yet; retried');
    }
    const payment = await this.d.prisma.payment.findUniqueOrThrow({ where: { id: found.id } });
    return { subscription: await this.viewOf(found.subscriptionId), payment: paymentView(payment, now), postActions: () => this.afterActivation(activation) };
  }

  /**
   * Renews from the wallet when the paid period ends within a day (or already ended, in grace), the customer left
   * auto-renew on and the balance covers the price. The order id names the period it renews, so each period is charged
   * at most once however many ticks or replicas run. A short balance changes nothing: the usual reminders and grace follow.
   */
  async autoRenew(subscriptionId: string, now: Date): Promise<boolean> {
    const sub = await this.d.prisma.subscription.findUnique({ where: { id: subscriptionId }, include: { plan: true } });
    if (!sub || !sub.autoRenew || sub.cancelAtPeriodEnd || !sub.currentPeriodEnd) return false;
    if (sub.status !== 'ACTIVE' && sub.status !== 'GRACE') return false;
    if (sub.currentPeriodEnd.getTime() - now.getTime() > AUTO_RENEW_WINDOW_MS) return false;
    const price = sub.plan.monthlyPriceIdr;
    if (price === null || price < SUMOPOD_MIN_AMOUNT_IDR) return false;
    const balance = (await this.d.prisma.wallet.findUnique({ where: { tenantId: sub.tenantId } }))?.balanceIdr ?? 0;
    if (balance < price) return false;

    const periodEnd = sub.currentPeriodEnd;
    let activation: Activation | null;
    try {
      activation = await this.d.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Subscription" WHERE id = ${sub.id}::uuid FOR UPDATE`;
        const fresh = await tx.subscription.findUniqueOrThrow({ where: { id: sub.id } });
        const unchanged = fresh.currentPeriodEnd?.getTime() === periodEnd.getTime() && (fresh.status === 'ACTIVE' || fresh.status === 'GRACE');
        if (!unchanged || !fresh.autoRenew || fresh.cancelAtPeriodEnd) return null; // paid or changed meanwhile
        const payment = await tx.payment.create({
          data: { ...this.newPayment(sub.id, 'RENEWAL', price, now), merchantOrderId: `ar-${sub.id.replaceAll('-', '')}-${periodEnd.getTime()}` },
        });
        // An open QRIS renewal invoice is not needed any more; if it is paid anyway, that payment still counts.
        await tx.payment.updateMany({ where: { subscriptionId: sub.id, purpose: 'RENEWAL', status: 'PENDING', id: { not: payment.id } }, data: { status: 'EXPIRED' } });
        return this.chargeWallet(tx, payment, 'AUTO_RENEW', now);
      });
    } catch (e) {
      // Spent meanwhile, or this period was already renewed by another tick: nothing to do.
      if (e instanceof InsufficientBalanceError || (e as { code?: string }).code === 'P2002') return false;
      throw e;
    }
    if (!activation) return false;
    await this.afterActivation(activation);
    return true;
  }

  /** The customer's auto-renew switch for one subscription. */
  async setAutoRenew(tenantId: string, subscriptionId: string, enabled: boolean): Promise<SubscriptionView> {
    const sub = await this.findOwned(tenantId, subscriptionId);
    await this.d.prisma.subscription.update({ where: { id: sub.id }, data: { autoRenew: enabled } });
    return this.viewOf(sub.id);
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

  private async afterTopup(t: TopupCredit): Promise<void> {
    await this.sendEmail(t.tenantId, 'topup_received', { periodEnd: null, amountIdr: t.amountIdr, balanceIdr: t.balanceIdr, dashboardPath: '/dashboard/billing' });
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
      ...(this.d.placement ? { billingSubscriptionId: sub.id } : {}),
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
   * start. The volume's quota is raised by the host job hermes-volume-quota (ops/host), which reads `GET /volume-quotas`.
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
      if (this.d.placement) {
        const [current, plan] = await Promise.all([
          tx.plan.findUniqueOrThrow({ where: { id: inst.planId } }),
          tx.plan.findUniqueOrThrow({ where: { id: sub.planId } }),
        ]);
        await this.d.placement.select(tx, plan, this.now(), {
          fixedNodeId: inst.nodeId, currentPlan: current, subscriptionId, ...(this.paidRegions ? { regions: this.paidRegions } : {}),
        });
      }
      const n = await tx.instance.updateMany({ where: { id: inst.id, planId: inst.planId, recoveryNodeId: null }, data: { planId: sub.planId, configRevision: { increment: 1 } } });
      if (n.count === 1) {
        if (this.d.placement) await tx.subscription.update({ where: { id: sub.id }, data: { reservedNodeId: null } });
        await tx.instanceEvent.create({ data: { instanceId: inst.id, type: 'plan.changed', message: 'Plan changed after payment' } });
      }
      return n.count === 1;
    });
    if (!changed) return;
    // The volume keeps its old quota until the host job hermes-volume-quota (ops/host, every minute) raises it.
    this.d.logger.info({ instanceId: inst.id, planId: sub.planId }, 'plan upgraded; the host raises the volume quota');
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
    ctx: {
      /** Absent for mail that is not about one subscription (a wallet top-up). */
      subscriptionId?: string;
      periodEnd: Date | null; graceEndsAt?: Date | null; retentionEndsAt?: Date | null; amountIdr?: number; balanceIdr?: number;
      /** Dashboard page the button opens. Default: the instance list. */
      dashboardPath?: string;
    },
  ): Promise<boolean> {
    if (!this.d.mailer.enabled) {
      this.d.logger.warn({ kind }, 'mail is not configured; billing email skipped');
      return false;
    }
    try {
      const to = await this.ownerEmail(tenantId);
      if (!to) return false;
      const sub = ctx.subscriptionId
        ? await this.d.prisma.subscription.findUnique({ where: { id: ctx.subscriptionId }, select: { intendedName: true } })
        : null;
      const msg = renderEmail(kind, {
        instanceName: sub?.intendedName ?? '', periodEnd: ctx.periodEnd, graceEndsAt: ctx.graceEndsAt, retentionEndsAt: ctx.retentionEndsAt,
        ...(ctx.amountIdr !== undefined ? { amountIdr: ctx.amountIdr } : {}),
        ...(ctx.balanceIdr !== undefined ? { balanceIdr: ctx.balanceIdr } : {}),
        dashboardUrl: `${this.d.dashboardOrigin}${ctx.dashboardPath ?? '/dashboard/instances'}`,
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
    if (existing.status !== 'PENDING_PAYMENT') return { subscription: existing, payment: latest as Payment, needsInvoice: false };
    if (this.d.placement && (!live || !existing.reservedNodeId)) {
      const [plan, inst] = await Promise.all([
        tx.plan.findUniqueOrThrow({ where: { id: existing.planId } }),
        existing.instanceId ? tx.instance.findUniqueOrThrow({ where: { id: existing.instanceId }, include: { plan: true } }) : null,
      ]);
      const reservedNodeId = await this.d.placement.select(tx, plan, now, {
        subscriptionId: existing.id, preferredNodeId: existing.reservedNodeId, fixedNodeId: inst?.nodeId, currentPlan: inst?.plan,
        ...(this.paidRegions ? { regions: this.paidRegions } : {}),
      });
      existing = await tx.subscription.update({ where: { id: existing.id }, data: { reservedNodeId } });
    }
    if (live) return { subscription: existing, payment: latest as Payment, needsInvoice: false };
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

/** A top-up the webhook just credited, for its receipt email. */
interface TopupCredit {
  tenantId: string;
  amountIdr: number;
  balanceIdr: number;
}

interface Activation {
  subscriptionId: string;
  tenantId: string;
  wasSuspended: boolean;
  instanceId: string | null;
  periodEnd: Date | null;
  amountIdr: number;
}

type ActivateResult =
  | { outcome: 'activated'; activation: Activation }
  | { outcome: 'credited_to_wallet' }
  | { outcome: 'paid_after_end' };

/** An amount sent as text: whole rupiah, optionally with a zero fraction. */
function parseAmount(raw: string): number | null {
  const m = /^(\d{1,10})(?:\.0+)?$/.exec(raw);
  return m ? Number(m[1]) : null;
}
