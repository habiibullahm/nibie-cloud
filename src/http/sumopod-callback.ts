import formbody from '@fastify/formbody';
import type { FastifyInstance } from 'fastify';
import type { BillingService } from '../modules/billing/billing-service.js';
import type { Logger } from '../shared/logger.js';

export const WEBHOOK_PATH = '/api/v1/billing/sumopod/webhook';

/**
 * SumoPod Managed Payment webhook. Authenticated by `X-Webhook-Token` header (constant-time comparison).
 * The body is never logged. A valid webhook is answered `200` before the slow post-payment work
 * runs, so SumoPod never retries because an instance was slow.
 */
export function registerSumoPodWebhook(app: FastifyInstance, deps: { billing: BillingService; logger: Logger }): void {
  app.register(async (scope) => {
    await scope.register(formbody, { bodyLimit: 16 * 1024 });
    scope.post(WEBHOOK_PATH, { bodyLimit: 16 * 1024 }, async (req, reply) => {
      const token = ((req.headers as Record<string, string>)['x-webhook-token'] ?? '').trim();
      const result = await deps.billing.handleSumoPodWebhook(token, req.body as Record<string, unknown> ?? {});
      if (!result.accepted) {
        return reply.status(400).send({ error: { code: 'invalid_webhook', message: 'Invalid webhook' } });
      }
      deps.logger.info({ outcome: result.outcome }, 'sumopod webhook processed');
      setImmediate(() => {
        result.postActions().catch((e: Error) => deps.logger.error({ errName: e.name }, 'post-payment actions failed'));
      });
      // SumoPod expects 200 OK with empty body for acknowledged webhooks
      return reply.status(200).send();
    });
  });
}