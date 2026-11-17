import type { PrismaClient } from '@prisma/client';
import type { Logger } from '../../shared/logger.js';
import { renderWaitlistInvite } from '../billing/email-templates.js';
import type { Mailer } from '../billing/mailer.js';
import { freeBetaUsed, MAX_INVITE_FAILURES, reservedInvites } from '../instances/free-beta.js';

const HOUR_MS = 3_600_000;
/** How long an invited person holds their slot before it goes to the next one in line. */
export const CLAIM_WINDOW_MS = 48 * HOUR_MS;
/** One tick never invites more than this many, however many slots open at once. */
const MAX_PER_RUN = 25;

export interface InviteSummary {
  /** Entries moved to REGISTERED because the person now holds a free instance. */
  registered: number;
  /** Invitations sent in this run. */
  invited: number;
  /** Invitations that could not be sent (the entry goes back to WAITING and keeps its place). */
  failed: number;
}

export interface WaitlistInviterDeps {
  prisma: PrismaClient;
  mailer: Mailer;
  logger: Logger;
  /** `FREE_BETA_SLOTS`. 0 or less: nobody is ever invited. */
  slots: number;
  /** Where the invitation sends the person, e.g. `https://cloud.nibie.app/dashboard/register`. */
  registerUrl: string;
  now?: () => Date;
  /** `run()` does nothing when called again sooner than this (the scheduler ticks every 15 s). Default 1 minute. */
  minIntervalMs?: number;
}

/**
 * The automatic part of the waiting list. Each run (1) marks entries REGISTERED once the person holds a free instance and
 * (2) invites the oldest WAITING entries, never more than the free slots that are neither used nor held by an open
 * invitation. There is no approval step. The slot arithmetic runs under one database advisory lock, so two replicas or two
 * overlapping runs cannot invite the same slot twice; the entry is claimed (INVITED) before the email is sent and goes
 * back to WAITING when sending fails, the same pattern as the billing notices.
 */
export class WaitlistInviter {
  private lastRun = 0;
  private readonly now: () => Date;

  constructor(private readonly d: WaitlistInviterDeps) {
    this.now = d.now ?? (() => new Date());
  }

  /** Throttled entry point for the scheduler. Never throws. */
  async run(): Promise<InviteSummary | null> {
    const t = Date.now();
    if (t - this.lastRun < (this.d.minIntervalMs ?? 60_000)) return null;
    this.lastRun = t;
    try {
      return await this.runOnce();
    } catch (e) {
      this.d.logger.error({ errName: (e as Error).name }, 'waiting list run failed');
      return null;
    }
  }

  async runOnce(): Promise<InviteSummary> {
    const { prisma, mailer, logger } = this.d;
    const now = this.now();
    const sum: InviteSummary = { registered: 0, invited: 0, failed: 0 };

    // Anyone who got a free instance, invited or not, is done waiting.
    const done = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT e."id" FROM "WaitlistEntry" e
      WHERE e."status" IN ('WAITING', 'INVITED')
        AND EXISTS (
          SELECT 1 FROM "User" u
          JOIN "TenantMember" m ON m."userId" = u."id"
          JOIN "Instance" i ON i."tenantId" = m."tenantId"
          JOIN "Plan" p ON p."id" = i."planId"
          WHERE lower(u."email") = e."email" AND i."status" <> 'DELETED' AND p."monthlyPriceIdr" IS NULL)`;
    if (done.length > 0) {
      sum.registered = (await prisma.waitlistEntry.updateMany({
        where: { id: { in: done.map((r) => r.id) }, status: { in: ['WAITING', 'INVITED'] } },
        data: { status: 'REGISTERED', registeredAt: now },
      })).count;
    }

    if (this.d.slots <= 0) return sum;
    if (!mailer.enabled) {
      logger.debug('mail is not configured; the waiting list cannot invite anyone');
      return sum;
    }

    const expiresAt = new Date(now.getTime() + CLAIM_WINDOW_MS);
    const claimed = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('waitlist-invite'))`;
      const room = this.d.slots - (await freeBetaUsed(tx)) - (await reservedInvites(tx, now));
      if (room <= 0) return [];
      const next = await tx.waitlistEntry.findMany({
        where: { status: 'WAITING', inviteFailures: { lt: MAX_INVITE_FAILURES } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: Math.min(room, MAX_PER_RUN),
      });
      const won: typeof next = [];
      for (const e of next) {
        const cas = await tx.waitlistEntry.updateMany({
          where: { id: e.id, status: 'WAITING' }, data: { status: 'INVITED', invitedAt: now, inviteExpiresAt: expiresAt },
        });
        if (cas.count === 1) won.push(e);
      }
      return won;
    });

    for (const e of claimed) {
      let sent = false;
      try {
        await mailer.send({ to: e.email, ...renderWaitlistInvite({ name: e.name, claimUntil: expiresAt, registerUrl: this.d.registerUrl }) });
        sent = true;
      } catch (err) {
        logger.warn({ errName: (err as Error).name }, 'waiting list invitation not sent');
      }
      if (sent) {
        sum.invited += 1;
      } else {
        sum.failed += 1;
        // Back in line with its place kept; a repeatedly failing address is skipped after MAX_INVITE_FAILURES.
        await prisma.waitlistEntry.updateMany({
          where: { id: e.id, status: 'INVITED', invitedAt: now },
          data: { status: 'WAITING', invitedAt: null, inviteExpiresAt: null, inviteFailures: { increment: 1 } },
        });
      }
    }
    if (sum.invited > 0) logger.info({ invited: sum.invited }, 'waiting list invitations sent');
    return sum;
  }
}
