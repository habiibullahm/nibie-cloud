import formbody from '@fastify/formbody';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BillingService } from '../modules/billing/billing-service.js';
import type { Logger } from '../shared/logger.js';

export const WEBHOOK_PATH = '/api/v1/billing/sumopod/webhook';

const BODY_LIMIT = 16 * 1024;

/** The exact JSON text received, kept beside the parsed body: a Svix signature is over these bytes, not a re-serialization. */
const rawBodies = new WeakMap<FastifyRequest, string>();

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === 'string' ? v.trim() : undefined;
};

/**
 * SumoPod Managed Payment webhook. Authenticated by a Svix signature (`svix-id`, `svix-timestamp`, `svix-signature`) when
 * `SUMOPOD_WEBHOOK_SECRET` is set, otherwise by the `X-Webhook-Token` header; both are compared in constant time. The
 * body is never logged. A valid webhook is answered `200` before the slow post-payment work runs, so SumoPod never
 * retries because an instance was slow.
 */
export function registerSumoPodWebhook(app: FastifyInstance, deps: { billing: BillingService; logger: Logger }): void {
  app.register(async (scope) => {
    await scope.register(formbody, { bodyLimit: BODY_LIMIT });
    // This scope only: parse JSON ourselves so the raw text is available for the signature check.
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: BODY_LIMIT }, (req, body, done) => {
      const text = body as string;
      rawBodies.set(req, text);
      try {
        done(null, text.length === 0 ? {} : JSON.parse(text));
      } catch {
        const err = new Error('invalid json') as Error & { statusCode: number };
        err.statusCode = 400;
        done(err, undefined);
      }
    });
    scope.post(WEBHOOK_PATH, { bodyLimit: BODY_LIMIT }, async (req, reply) => {
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const rawBody = rawBodies.get(req);
      const result = await deps.billing.handleSumoPodWebhook(
        {
          token: header(req, 'x-webhook-token') ?? '',
          svix: { id: header(req, 'svix-id'), timestamp: header(req, 'svix-timestamp'), signature: header(req, 'svix-signature') },
          ...(rawBody !== undefined ? { rawBody } : {}),
        },
        body,
      );
      if (!result.accepted) {
        return reply.status(400).send({ error: { code: 'invalid_webhook', message: 'Invalid webhook' } });
      }
      deps.logger.info({ outcome: result.outcome, merchantOrderId: result.merchantOrderId }, 'sumopod webhook processed');
      setImmediate(() => {
        result.postActions().catch((e: Error) => deps.logger.error({ errName: e.name }, 'post-payment actions failed'));
      });
      // SumoPod expects 200 OK with empty body for acknowledged webhooks
      return reply.status(200).send();
    });
  });
}
