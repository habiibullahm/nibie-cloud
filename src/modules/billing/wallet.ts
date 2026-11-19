import { randomUUID } from 'node:crypto';
import type { PaymentStatus, Prisma, PrismaClient, WalletEntryKind, WalletTopup } from '@prisma/client';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../shared/errors.js';
import { isUuid } from '../../shared/uuid.js';
import type { PaymentClient } from './payment-client.js';

/** One top-up, in whole rupiah (owner decision 2026-11-20). */
export const TOPUP_MIN_IDR = 10_000;
export const TOPUP_MAX_IDR = 2_000_000;
/** Most a wallet may hold: bounds fraud and mistakes and keeps stored balances small. */
export const WALLET_MAX_IDR = 5_000_000;
/** Largest single admin adjustment, either way. */
export const ADJUST_MAX_IDR = 2_000_000;
/** Same window as hosting invoices: QRIS allows 60 minutes at most. */
export const TOPUP_EXPIRY_MINUTES = 60;

export class InsufficientBalanceError extends AppError {
  constructor() {
    super('Not enough balance', 409, 'insufficient_balance');
  }
}

export class WalletLimitError extends AppError {
  constructor() {
    super(`A wallet can hold at most Rp ${WALLET_MAX_IDR}`, 409, 'wallet_limit');
  }
}

export interface WalletMove {
  tenantId: string;
  /** Signed: positive adds, negative takes. */
  amountIdr: number;
  kind: WalletEntryKind;
  /** With `kind`, unique: the same movement is applied at most once. */
  refId: string;
  note?: string | null;
  actorEmail?: string | null;
}

/**
 * Applies one movement inside the caller's transaction: locks the wallet row, refuses to go below zero, and writes the
 * ledger entry with the new balance. A movement already recorded (same kind and refId) changes nothing.
 */
export async function moveWallet(tx: Prisma.TransactionClient, m: WalletMove): Promise<{ balanceIdr: number; applied: boolean }> {
  if (!Number.isSafeInteger(m.amountIdr) || m.amountIdr === 0) throw new ValidationError('invalid amount');
  await tx.$executeRaw`INSERT INTO "Wallet" ("tenantId", "balanceIdr", "updatedAt") VALUES (${m.tenantId}::uuid, 0, now()) ON CONFLICT DO NOTHING`;
  const [row] = await tx.$queryRaw<{ balanceIdr: number }[]>`SELECT "balanceIdr" FROM "Wallet" WHERE "tenantId" = ${m.tenantId}::uuid FOR UPDATE`;
  const balance = row!.balanceIdr;
  const done = await tx.walletEntry.findUnique({ where: { kind_refId: { kind: m.kind, refId: m.refId } }, select: { id: true } });
  if (done) return { balanceIdr: balance, applied: false };
  const next = balance + m.amountIdr;
  if (next < 0) throw new InsufficientBalanceError();
  await tx.wallet.update({ where: { tenantId: m.tenantId }, data: { balanceIdr: next } });
  await tx.walletEntry.create({
    data: {
      tenantId: m.tenantId, amountIdr: m.amountIdr, kind: m.kind, refId: m.refId, balanceAfterIdr: next,
      note: m.note ?? null, actorEmail: m.actorEmail ?? null,
    },
  });
  return { balanceIdr: next, applied: true };
}

/** Current balance plus open (payable) top-ups: what the wallet would hold if they were all paid. */
async function committedIdr(tx: Prisma.TransactionClient, tenantId: string, now: Date): Promise<number> {
  const [w, open] = await Promise.all([
    tx.wallet.findUnique({ where: { tenantId }, select: { balanceIdr: true } }),
    tx.walletTopup.aggregate({ _sum: { amountIdr: true }, where: { tenantId, status: 'PENDING', expiresAt: { gt: now } } }),
  ]);
  return (w?.balanceIdr ?? 0) + (open._sum.amountIdr ?? 0);
}

/** Refuses a credit that would take the wallet (with open top-ups) above `WALLET_MAX_IDR`. */
export async function assertUnderCap(tx: Prisma.TransactionClient, tenantId: string, addIdr: number, now: Date): Promise<void> {
  if ((await committedIdr(tx, tenantId, now)) + addIdr > WALLET_MAX_IDR) throw new WalletLimitError();
}

