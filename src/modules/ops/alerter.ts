import type { Logger } from '../../shared/logger.js';
import type { AlertSeverityName, AlertStore } from './alert-store.js';

export interface AlertInput {
  /** Names the condition, for example `instance-degraded:<instanceId>`. Ids and fixed codes only. */
  key: string;
  severity: AlertSeverityName;
  title: string;
  /** What happened, the impact and the next safe action. Fixed text and ids; never customer text or secrets. */
  detail?: string;
}

export type RaiseOutcome = 'sent' | 'suppressed' | 'unsent';
export type AlertSink = (text: string) => Promise<void>;

const HOUR = 3_600_000;
/** How long an open alert stays quiet before it is repeated. INFO is never repeated. */
const COOLDOWN_MS: Record<AlertSeverityName, number | null> = { CRITICAL: HOUR, WARNING: 6 * HOUR, INFO: null };
const RANK: Record<AlertSeverityName, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };
const STORM_LIMIT = 20;
const STORM_WINDOW_MS = 10 * 60_000;
const MAX_TEXT = 1500;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TELEGRAM_TOKEN = /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g;
const LONG_TOKEN = new RegExp(`\\b(?!${UUID}\\b)[A-Za-z0-9_-]{32,}\\b`, 'g');

/** Last line of defence: alert text is built from ids and fixed codes, but a long opaque string is never sent. */
export function sanitizeAlertText(text: string): string {
  return text.replace(TELEGRAM_TOKEN, '[disamarkan]').replace(LONG_TOKEN, '[disamarkan]').slice(0, MAX_TEXT);
}

const LABEL: Record<AlertSeverityName, string> = { CRITICAL: '🔴 KRITIS', WARNING: '🟠 PERHATIAN', INFO: 'ℹ️ INFO' };

function format(severity: AlertSeverityName, title: string, detail: string, reminder: number): string {
  const head = `${LABEL[severity]} · Nibie Cloud${reminder > 0 ? ` (pengingat ${reminder})` : ''}`;
  return sanitizeAlertText([head, title, detail].filter((s) => s.length > 0).join('\n'));
}

export interface AlerterDeps {
  store: AlertStore;
  /** Null: alerts are recorded but nothing is delivered (the operator channel is not configured). */
  sink: AlertSink | null;
  logger: Logger;
  now?: () => Date;
}

/**
 * Tells the operator about a condition once, repeats it after a cooldown while it lasts, and says so once when
 * it is gone. Never throws: a broken alert channel must not affect the service it reports on.
 */
export class Alerter {
  private readonly now: () => Date;
  private recentSends: number[] = [];

  constructor(private readonly d: AlerterDeps) {
    this.now = d.now ?? (() => new Date());
  }

  get enabled(): boolean {
    return this.d.sink !== null;
  }

  async raise(a: AlertInput): Promise<RaiseOutcome> {
    const now = this.now();
    try {
      const before = await this.d.store.get(a.key);
      // A condition that gets worse is reported at once, whatever the cooldown says.
      const escalated = before !== null && before.resolvedAt === null && RANK[a.severity] > RANK[before.severity];
      const rec = await this.d.store.open({ key: a.key, severity: a.severity, title: a.title, detail: a.detail ?? '', now });
      if (!this.d.sink) return 'unsent';
      if (this.stormed(now)) return 'unsent';
      const cooldown = COOLDOWN_MS[a.severity];
      const notAfter = escalated ? now : cooldown === null ? null : new Date(now.getTime() - cooldown);
      const claimed = await this.d.store.claimSend(a.key, now, notAfter);
      if (!claimed) return 'suppressed';
      try {
        await this.d.sink(format(a.severity, a.title, a.detail ?? '', rec.sendCount));
        this.recentSends.push(now.getTime());
        return 'sent';
      } catch (e) {
        await this.d.store.restoreSend(a.key, rec.lastSentAt, rec.sendCount).catch(() => undefined);
        this.d.logger.warn({ errName: (e as Error).name }, 'operator alert delivery failed; retried on the next scan');
        return 'unsent';
      }
    } catch (e) {
      this.d.logger.error({ errName: (e as Error).name }, 'operator alert could not be recorded');
      return 'unsent';
    }
  }

  /** Closes the alert. A recovery message goes out only if the operator had been told about it. */
  async resolve(key: string): Promise<boolean> {
    try {
      const rec = await this.d.store.resolve(key, this.now());
      if (!rec) return false;
      if (this.d.sink && rec.sendCount > 0) {
        await this.d.sink(sanitizeAlertText(`✅ PULIH · Nibie Cloud\n${rec.title}`)).catch((e: Error) => {
          this.d.logger.warn({ errName: e.name }, 'operator recovery message failed');
        });
      }
      return true;
    } catch (e) {
      this.d.logger.error({ errName: (e as Error).name }, 'operator alert could not be resolved');
      return false;
    }
  }

  /** Resolves every open alert under `prefix` whose condition no longer holds. Returns how many were closed. */
  async resolveMissing(prefix: string, activeKeys: ReadonlySet<string>): Promise<number> {
    let closed = 0;
    try {
      for (const rec of await this.d.store.listOpen(prefix)) {
        if (!activeKeys.has(rec.dedupeKey) && (await this.resolve(rec.dedupeKey))) closed += 1;
      }
    } catch (e) {
      this.d.logger.error({ errName: (e as Error).name }, 'operator alert sweep failed');
    }
    return closed;
  }

  private stormed(now: Date): boolean {
    const cutoff = now.getTime() - STORM_WINDOW_MS;
    this.recentSends = this.recentSends.filter((t) => t > cutoff);
    return this.recentSends.length >= STORM_LIMIT;
  }
}
