import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/** An entry that failed to receive its invitation this many times is skipped by the queue. */
export const MAX_INVITE_FAILURES = 3;

/** Instances (any state but DELETED) on a plan without a price. The unpriced plan is the free plan; nothing else is free. */
export async function freeBetaUsed(db: Db): Promise<number> {
  return db.instance.count({ where: { status: { not: 'DELETED' }, plan: { monthlyPriceIdr: null } } });
}

/**
 * Slots held for invited waiting-list entries: INVITED, window still open, and no free instance yet (once the person has
 * created theirs the instance itself is counted, so it must not be counted twice).
 */
export async function reservedInvites(db: Db, now: Date): Promise<number> {
  const rows = await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM "WaitlistEntry" e
    WHERE e."status" = 'INVITED' AND e."inviteExpiresAt" > ${now}
      AND NOT EXISTS (
        SELECT 1 FROM "User" u
        JOIN "TenantMember" m ON m."userId" = u."id"
        JOIN "Instance" i ON i."tenantId" = m."tenantId"
        JOIN "Plan" p ON p."id" = i."planId"
        WHERE lower(u."email") = e."email" AND i."status" <> 'DELETED' AND p."monthlyPriceIdr" IS NULL)`;
  return Number(rows[0]?.n ?? 0);
}

/** True while the email holds an open invitation (a reserved slot), whatever the counters say. */
export async function hasActiveInvite(db: Db, email: string, now: Date): Promise<boolean> {
  const n = await db.waitlistEntry.count({ where: { email: email.trim().toLowerCase(), status: 'INVITED', inviteExpiresAt: { gt: now } } });
  return n > 0;
}

export interface BetaCountOptions {
  /**
   * People already waiting come first: while the platform can send invitations, a freed slot belongs to the oldest waiting
   * entry, not to whoever visits first. Off when email is not configured (nothing would ever invite them).
   */
  queueFirst?: boolean;
  now?: Date;
}

/**
 * Free beta preview slots a stranger can still take: `slots`, minus instances on the free plan, minus slots held by open
 * invitations, minus (when `queueFirst`) the people waiting ahead.
 */
export async function freeBetaRemaining(db: Db, slots: number, o: BetaCountOptions = {}): Promise<number> {
  if (slots <= 0) return 0;
  const now = o.now ?? new Date();
  const [used, reserved, waiting] = await Promise.all([
    freeBetaUsed(db),
    reservedInvites(db, now),
    o.queueFirst ? db.waitlistEntry.count({ where: { status: 'WAITING', inviteFailures: { lt: MAX_INVITE_FAILURES } } }) : Promise.resolve(0),
  ]);
  return Math.max(0, slots - used - reserved - waiting);
}
