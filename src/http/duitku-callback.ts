import formbody from '@fastify/formbody';
import type { FastifyInstance } from 'fastify';
import type { BillingService, CallbackForm } from '../modules/billing/billing-service.js';
import type { Logger } from '../shared/logger.js';

export const CALLBACK_PATH = '/api/v1/billing/duitku/callback';

const FIELDS = ['merchantCode', 'amount', 'merchantOrderId', 'resultCode', 'reference', 'signature'] as const;

/** Only plain strings count; arrays, objects and numbers are treated as absent, so they fail authentication. */
function pick(body: unknown): CallbackForm {
  const out: CallbackForm = {};
  if (typeof body !== 'object' || body === null) return out;
  for (const k of FIELDS) {
    const v = (body as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.length <= 512) out[k] = v;
  }
  return out;
}

/** Duitku callback route. Only registered when Duitku is configured. */
export function registerDuitkuCallback(app: FastifyInstance, deps: { billing: BillingService; logger: Logger }): void {
  app.register(async (scope) => {
    await scope.register(formbody, { bodyLimit: 16 * 1024 });
    scope.post(CALLBACK_PATH, { bodyLimit: 16 * 1024 }, async (req, reply) => {
      const result = await deps.billing.handleDuitkuCallback(pick(req.body));
      if (!result.accepted) {
        return reply.status(400).send({ error: { code: 'invalid_callback', message: 'Invalid callback' } });
      }
      deps.logger.info({ outcome: result.outcome }, 'duitku callback processed');
      setImmediate(() => {
        result.postActions().catch((e: Error) => deps.logger.error({ errName: e.name }, 'post-payment actions failed'));
      });
      return reply.status(200).send({ ok: true });
    });
  });
}