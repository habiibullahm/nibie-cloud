import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/** The waiting list refuses new entries beyond this many people in line (a flood must not grow the table without bound). */
export const MAX_WAITING = 2000;
/** Unconfirmed entries are bounded separately: a flood of unconfirmed addresses must not lock real people out of the queue. */
export const MAX_UNCONFIRMED = 1000;
/** How long a confirmation link works. An unconfirmed entry is deleted once its link has expired. */
export const CONFIRM_WINDOW_MS = 24 * 3_600_000;
/** Joining again with an unconfirmed address sends a new link, at most this often per address. */
export const CONFIRM_RESEND_AFTER_MS = 10 * 60_000;

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** SHA-256 (hex) of a confirmation token. Only the hash is stored; the token is only in the email. */
export const hashConfirmToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** 32 random bytes, base64url: 43 characters. */
export const CONFIRM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type JoinResult =
  /** Send a confirmation link carrying `token` to this address. */
  | { kind: 'send'; id: string; token: string; name: string; expiresAt: Date }
  /** Nothing to do: the address is already confirmed, or a link was sent to it moments ago. */
  | { kind: 'exists' }
  | { kind: 'full' };

/**
 * Adds a person to the waiting list as UNCONFIRMED and returns the token for the confirmation email. The same address
 * again changes nothing that was stored (no overwrite of the name or use case, no status change); an address that is
 * still unconfirmed only gets a fresh link, at most once per `CONFIRM_RESEND_AFTER_MS`. The caller answers every case
 * the same way, so the list cannot be probed for who joined.
 */
export async function joinWaitlist(db: Db, input: { name: string; email: string; useCase: string }, now: Date = new Date()): Promise<JoinResult> {
  const email = normalizeEmail(input.email);
  const [waiting, unconfirmed] = await Promise.all([
    db.waitlistEntry.count({ where: { status: 'WAITING' } }),
    db.waitlistEntry.count({ where: { status: 'UNCONFIRMED' } }),
  ]);
  // Still no leak: a full list answers the same way for everyone, existing address or not.
  if (waiting >= MAX_WAITING || unconfirmed >= MAX_UNCONFIRMED) return { kind: 'full' };

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + CONFIRM_WINDOW_MS);
  const link = { confirmTokenHash: hashConfirmToken(token), confirmSentAt: now, confirmExpiresAt: expiresAt };

  const existing = await db.waitlistEntry.findUnique({ where: { email }, select: { id: true, name: true, status: true, confirmSentAt: true } });
  if (existing) {
    if (existing.status !== 'UNCONFIRMED') return { kind: 'exists' };
    if (existing.confirmSentAt && now.getTime() - existing.confirmSentAt.getTime() < CONFIRM_RESEND_AFTER_MS) return { kind: 'exists' };
    // Compare-and-set on the previous send time, so two requests at once send one link, not two.
    const cas = await db.waitlistEntry.updateMany({
      where: { id: existing.id, status: 'UNCONFIRMED', confirmSentAt: existing.confirmSentAt },
      data: link,
    });
    return cas.count === 1 ? { kind: 'send', id: existing.id, token, name: existing.name, expiresAt } : { kind: 'exists' };
  }
  try {
    const name = input.name.trim();
    const row = await db.waitlistEntry.create({ data: { email, name, useCase: input.useCase.trim(), status: 'UNCONFIRMED', ...link }, select: { id: true } });
    return { kind: 'send', id: row.id, token, name, expiresAt };
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return { kind: 'exists' };
    throw e;
  }
}

/** A confirmation email could not be sent: clear the send time so the person can ask for a new link at once. */
export async function forgetConfirmSend(db: Db, id: string): Promise<void> {
  await db.waitlistEntry.updateMany({ where: { id, status: 'UNCONFIRMED' }, data: { confirmSentAt: null } });
}

export type ConfirmResult = 'confirmed' | 'invalid';

/**
 * Confirms the address behind `token`: the entry becomes WAITING and takes its place in line by the time it joined. A
 * link that was already used answers `confirmed` again (a second click is not an error); an unknown or expired link is
 * `invalid`.
 */
export async function confirmWaitlist(db: Db, token: string, now: Date = new Date()): Promise<ConfirmResult> {
  if (!CONFIRM_TOKEN_PATTERN.test(token)) return 'invalid';
  const e = await db.waitlistEntry.findUnique({
    where: { confirmTokenHash: hashConfirmToken(token) },
    select: { id: true, status: true, confirmExpiresAt: true },
  });
  if (!e) return 'invalid';
  if (e.status !== 'UNCONFIRMED') return 'confirmed';
  if (!e.confirmExpiresAt || e.confirmExpiresAt <= now) return 'invalid';
  await db.waitlistEntry.updateMany({ where: { id: e.id, status: 'UNCONFIRMED' }, data: { status: 'WAITING', confirmedAt: now } });
  return 'confirmed';
}

/** Deletes unconfirmed entries whose link has expired: nobody confirmed the address, so nothing about it is kept. */
export async function purgeUnconfirmed(db: Db, now: Date = new Date()): Promise<number> {
  return (await db.waitlistEntry.deleteMany({ where: { status: 'UNCONFIRMED', confirmExpiresAt: { lte: now } } })).count;
}

/** Marks the person's entry REGISTERED once they hold a free instance. No entry, or already registered: nothing happens. */
export async function markWaitlistRegistered(db: Db, email: string, now: Date = new Date()): Promise<void> {
  await db.waitlistEntry.updateMany({
    where: { email: normalizeEmail(email), status: { in: ['UNCONFIRMED', 'WAITING', 'INVITED'] } },
    data: { status: 'REGISTERED', registeredAt: now },
  });
}
