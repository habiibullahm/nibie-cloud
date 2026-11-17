import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/** The waiting list refuses new entries beyond this many people in line (a flood must not grow the table without bound). */
export const MAX_WAITING = 2000;

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export type JoinResult = 'created' | 'exists' | 'full';

/**
 * Adds a person to the waiting list. The same address twice is `exists` and changes nothing (no overwrite of an earlier
 * entry, no status change), so the caller can answer both the same way and leak nothing about who is on the list.
 */
export async function joinWaitlist(db: Db, input: { name: string; email: string; useCase: string }): Promise<JoinResult> {
  const email = normalizeEmail(input.email);
  if ((await db.waitlistEntry.count({ where: { status: 'WAITING' } })) >= MAX_WAITING) {
    // Still no leak: a full list answers the same way for everyone, existing address or not.
    return 'full';
  }
  try {
    await db.waitlistEntry.create({ data: { email, name: input.name.trim(), useCase: input.useCase.trim() } });
    return 'created';
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return 'exists';
    throw e;
  }
}

/** Marks the person's entry REGISTERED once they hold a free instance. No entry, or already registered: nothing happens. */
export async function markWaitlistRegistered(db: Db, email: string, now: Date = new Date()): Promise<void> {
  await db.waitlistEntry.updateMany({
    where: { email: normalizeEmail(email), status: { in: ['WAITING', 'INVITED'] } },
    data: { status: 'REGISTERED', registeredAt: now },
  });
}
