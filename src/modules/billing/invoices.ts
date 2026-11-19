import type { InvoiceKind, PaymentMethod, Prisma, PrismaClient } from '@prisma/client';
import { NotFoundError } from '../../shared/errors.js';
import { isUuid } from '../../shared/uuid.js';

export interface InvoiceSource {
  tenantId: string;
  kind: InvoiceKind;
  amountIdr: number;
  paidAt: Date;
  planName?: string | null;
  instanceName?: string | null;
  paymentId?: string;
  walletTopupId?: string;
}

/** "2026/11": the invoice month in Asia/Jakarta (UTC+7, no daylight saving), the same rule the backfill migration uses. */
export function invoicePeriod(paidAt: Date): string {
  const d = new Date(paidAt.getTime() + 7 * 3_600_000);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Issues the invoice inside the transaction that marked the payment paid. The counter row stays locked until that
 * transaction ends, so numbers are sequential with no gaps; the unique payment/top-up id makes a second issue fail.
 */
export async function issueInvoice(tx: Prisma.TransactionClient, s: InvoiceSource): Promise<{ id: string; number: string }> {
  const period = invoicePeriod(s.paidAt);
  const [row] = await tx.$queryRaw<{ last: number }[]>`
    INSERT INTO "InvoiceCounter" ("period", "last") VALUES (${period}, 1)
    ON CONFLICT ("period") DO UPDATE SET "last" = "InvoiceCounter"."last" + 1
    RETURNING "last"`;
  const number = `INV/${period}/${String(row!.last).padStart(4, '0')}`;
  return tx.invoice.create({
    data: {
      number, tenantId: s.tenantId, kind: s.kind, amountIdr: s.amountIdr, paidAt: s.paidAt,
      planName: s.planName ?? null, instanceName: s.instanceName ?? null,
      paymentId: s.paymentId ?? null, walletTopupId: s.walletTopupId ?? null,
    },
    select: { id: true, number: true },
  });
}

export interface InvoiceView {
  id: string;
  number: string;
  kind: InvoiceKind;
  planName: string | null;
  instanceName: string | null;
  amountIdr: number;
  paidAt: Date;
  /** SumoPod's reference for the payment, when it sent one. */
  reference: string | null;
  /** QRIS, or WALLET for hosting paid from the balance (top-ups are always QRIS). */
  method: PaymentMethod;
}

const SELECT = {
  id: true, number: true, kind: true, planName: true, instanceName: true, amountIdr: true, paidAt: true,
  payment: { select: { reference: true, method: true } }, walletTopup: { select: { reference: true } },
} as const;

type Row = Prisma.InvoiceGetPayload<{ select: typeof SELECT }>;

function view({ payment, walletTopup, ...r }: Row): InvoiceView {
  return { ...r, reference: payment?.reference ?? walletTopup?.reference ?? null, method: payment?.method ?? 'QRIS' };
}

export async function listInvoices(prisma: PrismaClient, tenantId: string): Promise<InvoiceView[]> {
  const rows = await prisma.invoice.findMany({ where: { tenantId }, orderBy: { paidAt: 'desc' }, take: 100, select: SELECT });
  return rows.map(view);
}

export async function getInvoice(prisma: PrismaClient, tenantId: string, id: string): Promise<InvoiceView> {
  if (!isUuid(id)) throw new NotFoundError('Invoice not found');
  const row = await prisma.invoice.findFirst({ where: { id, tenantId }, select: SELECT });
  if (!row) throw new NotFoundError('Invoice not found');
  return view(row);
}
