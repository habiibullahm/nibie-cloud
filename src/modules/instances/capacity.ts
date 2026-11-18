import type { Plan, Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * How much of the server (or, with `planId`, of one plan) is spoken for: instances that exist (any state but DELETED, they
 * still hold RAM and disk), paid subscriptions still waiting for their instance, and purchases in progress (an unexpired
 * pending invoice). Compared with MAX_TOTAL_INSTANCES, or with the plan's stock, before a new purchase or creation is accepted.
 */
export async function totalLoad(db: Db, now: Date, planId?: string): Promise<number> {
  const plan = planId ? { planId } : {};
  const [instances, unfulfilled, inProgress] = await Promise.all([
    db.instance.count({ where: { ...plan, status: { not: 'DELETED' } } }),
    db.subscription.count({ where: { ...plan, instanceId: null, status: { in: ['ACTIVE', 'GRACE', 'SUSPENDED'] } } }),
    db.subscription.count({ where: { ...plan, status: 'PENDING_PAYMENT', payments: { some: { status: 'PENDING', expiresAt: { gt: now } } } } }),
  ]);
  return instances + unfulfilled + inProgress;
}

/** True when the plan's stock applies: a priced plan with a limit. The free plan is limited by FREE_BETA_SLOTS instead. */
export function hasStock(plan: Pick<Plan, 'monthlyPriceIdr' | 'stockLimit'>): plan is { monthlyPriceIdr: number; stockLimit: number } {
  return plan.monthlyPriceIdr !== null && plan.stockLimit !== null;
}

/** Stock still for sale on this plan, or null when its stock does not apply (no limit, or the free plan). */
export async function stockLeft(db: Db, plan: Pick<Plan, 'id' | 'monthlyPriceIdr' | 'stockLimit'>, now: Date): Promise<number | null> {
  if (!hasStock(plan)) return null;
  return Math.max(0, plan.stockLimit - (await totalLoad(db, now, plan.id)));
}
