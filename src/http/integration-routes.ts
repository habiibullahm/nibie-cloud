import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LogService } from '../modules/integrations/log-service.js';
import type { Integrations } from '../modules/integrations/types.js';
import { NotFoundError, SecretsUnavailableError } from '../shared/errors.js';
import { principalOf } from './customer-auth.js';

const uuid = z.string().uuid();
const providerBody = z.object({ baseUrl: z.string().max(200), model: z.string().max(100), apiKey: z.string().max(512) }).strict();
const telegramBody = z.object({ token: z.string().max(100), allowedUserIds: z.array(z.string().max(15)).max(20) }).strict();
const nibieRouterBody = z.object({ apiKey: z.string().max(512), model: z.string().max(100) }).strict();

/** Verification and provider tests call third parties, so they get a much tighter per-user limit. */
const OUTBOUND_LIMIT = { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } };

function need(i: Integrations | null): Integrations {
  if (!i) throw new SecretsUnavailableError();
  return i;
}

/**
 * Provider and Telegram configuration (PRD 15.4, 15.5). Registered inside the customer plugin, so the
 * Supabase-token hook, `no-store` and the per-user rate limit already apply. Bodies are strict; secrets
 * are accepted on PUT and never appear in any response, only a short `keyHint`.
 */
export function registerCustomerIntegrationRoutes(api: FastifyInstance, integrations: Integrations | null, logs: LogService | null): void {
  type P = { instanceId: string };
  const ids = (p: P) => uuid.parse(p.instanceId);

  api.get<{ Params: P }>('/instances/:instanceId/providers', async (req) => ({
    providers: await need(integrations).providers.list(principalOf(req).tenantId, ids(req.params)),
  }));
  api.put<{ Params: P }>('/instances/:instanceId/providers', async (req) => {
    const i = need(integrations);
    const body = providerBody.parse(req.body);
    return { provider: await i.providers.put(principalOf(req).tenantId, ids(req.params), body) };
  });
  api.post<{ Params: P }>('/instances/:instanceId/providers/test', OUTBOUND_LIMIT, async (req) => ({
    provider: await need(integrations).providers.test(principalOf(req).tenantId, ids(req.params)),
  }));
  api.delete<{ Params: P & { providerConfigId: string } }>('/instances/:instanceId/providers/:providerConfigId', async (req) =>
    need(integrations).providers.remove(principalOf(req).tenantId, ids(req.params), uuid.parse(req.params.providerConfigId)),
  );

  // Read-only container output with the instance's own credentials scrubbed (PRD 15.3).
  api.get<{ Params: P; Querystring: { tail?: string } }>('/instances/:instanceId/logs', async (req) => {
    if (!logs) throw new NotFoundError('Route not found');
    const tail = z.coerce.number().int().min(1).max(500).default(100).parse(req.query.tail);
    return { lines: await logs.tail(principalOf(req).tenantId, ids(req.params), tail) };
  });

  api.get<{ Params: P }>('/instances/:instanceId/telegram', async (req) => ({
    telegram: await need(integrations).telegram.get(principalOf(req).tenantId, ids(req.params)),
  }));
  api.put<{ Params: P }>('/instances/:instanceId/telegram', async (req) => {
    const i = need(integrations);
    const body = telegramBody.parse(req.body);
    return { telegram: await i.telegram.put(principalOf(req).tenantId, ids(req.params), body) };
  });
  api.post<{ Params: P }>('/instances/:instanceId/telegram/verify', OUTBOUND_LIMIT, async (req) => ({
    telegram: await need(integrations).telegram.verify(principalOf(req).tenantId, ids(req.params)),
  }));
  api.delete<{ Params: P }>('/instances/:instanceId/telegram', async (req) =>
    need(integrations).telegram.remove(principalOf(req).tenantId, ids(req.params)),
  );
}

/** Operator-only: attach the NibieRouter key for a tenant, and look at / rotate the key-encryption key. */
export function registerOperatorIntegrationRoutes(api: FastifyInstance, integrations: Integrations | null): void {
  api.put<{ Params: { tenantId: string; instanceId: string } }>('/tenants/:tenantId/instances/:instanceId/providers/nibierouter', async (req) => {
    const i = need(integrations);
    const body = nibieRouterBody.parse(req.body);
    return { provider: await i.providers.attachNibieRouter(uuid.parse(req.params.tenantId), uuid.parse(req.params.instanceId), body) };
  });
  api.get('/secrets/health', async () => {
    const i = need(integrations);
    return { kekVersion: i.kekVersion, secretsByKekVersion: await i.secrets.countsByVersion() };
  });
  api.post('/secrets/rewrap', async () => ({ rewrapped: await need(integrations).secrets.rewrapAll() }));
}
