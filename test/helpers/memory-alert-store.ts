import type { AlertRecord, AlertSeverityName, AlertStore } from '../../src/modules/ops/alert-store.js';

/** In-memory AlertStore with the same compare-and-set rules as the Prisma one, for unit tests. */
export class MemoryAlertStore implements AlertStore {
  readonly rows = new Map<string, AlertRecord>();

  async get(key: string): Promise<AlertRecord | null> {
    const r = this.rows.get(key);
    return r ? { ...r } : null;
  }

  async open(a: { key: string; severity: AlertSeverityName; title: string; detail: string; now: Date }): Promise<AlertRecord> {
    const prev = this.rows.get(a.key);
    if (!prev || prev.resolvedAt !== null) {
      const row: AlertRecord = { dedupeKey: a.key, severity: a.severity, title: a.title, detail: a.detail, firstSeenAt: a.now, lastSeenAt: a.now, lastSentAt: null, sendCount: 0, resolvedAt: null };
      this.rows.set(a.key, row);
      return { ...row };
    }
    prev.severity = a.severity;
    prev.title = a.title;
    prev.detail = a.detail;
    prev.lastSeenAt = a.now;
    return { ...prev };
  }

  async claimSend(key: string, now: Date, notAfter: Date | null): Promise<boolean> {
    const r = this.rows.get(key);
    if (!r || r.resolvedAt !== null) return false;
    if (r.lastSentAt !== null && (notAfter === null || r.lastSentAt.getTime() > notAfter.getTime())) return false;
    r.lastSentAt = now;
    r.sendCount += 1;
    return true;
  }

  async restoreSend(key: string, lastSentAt: Date | null, sendCount: number): Promise<void> {
    const r = this.rows.get(key);
    if (r) { r.lastSentAt = lastSentAt; r.sendCount = sendCount; }
  }

  async resolve(key: string, now: Date): Promise<AlertRecord | null> {
    const r = this.rows.get(key);
    if (!r || r.resolvedAt !== null) return null;
    r.resolvedAt = now;
    return { ...r };
  }

  async listOpen(prefix?: string): Promise<AlertRecord[]> {
    return [...this.rows.values()].filter((r) => r.resolvedAt === null && (prefix === undefined || r.dedupeKey.startsWith(prefix))).map((r) => ({ ...r }));
  }

  async purgeResolvedBefore(before: Date): Promise<number> {
    let n = 0;
    for (const [k, r] of this.rows) if (r.resolvedAt !== null && r.resolvedAt.getTime() < before.getTime()) { this.rows.delete(k); n += 1; }
    return n;
  }
}
