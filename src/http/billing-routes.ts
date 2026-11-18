import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BillingService } from '../modules/billing/billing-service.js';
import { principalOf } from './customer-auth.js';

const checkoutBody = z.object({ name: z.string(), planId: z.string().uuid() }).strict();
const idempotencyKey = z.string().min(1).max(128);

/** Customer billing routes. Registered inside the customer plugin, so the token and the tenant are already resolved. */
export function registerBillingRoutes(api: FastifyInstance, billing: BillingService, gate: (email: string) => void | Promise<void> = () => undefined): void {
  type SubParams = { subscriptionId: string };

  api.get('/subscriptions', async (req) => ({ subscriptions: await billing.list(principalOf(req).tenantId) }));

  api.get<{ Params: SubParams }>('/subscriptions/:subscriptionId', async (req) => ({
    subscription: await billing.get(principalOf(req).tenantId, req.params.subscriptionId),
  }));

  api.post('/subscriptions/checkout', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const p = principalOf(req);
    await gate(p.email);
    const key = idempotencyKey.parse(req.headers['idempotency-key']);
    const body = checkoutBody.parse(req.body);
    const out = await billing.checkout({ tenantId: p.tenantId, email: p.email, planId: body.planId, name: body.name, idempotencyKey: key });
    return reply.status(201).send(out);
  });

  api.post<{ Params: SubParams }>('/subscriptions/:subscriptionId/renew', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const p = principalOf(req);
    await gate(p.email);
    const out = await billing.renew({ tenantId: p.tenantId, email: p.email, subscriptionId: req.params.subscriptionId });
    return reply.status(201).send(out);
  });

  api.post<{ Params: SubParams }>('/subscriptions/:subscriptionId/cancel', async (req) => ({
    subscription: await billing.cancel(principalOf(req).tenantId, req.params.subscriptionId),
  }));

  api.get<{ Params: { paymentId: string } }>('/payments/:paymentId', async (req) => ({
    payment: await billing.getPayment(principalOf(req).tenantId, req.params.paymentId),
  }));
}
