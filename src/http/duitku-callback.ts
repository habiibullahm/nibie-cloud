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

/**
 * The one public billing route. The HMAC signature is the authentication, checked before any database
 * access. No rate limit by IP on purpose: behind the reverse proxy every caller shares one address, so a
 * limit would let an attacker lock Duitku out; a forged request costs one HMAC and is rejected.
 * The body is never logged. A valid callback is answered `200` before the slow post-payment work
 * (provisioning, restart, receipt email) runs, so Duitku never retries because an instance was slow.
 */
export function registerDuitkuCallback(app: FastifyInstance, deps: { billing: BillingService; logger: Logger }): void {
  app.register(async (scope) => {
    await scope.register(formbody, { bodyLimit: 16 * 1024 });
    scope.post(CALLBACK_PATH, { bodyLimit: 16 * 1024 }, async (req, reply) => {
      const result = await deps.billing.handleCallback(pick(req.body));
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
