import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { Config } from '../config/env.js';
import type { Mailer } from '../modules/billing/mailer.js';
import { renderTicketReply, renderTicketToTeam, type RenderedEmail } from '../modules/billing/email-templates.js';
import {
  addTicketMessage, CATEGORY_LABEL_ID, closeTicket, createTicket, createTicketBody, getTicket, listTickets, supportInbox,
  ticketMessageBody,
} from '../modules/support/tickets.js';
import { principalOf } from './customer-auth.js';

export interface TicketDeps {
  prisma: PrismaClient;
  config: Config;
  mailer: Mailer | null;
}

const ticketId = z.string().uuid();
type P = { ticketId: string };

const dashboard = (config: Config) => `${config.dashboardOrigin ?? 'https://cloud.nibie.app'}/dashboard`;

/** Best effort: the ticket is saved either way, and the mailer already logs a failure by class name. */
export async function sendQuietly(mailer: Mailer | null, log: FastifyBaseLogger, to: string | null, mail: RenderedEmail): Promise<void> {
  if (!mailer?.enabled || !to) return;
  try {
    await mailer.send({ to, ...mail });
  } catch {
    log.warn('ticket email not sent');
  }
}

/** Team notification for a new ticket or a customer reply, to the support inbox (Kontak bantuan email, else an admin). */
async function notifyTeam(deps: TicketDeps, log: FastifyBaseLogger, kind: 'new' | 'reply', t: { id: string; subject: string; category: keyof typeof CATEGORY_LABEL_ID; createdByEmail: string }, message: string) {
  const to = await supportInbox(deps.prisma, deps.config.adminEmails);
  await sendQuietly(deps.mailer, log, to, renderTicketToTeam({
    kind, subject: t.subject, category: CATEGORY_LABEL_ID[t.category], customerEmail: t.createdByEmail, message,
    url: `${dashboard(deps.config)}/admin/tiket/${t.id}`,
  }));
}

/**
 * Customer support tickets, inside the customer plugin (same token check, tenant and rate limit). A customer only ever sees
 * their own tenant's tickets; another tenant's ticket answers 404.
 */
export function registerCustomerTicketRoutes(api: FastifyInstance, deps: TicketDeps): void {
  const { prisma } = deps;

  api.get('/support/tickets', async (req) => ({ tickets: await listTickets(prisma, { tenantId: principalOf(req).tenantId }) }));

  api.post('/support/tickets', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const p = principalOf(req);
    const body = createTicketBody.parse(req.body);
    const ticket = await createTicket(prisma, { tenantId: p.tenantId, email: p.email, ...body });
    await notifyTeam(deps, req.log, 'new', ticket, body.message);
    return reply.status(201).send({ ticket });
  });

  api.get<{ Params: P }>('/support/tickets/:ticketId', async (req) => ({
    ticket: await getTicket(prisma, ticketId.parse(req.params.ticketId), principalOf(req).tenantId),
  }));

  api.post<{ Params: P }>('/support/tickets/:ticketId/messages', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
    const p = principalOf(req);
    const { message } = ticketMessageBody.parse(req.body);
    const ticket = await addTicketMessage(prisma, { id: ticketId.parse(req.params.ticketId), tenantId: p.tenantId, author: 'CUSTOMER', email: p.email, message });
    await notifyTeam(deps, req.log, 'reply', ticket, message);
    return { ticket };
  });

  api.post<{ Params: P }>('/support/tickets/:ticketId/close', async (req) => ({
    ticket: await closeTicket(prisma, ticketId.parse(req.params.ticketId), principalOf(req).tenantId),
  }));
}

/** Email to the customer when the team replies. */
export async function notifyCustomer(deps: TicketDeps, log: FastifyBaseLogger, t: { id: string; subject: string; createdByEmail: string }, message: string) {
  await sendQuietly(deps.mailer, log, t.createdByEmail, renderTicketReply({
    subject: t.subject, message, url: `${dashboard(deps.config)}/support/tickets/${t.id}`,
  }));
}
