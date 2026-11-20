import type { FastifyInstance } from 'fastify';
import type { AiAccountService } from '../modules/nibierouter/ai-account.js';
import { principalOf } from './customer-auth.js';

/**
 * The tenant's NibieRouter (AI) balance and usage in Rupiah, and the low-balance reminder. Registered inside the customer
 * plugin (Supabase token, `no-store`, per-user rate limit). Only when NibieRouter is configured; otherwise 404.
 */
export function registerAiRoutes(api: FastifyInstance, ai: AiAccountService): void {
  api.get('/ai', async (req) => ai.view(principalOf(req).tenantId));
  api.put('/ai/alert', async (req) => ({ alert: await ai.setAlert(principalOf(req).tenantId, req.body) }));
}
