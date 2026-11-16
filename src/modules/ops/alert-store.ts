import type { PrismaClient } from '@prisma/client';

export type AlertSeverityName = 'CRITICAL' | 'WARNING' | 'INFO';

export interface AlertRecord {
  dedupeKey: string;
  severity: AlertSeverityName;
  title: string;
  detail: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastSentAt: Date | null;
  sendCount: number;
  resolvedAt: Date | null;
}

/** Persistence for operator alerts. Every write is a compare-and-set, so two replicas never both send. */
export interface AlertStore {
  get(key: string): Promise<AlertRecord | null>;
  /** Creates the alert, reopens a resolved one (counters reset), or refreshes an open one. */
  open(a: { key: string; severity: AlertSeverityName; title: string; detail: string; now: Date }): Promise<AlertRecord>;
  /**
   * Marks the alert as sent now when it is open and was never sent, or last sent at or before `notAfter`
   * (`notAfter` null: never send twice). True means this caller owns the delivery.
   */
  claimSend(key: string, now: Date, notAfter: Date | null): Promise<boolean>;
  /** Undoes a claim after a failed delivery so the next scan tries again. */
  restoreSend(key: string, lastSentAt: Date | null, sendCount: number): Promise<void>;
  /** Closes an open alert. Returns the closed record, or null when it was not open. */
  resolve(key: string, now: Date): Promise<AlertRecord | null>;
  listOpen(prefix?: string): Promise<AlertRecord[]>;
  purgeResolvedBefore(before: Date): Promise<number>;
}

export class PrismaAlertStore implements AlertStore {
  constructor(private readonly prisma: PrismaClient) {}

  async get(key: string): Promise<AlertRecord | null> {
    return this.prisma.operatorAlert.findUnique({ where: { dedupeKey: key } });
  }

  async open(a: { key: string; severity: AlertSeverityName; title: string; detail: string; now: Date }): Promise<AlertRecord> {
    const fields = { severity: a.severity, title: a.title, detail: a.detail };
    const reopened = await this.prisma.operatorAlert.updateMany({
      where: { dedupeKey: a.key, resolvedAt: { not: null } },
      data: { ...fields, firstSeenAt: a.now, lastSeenAt: a.now, lastSentAt: null, sendCount: 0, resolvedAt: null },
    });
    if (reopened.count === 0) {
      try {
        await this.prisma.operatorAlert.create({ data: { dedupeKey: a.key, ...fields, firstSeenAt: a.now, lastSeenAt: a.now } });
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e;
        // The row exists and is open (or another replica just created it): refresh it.
        await this.prisma.operatorAlert.updateMany({ where: { dedupeKey: a.key, resolvedAt: null }, data: { ...fields, lastSeenAt: a.now } });
      }
    }
    return this.prisma.operatorAlert.findUniqueOrThrow({ where: { dedupeKey: a.key } });
  }

  async claimSend(key: string, now: Date, notAfter: Date | null): Promise<boolean> {
    const res = await this.prisma.operatorAlert.updateMany({
      where: { dedupeKey: key, resolvedAt: null, OR: [{ lastSentAt: null }, ...(notAfter ? [{ lastSentAt: { lte: notAfter } }] : [])] },
      data: { lastSentAt: now, sendCount: { increment: 1 } },
    });
    return res.count === 1;
  }

  async restoreSend(key: string, lastSentAt: Date | null, sendCount: number): Promise<void> {
    await this.prisma.operatorAlert.updateMany({ where: { dedupeKey: key }, data: { lastSentAt, sendCount } });
  }

  async resolve(key: string, now: Date): Promise<AlertRecord | null> {
    const res = await this.prisma.operatorAlert.updateMany({ where: { dedupeKey: key, resolvedAt: null }, data: { resolvedAt: now } });
    if (res.count === 0) return null;
    return this.prisma.operatorAlert.findUnique({ where: { dedupeKey: key } });
  }

  async listOpen(prefix?: string): Promise<AlertRecord[]> {
    return this.prisma.operatorAlert.findMany({
      where: { resolvedAt: null, ...(prefix !== undefined ? { dedupeKey: { startsWith: prefix } } : {}) },
      orderBy: { firstSeenAt: 'asc' },
      take: 500,
    });
  }

  async purgeResolvedBefore(before: Date): Promise<number> {
    return (await this.prisma.operatorAlert.deleteMany({ where: { resolvedAt: { lt: before } } })).count;
  }
}
