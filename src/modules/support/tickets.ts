import type { PrismaClient, TicketAuthor, TicketCategory, TicketStatus } from '@prisma/client';
import { z } from 'zod';
import { NotFoundError } from '../../shared/errors.js';

const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** Single line: no control characters at all (it becomes an email subject). */
const subject = z.string().trim().min(3).max(120).refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'no control characters');
/** Free text: newlines and tabs are fine, other control characters are not. */
const message = z.string().trim().min(1).max(5000).refine((v) => !control.test(v), 'no control characters');

export const TICKET_CATEGORIES = ['PAYMENT', 'TECHNICAL', 'ACCOUNT', 'OTHER'] as const satisfies readonly TicketCategory[];

export const createTicketBody = z.object({
  subject,
  category: z.enum(TICKET_CATEGORIES),
  instanceId: z.string().uuid().nullable().optional(),
  message,
}).strict();

export const ticketMessageBody = z.object({ message }).strict();
export const ticketStatusQuery = z.object({ status: z.enum(['OPEN', 'ANSWERED', 'CLOSED']).optional() });

/** Who writes decides the next status: the customer hands it to the team (OPEN), the team hands it back (ANSWERED). */
export function statusAfterMessage(author: TicketAuthor): TicketStatus {
  return author === 'ADMIN' ? 'ANSWERED' : 'OPEN';
}

const SUMMARY = {
  id: true, subject: true, category: true, status: true, createdAt: true, lastMessageAt: true, createdByEmail: true,
  instance: { select: { id: true, name: true } },
} as const;

/** A tenant's tickets (customer) or everyone's (admin: `tenantId` null), newest activity first. */
export function listTickets(db: PrismaClient, opts: { tenantId: string | null; status?: TicketStatus; take?: number }) {
  return db.supportTicket.findMany({
    where: { ...(opts.tenantId ? { tenantId: opts.tenantId } : {}), ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { lastMessageAt: 'desc' },
    take: opts.take ?? 100,
    select: SUMMARY,
  });
}

/** One ticket with its messages. Another tenant's ticket is "not found", never "forbidden": its existence is not revealed. */
export async function getTicket(db: PrismaClient, id: string, tenantId: string | null) {
  const t = await db.supportTicket.findFirst({
    where: { id, ...(tenantId ? { tenantId } : {}) },
    select: { ...SUMMARY, tenantId: true, messages: { orderBy: { createdAt: 'asc' }, select: { id: true, author: true, body: true, createdAt: true } } },
  });
  if (!t) throw new NotFoundError('Ticket not found');
  return t;
}

export async function createTicket(
  db: PrismaClient,
  input: { tenantId: string; email: string } & z.infer<typeof createTicketBody>,
) {
  // The instance must be the customer's own; anything else is treated as missing.
  if (input.instanceId) {
    const own = await db.instance.findFirst({ where: { id: input.instanceId, tenantId: input.tenantId }, select: { id: true } });
    if (!own) throw new NotFoundError('Instance not found');
  }
  return db.supportTicket.create({
    data: {
      tenantId: input.tenantId, createdByEmail: input.email, subject: input.subject, category: input.category,
      instanceId: input.instanceId ?? null,
      messages: { create: { author: 'CUSTOMER', authorEmail: input.email, body: input.message } },
    },
    select: SUMMARY,
  });
}

/** Adds a message and moves the status (a customer message also reopens a closed ticket). */
export async function addTicketMessage(
  db: PrismaClient,
  input: { id: string; tenantId: string | null; author: TicketAuthor; email: string; message: string },
) {
  return db.$transaction(async (tx) => {
    const t = await tx.supportTicket.findFirst({ where: { id: input.id, ...(input.tenantId ? { tenantId: input.tenantId } : {}) }, select: { id: true } });
    if (!t) throw new NotFoundError('Ticket not found');
    const now = new Date();
    await tx.supportTicketMessage.create({ data: { ticketId: t.id, author: input.author, authorEmail: input.email, body: input.message, createdAt: now } });
    return tx.supportTicket.update({ where: { id: t.id }, data: { status: statusAfterMessage(input.author), lastMessageAt: now }, select: SUMMARY });
  });
}

export async function closeTicket(db: PrismaClient, id: string, tenantId: string | null) {
  const t = await db.supportTicket.findFirst({ where: { id, ...(tenantId ? { tenantId } : {}) }, select: { id: true } });
  if (!t) throw new NotFoundError('Ticket not found');
  return db.supportTicket.update({ where: { id: t.id }, data: { status: 'CLOSED' }, select: SUMMARY });
}

/** Where team notifications go: the support email from Kontak bantuan, else the first admin email. Null: nobody. */
export async function supportInbox(db: PrismaClient, adminEmails: string[]): Promise<string | null> {
  const row = await db.supportContact.findUnique({ where: { id: 1 }, select: { email: true } });
  return row?.email ?? adminEmails[0] ?? null;
}

export const CATEGORY_LABEL_ID: Record<TicketCategory, string> = {
  PAYMENT: 'Pembayaran', TECHNICAL: 'Teknis', ACCOUNT: 'Akun', OTHER: 'Lainnya',
};
