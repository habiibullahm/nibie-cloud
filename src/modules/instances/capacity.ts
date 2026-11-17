import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * How much of the server is spoken for: instances that exist (any state but DELETED, they still hold RAM and disk),
 * paid subscriptions still waiting for their instance, and purchases in progress (an unexpired pending invoice).
 * Compared with MAX_TOTAL_INSTANCES before a new purchase or creation is accepted.
 */
export async function totalLoad(db: Db, now: Date): Promise<number> {
  const [instances, unfulfilled, inProgress] = await Promise.all([
    db.instance.count({ where: { status: { not: 'DELETED' } } }),
    db.subscription.count({ where: { instanceId: null, status: { in: ['ACTIVE', 'GRACE', 'SUSPENDED'] } } }),
    db.subscription.count({ where: { status: 'PENDING_PAYMENT', payments: { some: { status: 'PENDING', expiresAt: { gt: now } } } } }),
  ]);
  return instances + unfulfilled + inProgress;
}
