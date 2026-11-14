import type { PrismaClient } from '@prisma/client';
import { ConflictError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import type { InstanceCommands } from '../instances/instance-commands.js';
import { recordEvent } from '../instances/instance-repo.js';
import type { BillingService } from './billing-service.js';
import { dueNotice, nextTransition, type NoticeKind } from './lifecycle.js';
import type { Mailer } from './mailer.js';

const DAY_MS = 86_400_000;
/** A purchase nobody paid for within this long is closed, which also frees the tenant's instance cap. */
const ABANDONED_AFTER_DAYS = 7;
const BATCH = 200;

export interface TickSummary {
  expiredPayments: number;
  abandoned: number;
  graced: number;
  suspended: number;
  ended: number;
  repaired: number;
  emails: number;
}

export interface BillingTickDeps {
  prisma: PrismaClient;
  billing: BillingService;
  commands: InstanceCommands;
  mailer: Mailer;
  logger: Logger;
  now?: () => Date;
  /** `run()` does nothing when called again sooner than this (the scheduler ticks every 15 s). Default 5 minutes. */
  minIntervalMs?: number;
}

/**
 * Walks every subscription through the PRD 10 lifecycle. Every step is idempotent and safe to run on two
 * replicas at once: status changes are compare-and-set on the previous status, emails are claimed with a
 * unique row before they are sent, and instance changes go through the ordinary commands (which already
 * refuse to run on top of an operation in flight; the next tick simply tries again).
 */
export class BillingTick {
  private lastRun = 0;
  private readonly now: () => Date;

  constructor(private readonly d: BillingTickDeps) {
    this.now = d.now ?? (() => new Date());
  }

  /** Throttled entry point for the scheduler. Never throws. */
  async run(): Promise<TickSummary | null> {
    const t = Date.now();
    if (t - this.lastRun < (this.d.minIntervalMs ?? 5 * 60_000)) return null;
    this.lastRun = t;
    try {
      return await this.runOnce();
    } catch (e) {
      this.d.logger.error({ errName: (e as Error).name }, 'billing tick failed');
      return null;
    }
  }

  async runOnce(): Promise<TickSummary> {
    const sum: TickSummary = { expiredPayments: 0, abandoned: 0, graced: 0, suspended: 0, ended: 0, repaired: 0, emails: 0 };
    const now = this.now();
    const { prisma } = this.d;

    sum.expiredPayments = (await prisma.payment.updateMany({
      where: { status: 'PENDING', expiresAt: { lte: now } }, data: { status: 'EXPIRED' },
    })).count;

    sum.abandoned = (await prisma.subscription.updateMany({
      where: {
        status: 'PENDING_PAYMENT', createdAt: { lte: new Date(now.getTime() - ABANDONED_AFTER_DAYS * DAY_MS) },
        payments: { none: { OR: [{ status: 'PAID' }, { status: 'PENDING', expiresAt: { gt: now } }] } },
      },
      data: { status: 'ENDED' },
    })).count;

    const subs = await prisma.subscription.findMany({
      where: { status: { in: ['ACTIVE', 'GRACE', 'SUSPENDED'] } }, include: { instance: true }, orderBy: { updatedAt: 'asc' }, take: BATCH,
    });
    for (const sub of subs) {
      try {
        await this.processOne(sub.id, now, sum);
      } catch (e) {
        // One bad row must not stop the others; the next tick retries it.
        this.d.logger.error({ subscriptionId: sub.id, errName: (e as Error).name }, 'billing tick failed for a subscription');
      }
    }

    // Enforcement for rows ended by retention: the instance must be gone even if the delete conflicted once.
    const ended = await prisma.subscription.findMany({
      where: { status: 'ENDED', instanceId: { not: null }, instance: { status: { notIn: ['DELETED', 'DELETING'] } } },
      include: { instance: true }, take: BATCH,
    });
    for (const sub of ended) {
      if (!sub.instance) continue;
      await this.tryInstance(() => this.d.commands.delete(sub.tenantId, sub.instance!.id), sub.id, 'delete');
    }
    return sum;
  }

  private async processOne(subscriptionId: string, now: Date, sum: TickSummary): Promise<void> {
    const { prisma } = this.d;
    let sub = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId }, include: { instance: true } });
    if (!['ACTIVE', 'GRACE', 'SUSPENDED'].includes(sub.status)) return;

    // The instance was deleted by someone else (operator, customer before this feature): nothing left to bill.
    if (sub.instance && (sub.instance.status === 'DELETED' || sub.instance.status === 'DELETING')) {
      await prisma.subscription.updateMany({ where: { id: sub.id, status: sub.status }, data: { status: 'ENDED' } });
      return;
    }

    // Repairs for work a crash may have left undone after a verified payment.
    if (!sub.instanceId) {
      await this.d.billing.ensureInstance(sub.id);
      sum.repaired += 1;
    } else if (sub.restartPending) {
      await this.d.billing.restartIfPending(sub.id);
      sum.repaired += 1;
    }

    for (let guard = 0; guard < 4; guard++) {
      const step = nextTransition(sub, now);
      if (!step) break;
      const from = sub.status;
      if (step.to === 'GRACE') {
        const cas = await prisma.subscription.updateMany({ where: { id: sub.id, status: from, currentPeriodEnd: sub.currentPeriodEnd }, data: { status: 'GRACE', graceEndsAt: step.graceEndsAt } });
        if (cas.count === 0) return; // a payment or another replica won
        sum.graced += 1;
      } else if (step.to === 'SUSPENDED') {
        const cas = await prisma.subscription.updateMany({
          where: { id: sub.id, status: from }, data: { status: 'SUSPENDED', suspendedAt: step.suspendedAt, retentionEndsAt: step.retentionEndsAt },
        });
        if (cas.count === 0) return;
        sum.suspended += 1;
        if (sub.instanceId) await recordEvent(prisma, sub.instanceId, 'billing.suspended', 'Instance stopped: the subscription was not renewed');
      } else {
        const cas = await prisma.subscription.updateMany({ where: { id: sub.id, status: from }, data: { status: 'ENDED' } });
        if (cas.count === 0) return;
        sum.ended += 1;
        if (sub.instanceId) await recordEvent(prisma, sub.instanceId, 'billing.retention_elapsed', 'Instance deleted: the 30-day retention after suspension ended');
        // The final notice is sent once; the delete itself is retried by the enforcement pass if it conflicts.
        await this.notify(sub.tenantId, sub.id, 'deleted', sub.currentPeriodEnd ?? now, { periodEnd: sub.currentPeriodEnd, retentionEndsAt: sub.retentionEndsAt }, sum);
        if (sub.instance) await this.tryInstance(() => this.d.commands.delete(sub.tenantId, sub.instanceId!), sub.id, 'delete');
        return;
      }
      sub = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId }, include: { instance: true } });
    }

    // A suspended subscription must have a stopped instance, however many ticks it takes.
    if (sub.status === 'SUSPENDED' && sub.instance && sub.instanceId) {
      const s = sub.instance.status;
      if (s === 'ACTIVE' || s === 'DEGRADED' || s === 'STARTING' || s === 'CONFIGURING') {
        await this.tryInstance(() => this.d.commands.stop(sub.tenantId, sub.instanceId!), sub.id, 'stop');
      }
    }

    if (sub.currentPeriodEnd) {
      const sent = await prisma.billingNotice.findMany({ where: { subscriptionId: sub.id, periodEnd: sub.currentPeriodEnd }, select: { kind: true } });
      const kind = dueNotice(sub, now, sent.map((n) => n.kind));
      if (kind) {
        await this.notify(sub.tenantId, sub.id, kind, sub.currentPeriodEnd, {
          periodEnd: sub.currentPeriodEnd, graceEndsAt: sub.graceEndsAt, retentionEndsAt: sub.retentionEndsAt,
        }, sum);
      }
    }
  }

  /** Claims the (subscription, kind, period) row, sends, and releases the claim if sending failed. */
  private async notify(
    tenantId: string, subscriptionId: string, kind: NoticeKind, periodEnd: Date,
    ctx: { periodEnd: Date | null; graceEndsAt?: Date | null; retentionEndsAt?: Date | null }, sum: TickSummary,
  ): Promise<void> {
    if (!this.d.mailer.enabled) {
      this.d.logger.warn({ kind }, 'mail is not configured; billing notice skipped');
      return;
    }
    let claimId: string;
    try {
      claimId = (await this.d.prisma.billingNotice.create({ data: { subscriptionId, kind, periodEnd } })).id;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return; // another replica or an earlier tick sent it
      throw e;
    }
    const ok = await this.d.billing.sendEmail(tenantId, kind, { subscriptionId, ...ctx });
    if (ok) sum.emails += 1;
    else await this.d.prisma.billingNotice.delete({ where: { id: claimId } }).catch(() => undefined);
  }

  /** An instance operation that conflicts with one in flight is not an error: the next tick tries again. */
  private async tryInstance(fn: () => Promise<unknown>, subscriptionId: string, what: string): Promise<void> {
    try {
      await fn();
    } catch (e) {
      if (e instanceof ConflictError) {
        this.d.logger.info({ subscriptionId, what }, 'instance busy; billing action retried on the next tick');
        return;
      }
      this.d.logger.warn({ subscriptionId, what, errName: (e as Error).name }, 'billing instance action failed; retried on the next tick');
    }
  }
}

