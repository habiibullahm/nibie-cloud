import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Free beta preview slots left: `slots` minus the instances (any state but DELETED) on a plan without a price.
 * The unpriced plan is the free plan; nothing else in the system is free.
 */
export async function freeBetaRemaining(db: Db, slots: number): Promise<number> {
  if (slots <= 0) return 0;
  const used = await db.instance.count({ where: { status: { not: 'DELETED' }, plan: { monthlyPriceIdr: null } } });
  return Math.max(0, slots - used);
}
