import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buyBody, type AiAccountService } from '../modules/nibierouter/ai-account.js';
import type { CaptchaVerifier } from '../modules/waitlist/turnstile.js';
import { requireCaptcha } from './billing-routes.js';
import { principalOf } from './customer-auth.js';

const idempotencyKey = z.string().min(1).max(128);

/**
 * The tenant's NibieRouter (AI) balance and usage in Rupiah, the low-balance reminder, the models it may use, the customer's
 * own router keys, and buying AI credit from the wallet. Registered inside the customer plugin (Supabase token, `no-store`,
 * per-user rate limit). Only when NibieRouter is configured; otherwise 404. Buying exists only with the wallet on (`ai.canBuy`).
 */
export function registerAiRoutes(
  api: FastifyInstance,
  ai: AiAccountService,
  opts: { gate?: (email: string) => void | Promise<void>; captcha?: CaptchaVerifier | null } = {},
): void {
  api.get('/ai', async (req) => ai.view(principalOf(req).tenantId));
  api.put('/ai/alert', async (req) => ({ alert: await ai.setAlert(principalOf(req).tenantId, req.body) }));
  // The router models this tenant may use (free plan: free models only) and the URL to call them at.
  api.get('/ai/models', async (req) => ai.models(principalOf(req).tenantId));
  // The customer's own NibieRouter keys. The secret is only in the create answer.
  api.get('/ai/keys', async (req) => ai.listKeys(principalOf(req).tenantId));
  api.post('/ai/keys', async (req, reply) => reply.code(201).send(await ai.createKey(principalOf(req).tenantId, req.body)));
  api.post<{ Params: { keyId: string } }>('/ai/keys/:keyId/revoke', async (req, reply) => {
    await ai.revokeKey(principalOf(req).tenantId, req.params.keyId);
    return reply.code(204).send();
  });
  if (!ai.canBuy) return;

  // Rupiah from the wallet to AI credit, at the rate shown on the Billing page. Same gate and Turnstile as other spending.
  api.post('/ai/credit', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const p = principalOf(req);
    await opts.gate?.(p.email);
    const key = idempotencyKey.parse(req.headers['idempotency-key']);
    const body = buyBody.parse(req.body);
    await requireCaptcha(opts.captcha ?? null, body.captchaToken, req);
    const purchase = await ai.buyCredit({ tenantId: p.tenantId, amountIdr: body.amountIdr, idempotencyKey: key });
    return reply.status(201).send({ purchase });
  });
}
