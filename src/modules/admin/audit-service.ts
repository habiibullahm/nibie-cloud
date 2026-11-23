import { Prisma, type PrismaClient } from '@prisma/client';
import { ValidationError } from '../../shared/errors.js';
import { isUuid } from '../../shared/uuid.js';

/** Audit action of the first admin request from a Supabase sign-in session (always `aal2`); `targetId` is the session. */
export const ADMIN_SIGN_IN = 'SIGN_IN admin';
/** Audit action of a signed-in account that is not on `ADMIN_EMAILS` calling the admin API. */
export const ADMIN_DENIED = 'DENIED admin';

/** One row of the admin audit trail. */
export interface AuditEntry {
  id: string;
  actorEmail: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  detail: Prisma.JsonValue | null;
  createdAt: Date;
}

export interface AuditInput {
  actorEmail: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  /** A small JSON object, or null. Never a credential: see the model's comment. */
  detail: Prisma.InputJsonValue | null;
}

export interface AuditQuery {
  limit: number;
  cursor?: string;
  actorEmail?: string;
  targetId?: string;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** Pass back as `cursor` to read the next page; null when this is the last one. */
  nextCursor: string | null;
}

/**
 * The admin audit trail. Keyset pagination on (createdAt, id) so a page boundary is stable while new
 * rows arrive: an offset would repeat or skip rows as the trail grows during a read.
 */
export class AuditService {
  private readonly prisma: PrismaClient;

  constructor(deps: { prisma: PrismaClient }) {
    this.prisma = deps.prisma;
  }

  /**
   * `db` lets a data-changing action write its audit row in the same transaction as the change, so a change never
   * exists without its entry and an entry never describes a change that rolled back.
   */
  async record(input: AuditInput, db: PrismaClient | Prisma.TransactionClient = this.prisma): Promise<void> {
    // Prisma wants an explicit sentinel for a JSON null rather than JS null.
    await db.auditLog.create({ data: { ...input, detail: input.detail ?? Prisma.JsonNull } });
  }

  /** Writes the sign-in entry of an admin session unless one exists. True when this call wrote it. */
  async recordSignIn(actorEmail: string, sessionId: string, detail: Prisma.InputJsonValue): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`admin-sign-in:${sessionId}`}))`;
      const seen = await tx.auditLog.findFirst({ where: { action: ADMIN_SIGN_IN, targetId: sessionId }, select: { id: true } });
      if (seen) return false;
      await this.record({ actorEmail, action: ADMIN_SIGN_IN, targetType: 'session', targetId: sessionId, reason: null, detail }, tx);
      return true;
    });
  }

  async list(query: AuditQuery): Promise<AuditPage> {
    const { limit } = query;
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await this.prisma.auditLog.findMany({
      where: {
        ...(query.actorEmail ? { actorEmail: query.actorEmail } : {}),
        ...(query.targetId ? { targetId: query.targetId } : {}),
        ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      // Named columns, so a column added to the table later is not served until someone decides it should be.
      select: { id: true, actorEmail: true, action: true, targetType: true, targetId: true, reason: true, detail: true, createdAt: true },
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page,
      nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }
}

interface Cursor {
  createdAt: Date;
  id: string;
}

const encodeCursor = (c: Cursor): string => Buffer.from(`${c.createdAt.toISOString()}|${c.id}`, 'utf8').toString('base64url');

/** A cursor this service did not issue is a client bug, so it throws rather than silently returning page one. */
function decodeCursor(raw: string): Cursor {
  const [iso, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso ?? '');
  if (!isUuid(id) || Number.isNaN(createdAt.getTime()) || encodeCursor({ createdAt, id }) !== raw) {
    throw new ValidationError('Invalid audit cursor');
  }
  return { createdAt, id };
}
