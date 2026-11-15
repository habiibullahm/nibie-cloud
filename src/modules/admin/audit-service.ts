import { Prisma, type PrismaClient } from '@prisma/client';

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

  async record(input: AuditInput): Promise<void> {
    // Prisma wants an explicit sentinel for a JSON null rather than JS null.
    await this.prisma.auditLog.create({ data: { ...input, detail: input.detail ?? Prisma.JsonNull } });
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
  const createdAt = iso ? new Date(iso) : new Date(Number.NaN);
  if (!iso || !id || Number.isNaN(createdAt.getTime())) throw new Error('invalid cursor');
  return { createdAt, id };
}