/** Serializes wallet changes that check the cap, per tenant. */
export async function lockWallet(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'wallet:' + tenantId}))`;
}

export interface TopupView {
  id: string;
  amountIdr: number;
  status: PaymentStatus;
  /** Only while the invoice can still be paid. */
  paymentUrl: string | null;
  expiresAt: Date;
  paidAt: Date | null;
  createdAt: Date;
}

export interface WalletEntryView {
  id: string;
  amountIdr: number;
  kind: WalletEntryKind;
  balanceAfterIdr: number;
  note: string | null;
  createdAt: Date;
}

export interface WalletView {
  balanceIdr: number;
  /** WALLET_AUTO_RENEW: the billing tick renews subscriptions from this balance. */
  autoRenew: boolean;
  limits: { topupMinIdr: number; topupMaxIdr: number; maxBalanceIdr: number };
  entries: WalletEntryView[];
  topups: TopupView[];
}

export function topupView(t: WalletTopup, now: Date): TopupView {
  const payable = t.status === 'PENDING' && t.expiresAt.getTime() > now.getTime();
  return {
    id: t.id, amountIdr: t.amountIdr, status: t.status, paymentUrl: payable ? t.paymentUrl : null,
    expiresAt: t.expiresAt, paidAt: t.paidAt, createdAt: t.createdAt,
  };
}

/** Ledger rows as a customer sees them: the admin's address stays out. */
const ENTRY_SELECT = { id: true, amountIdr: true, kind: true, balanceAfterIdr: true, note: true, createdAt: true } as const;

export async function readWallet(prisma: PrismaClient | Prisma.TransactionClient, tenantId: string): Promise<{ balanceIdr: number; entries: WalletEntryView[] }> {
  const [w, entries] = await Promise.all([
    prisma.wallet.findUnique({ where: { tenantId }, select: { balanceIdr: true } }),
    prisma.walletEntry.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 50, select: ENTRY_SELECT }),
  ]);
  return { balanceIdr: w?.balanceIdr ?? 0, entries };
}

export interface WalletDeps {
  prisma: PrismaClient;
  paymentClient: PaymentClient;
  dashboardOrigin: string;
  autoRenew?: boolean;
  now?: () => Date;
}

/** Customer side of the wallet: the balance, its history, and top-ups paid by QRIS. The webhook credits them. */
export class WalletService {
  private readonly now: () => Date;

  constructor(private readonly d: WalletDeps) {
    this.now = d.now ?? (() => new Date());
  }

  async view(tenantId: string): Promise<WalletView> {
    const now = this.now();
    const [w, topups] = await Promise.all([
      readWallet(this.d.prisma, tenantId),
      this.d.prisma.walletTopup.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);
    return {
      ...w,
      autoRenew: this.d.autoRenew === true,
      limits: { topupMinIdr: TOPUP_MIN_IDR, topupMaxIdr: TOPUP_MAX_IDR, maxBalanceIdr: WALLET_MAX_IDR },
      topups: topups.map((t) => topupView(t, now)),
    };
  }

  async getTopup(tenantId: string, topupId: string): Promise<TopupView> {
    if (!isUuid(topupId)) throw new NotFoundError('Top-up not found');
    const t = await this.d.prisma.walletTopup.findFirst({ where: { id: topupId, tenantId } });
    if (!t) throw new NotFoundError('Top-up not found');
    return topupView(t, this.now());
  }

  /**
   * A SumoPod invoice for a top-up. The amount is checked here, never trusted from anywhere else. Replaying the same
   * `Idempotency-Key` returns the same top-up; reusing it with another amount is a conflict.
   */
  async startTopup(i: { tenantId: string; email: string; amountIdr: number; idempotencyKey: string }): Promise<TopupView> {
    if (!i.idempotencyKey || i.idempotencyKey.length > 128) throw new ValidationError('invalid idempotency key');
    if (!Number.isInteger(i.amountIdr) || i.amountIdr < TOPUP_MIN_IDR || i.amountIdr > TOPUP_MAX_IDR) {
      throw new ValidationError(`Top-up must be between Rp ${TOPUP_MIN_IDR} and Rp ${TOPUP_MAX_IDR}`);
    }
    const now = this.now();
    const prepared = await this.d.prisma.$transaction(async (tx) => {
      await lockWallet(tx, i.tenantId);
      const existing = await tx.walletTopup.findUnique({ where: { tenantId_idempotencyKey: { tenantId: i.tenantId, idempotencyKey: i.idempotencyKey } } });
      if (existing) {
        if (existing.amountIdr !== i.amountIdr) throw new ConflictError('Idempotency-Key was already used with a different request');
        return { topup: existing, needsInvoice: false };
      }
      await assertUnderCap(tx, i.tenantId, i.amountIdr, now);
      const topup = await tx.walletTopup.create({
        data: {
          tenantId: i.tenantId, amountIdr: i.amountIdr, idempotencyKey: i.idempotencyKey,
          merchantOrderId: `nw-${randomUUID().replaceAll('-', '')}`,
          expiresAt: new Date(now.getTime() + TOPUP_EXPIRY_MINUTES * 60_000),
        },
      });
      return { topup, needsInvoice: true };
    });
    const topup = prepared.needsInvoice ? await this.issueInvoice(prepared.topup, i.email) : prepared.topup;
    return topupView(topup, now);
  }

  /** Outside any transaction. A failure marks the top-up FAILED, so the customer simply starts a new one. */
  private async issueInvoice(t: WalletTopup, email: string): Promise<WalletTopup> {
    try {
      const invoice = await this.d.paymentClient.createInvoice({
        merchantOrderId: t.merchantOrderId,
        amountIdr: t.amountIdr,
        productDetails: 'Nibie Cloud top-up saldo',
        email,
        returnUrl: `${this.d.dashboardOrigin}/dashboard/billing?topup=${t.id}`,
        expiryMinutes: TOPUP_EXPIRY_MINUTES,
      });
      return await this.d.prisma.walletTopup.update({ where: { id: t.id }, data: { reference: invoice.reference, paymentUrl: invoice.paymentUrl } });
    } catch (e) {
      await this.d.prisma.walletTopup.updateMany({ where: { id: t.id, status: 'PENDING', paymentUrl: null }, data: { status: 'FAILED' } });
      throw e;
    }
  }
}
