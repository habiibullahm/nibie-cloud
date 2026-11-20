import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { NotFoundError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import { NANO_PER_USD, type NibieRouterClient, type RouterUsage } from './nibierouter-client.js';

/** Bounds of an admin-set rate (Rupiah per US$1); the database checks the same range. */
export const RATE_MIN_IDR = 5_000;
export const RATE_MAX_IDR = 50_000;
/** Bounds of the customer's reminder threshold; the database checks the same range. */
export const ALERT_MIN_IDR = 1_000;
export const ALERT_MAX_IDR = 1_000_000;

const USAGE_TTL_MS = 60_000;
const RATE_TTL_MS = 10 * 60_000;
const CHECK_EVERY_MS = 60 * 60_000;

export const alertBody = z.object({ enabled: z.boolean(), thresholdIdr: z.number().int().min(ALERT_MIN_IDR).max(ALERT_MAX_IDR) }).strict();
export const rateBody = z.object({ idrPerUsd: z.number().int().min(RATE_MIN_IDR).max(RATE_MAX_IDR).nullable(), reason: z.string().trim().min(3).max(500) }).strict();

/** Rupiah for an amount in nano-USD, rounded down. */
export function nanoToIdr(amountNano: bigint, idrPerUsd: number): number {
  return Number((amountNano * BigInt(idrPerUsd)) / NANO_PER_USD);
}
const nanoToUsd = (amountNano: bigint): number => Number(amountNano) / Number(NANO_PER_USD);

export interface AiRate {
  idrPerUsd: number | null;
  /** `admin`: set on the Pengaturan page; `router`: NibieRouter's own rate; null: neither is available. */
  source: 'admin' | 'router' | null;
}

export interface AiAccountView {
  rate: AiRate;
  /** False when the tenant has no NibieRouter user yet (no instance on NibieRouter): balance and usage are empty. */
  hasAccount: boolean;
  balanceUsd: number;
  /** Null when no rate is available; the dashboard then shows US$. */
  balanceIdr: number | null;
  spend30dUsd: number;
  spend30dIdr: number | null;
  daily: { day: string; requests: number; costUsd: number; costIdr: number | null }[];
  models: { model: string; requests: number; costUsd: number; costIdr: number | null }[];
  alert: { enabled: boolean; thresholdIdr: number };
}

/**
 * The tenant's NibieRouter balance and usage shown in Rupiah, the low-balance reminder, and the AI credit rate. The rate is
 * the admin's override when set, otherwise the router's own `idr_per_usd` (owner, 2026-11-20). Router answers are cached
 * per tenant for a minute so the Billing page does not call the router on every load.
 */
export class AiAccountService {
  private readonly usage = new Map<string, { at: number; value: RouterUsage }>();
  private routerRate: { at: number; value: number | null } | null = null;
  private lastCheck = 0;

  constructor(private readonly d: { prisma: PrismaClient; client: NibieRouterClient; logger: Logger; now?: () => number }) {}

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  async rate(): Promise<AiRate> {
    const row = await this.d.prisma.billingSetting.findUnique({ where: { id: 1 } });
    if (row?.aiCreditIdrPerUsd) return { idrPerUsd: row.aiCreditIdrPerUsd, source: 'admin' };
    const router = await this.routerIdrPerUsd();
    return router ? { idrPerUsd: router, source: 'router' } : { idrPerUsd: null, source: null };
  }

  /** The router's rate, cached; while the router is down the last known value is used. Never throws. */
  async routerIdrPerUsd(): Promise<number | null> {
    const c = this.routerRate;
    if (c && this.now() - c.at < RATE_TTL_MS) return c.value;
    try {
      const value = await this.d.client.getIdrPerUsd();
      this.routerRate = { at: this.now(), value };
      return value;
    } catch (e) {
      this.d.logger.warn({ errName: (e as Error).name }, 'router rate not read; using the last known one');
      return c?.value ?? null;
    }
  }

  async view(tenantId: string): Promise<AiAccountView> {
    const tenant = await this.d.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { routerUserId: true, aiLowAlert: true, aiLowThresholdIdr: true },
    });
    if (!tenant) throw new NotFoundError('Tenant not found');
    const rate = await this.rate();
    const usage = tenant.routerUserId ? await this.cachedUsage(tenant.routerUserId) : null;
    const idr = (n: bigint) => (rate.idrPerUsd ? nanoToIdr(n, rate.idrPerUsd) : null);
    const balance = usage?.balanceNano ?? 0n;
    const spend = usage?.spend30dNano ?? 0n;
    return {
      rate,
      hasAccount: usage !== null,
      balanceUsd: nanoToUsd(balance),
      balanceIdr: idr(balance),
      spend30dUsd: nanoToUsd(spend),
      spend30dIdr: idr(spend),
      daily: (usage?.daily ?? []).map((x) => ({ day: x.day, requests: x.requests, costUsd: nanoToUsd(x.costNano), costIdr: idr(x.costNano) })),
      models: (usage?.models ?? []).map((x) => ({ model: x.model, requests: x.requests, costUsd: nanoToUsd(x.costNano), costIdr: idr(x.costNano) })),
      alert: { enabled: tenant.aiLowAlert, thresholdIdr: tenant.aiLowThresholdIdr },
    };
  }

  /** Saving the reminder starts it afresh: a balance already below the new threshold is reported at the next check. */
  async setAlert(tenantId: string, raw: unknown): Promise<{ enabled: boolean; thresholdIdr: number }> {
    const body = alertBody.parse(raw);
    const row = await this.d.prisma.tenant.update({
      where: { id: tenantId },
      data: { aiLowAlert: body.enabled, aiLowThresholdIdr: body.thresholdIdr, aiLowNotifiedAt: null },
      select: { aiLowAlert: true, aiLowThresholdIdr: true },
    });
    return { enabled: row.aiLowAlert, thresholdIdr: row.aiLowThresholdIdr };
  }

  private async cachedUsage(userId: string): Promise<RouterUsage> {
    const c = this.usage.get(userId);
    if (c && this.now() - c.at < USAGE_TTL_MS) return c.value;
    const value = await this.d.client.getUsage(userId);
    this.usage.set(userId, { at: this.now(), value });
    return value;
  }

  /**
   * At most once an hour: one email per drop below the customer's threshold. Only tenants that ever received AI credit
   * (a DONE `CreditGrant`) are checked, so a free tenant whose balance is always 0 is never mailed. The claim on
   * `aiLowNotifiedAt` is a compare-and-set, so two runs never send the same reminder; a failed send gives it back.
   * Returns the number of reminders sent. Never throws.
   */
  async checkLowBalances(send: (tenantId: string, ctx: { balanceIdr: number; thresholdIdr: number }) => Promise<boolean>): Promise<number> {
    const now = this.now();
    if (now - this.lastCheck < CHECK_EVERY_MS) return 0;
    this.lastCheck = now;
    let sent = 0;
    try {
      const { idrPerUsd } = await this.rate();
      if (!idrPerUsd) return 0;
      const tenants = await this.d.prisma.tenant.findMany({
        where: { aiLowAlert: true, routerUserId: { not: null }, creditGrants: { some: { status: 'DONE' } } },
        select: { id: true, routerUserId: true, aiLowThresholdIdr: true, aiLowNotifiedAt: true },
        take: 500,
      });
      for (const t of tenants) {
        try {
          const usage = await this.d.client.getUsage(t.routerUserId as string);
          this.usage.set(t.routerUserId as string, { at: this.now(), value: usage });
          const balanceIdr = nanoToIdr(usage.balanceNano, idrPerUsd);
          if (balanceIdr >= t.aiLowThresholdIdr) {
            if (t.aiLowNotifiedAt) await this.d.prisma.tenant.update({ where: { id: t.id }, data: { aiLowNotifiedAt: null } });
            continue;
          }
          if (t.aiLowNotifiedAt) continue;
          const claim = await this.d.prisma.tenant.updateMany({ where: { id: t.id, aiLowNotifiedAt: null }, data: { aiLowNotifiedAt: new Date(now) } });
          if (claim.count === 0) continue;
          if (await send(t.id, { balanceIdr, thresholdIdr: t.aiLowThresholdIdr })) sent += 1;
          else await this.d.prisma.tenant.update({ where: { id: t.id }, data: { aiLowNotifiedAt: null } });
        } catch (e) {
          this.d.logger.warn({ tenantId: t.id, errName: (e as Error).name }, 'AI balance not checked for this tenant');
        }
      }
    } catch (e) {
      this.d.logger.warn({ errName: (e as Error).name }, 'AI low-balance check failed');
    }
    return sent;
  }
}
