import type { FastifyInstance } from 'fastify';
import type { AiAccountService } from '../modules/nibierouter/ai-account.js';
import { principalOf } from './customer-auth.js';

/**
 * The tenant's NibieRouter (AI) balance and usage in Rupiah, the low-balance reminder, and the customer's own router keys. Registered inside the customer
 * plugin (Supabase token, `no-store`, per-user rate limit). Only when NibieRouter is configured; otherwise 404.
 */
export function registerAiRoutes(api: FastifyInstance, ai: AiAccountService): void {
  api.get('/ai', async (req) => ai.view(principalOf(req).tenantId));
  api.put('/ai/alert', async (req) => ({ alert: await ai.setAlert(principalOf(req).tenantId, req.body) }));
  // The customer's own NibieRouter keys. The secret is only in the create answer.
  api.get('/ai/keys', async (req) => ai.listKeys(principalOf(req).tenantId));
  api.post('/ai/keys', async (req, reply) => reply.code(201).send(await ai.createKey(principalOf(req).tenantId, req.body)));
  api.post<{ Params: { keyId: string } }>('/ai/keys/:keyId/revoke', async (req, reply) => {
    await ai.revokeKey(principalOf(req).tenantId, req.params.keyId);
    return reply.code(204).send();
  });
}
