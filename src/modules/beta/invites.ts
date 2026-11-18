import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export interface BetaInviteRow {
  id: string;
  email: string;
  note: string | null;
  addedBy: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

/** The columns an invite row is served with. Named, so a column added later is not returned until someone decides it should be. */
export const INVITE_SELECT = { id: true, email: true, note: true, addedBy: true, createdAt: true, revokedAt: true } as const;

/** Invites are matched on the trimmed, lowercased address, the same way `BETA_ALLOWED_EMAILS` is read. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Hides most of an address for display: `husniattin@gmail.com` becomes `h*******n@gmail.com`. The domain stays so an admin can
 * tell addresses apart; a one or two character local part is fully starred so nothing leaks from short names.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  const masked = local.length <= 2 ? '*'.repeat(local.length) : `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}`;
  return `${masked}${email.slice(at)}`;
}

/** An invite as the admin API returns it: the invited address and the admin who added it are masked. */
export function maskInvite(row: BetaInviteRow): BetaInviteRow {
  return { ...row, email: maskEmail(row.email), addedBy: row.addedBy ? maskEmail(row.addedBy) : null };
}

/** True while the address has an invite that has not been revoked. */
export async function isInvited(db: Db, email: string): Promise<boolean> {
  const n = await db.betaInvite.count({ where: { email: normalizeEmail(email), revokedAt: null } });
  return n > 0;
}

/** Adds an invite. Inviting an address again keeps its row, clears a revocation and refreshes the note and author. */
export async function addInvite(db: Db, input: { email: string; note?: string | null; addedBy?: string | null }): Promise<BetaInviteRow> {
  const email = normalizeEmail(input.email);
  const note = input.note ?? null;
  const addedBy = input.addedBy ?? null;
  return db.betaInvite.upsert({
    where: { email },
    create: { email, note, addedBy },
    update: { revokedAt: null, note, addedBy },
    select: INVITE_SELECT,
  });
}

/** Revokes an invite and returns whether an active one existed. The row stays for the history. */
export async function revokeInvite(db: Db, email: string, now: Date = new Date()): Promise<boolean> {
  const { count } = await db.betaInvite.updateMany({ where: { email: normalizeEmail(email), revokedAt: null }, data: { revokedAt: now } });
  return count > 0;
}

/** Every invite, newest first. `includeRevoked` is off by default. */
export async function listInvites(db: Db, o: { includeRevoked?: boolean } = {}): Promise<BetaInviteRow[]> {
  return db.betaInvite.findMany({
    where: o.includeRevoked ? {} : { revokedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: INVITE_SELECT,
  });
}
