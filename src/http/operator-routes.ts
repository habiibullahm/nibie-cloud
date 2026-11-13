import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config/env.js';
import type { InstanceService } from '../modules/instances/instance-service.js';
import { NotFoundError } from '../shared/errors.js';

export const createBody = z.object({ name: z.string(), planId: z.string().uuid() }).strict();
export const idempotencyKey = z.string().min(1).max(128);

const digest = (s: string) => createHash('sha256').update(s).digest();

function authorized(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  if (!m) return false;
  return timingSafeEqual(digest(m[1]!), digest(token));
}

/** Headers a reverse proxy or CDN adds. A request carrying one did not come straight from loopback. */
const PROXY_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip', 'cf-ray'];

/**
 * Operator-only API (bearer ADMIN_TOKEN). It is NOT the customer API: customers use the Supabase-token
 * surface in customer-routes.ts. Bind it to loopback; never route it from the public proxy.
 */
export function registerOperatorRoutes(app: FastifyInstance, deps: { service: InstanceService; config: Config }): void {
  const { service, config } = deps;
  app.register(async (api) => {
    api.addHook('onRequest', async (req, reply) => {
      // Defence in depth for a misconfigured public proxy: the operator API does not exist for
      // proxied requests, whatever token they carry. The proxy's path filter is still required.
      if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) throw new NotFoundError('Route not found');
      if (!authorized(req.headers.authorization, config.adminToken)) {
        return reply.status(401).send({ error: { code: 'unauthorized', message: 'Unauthorized' } });
      }
    });

    const base = '/tenants/:tenantId/instances';
    type Params = { tenantId: string; instanceId: string };

    api.post<{ Params: { tenantId: string } }>(base, async (req, reply) => {
      const key = idempotencyKey.parse(req.headers['idempotency-key']);
      const body = createBody.parse(req.body);
      const instance = await service.provision({
        tenantId: req.params.tenantId, name: body.name, planId: body.planId, idempotencyKey: key,
      });
      return reply.status(202).send({ instance });
    });

    api.get<{ Params: { tenantId: string } }>(base, async (req) => ({
      instances: await service.list(req.params.tenantId),
    }));
    api.get<{ Params: Params }>(`${base}/:instanceId`, async (req) => ({
      instance: await service.get(req.params.tenantId, req.params.instanceId),
    }));
    api.get<{ Params: Params }>(`${base}/:instanceId/status`, async (req) => {
      const i = await service.get(req.params.tenantId, req.params.instanceId);
      return { status: i.status, statusReason: i.statusReason, accessUrl: i.accessUrl };
    });
    api.get<{ Params: Params }>(`${base}/:instanceId/events`, async (req) => ({
      events: await service.events(req.params.tenantId, req.params.instanceId),
    }));

    for (const action of ['start', 'stop', 'restart'] as const) {
      api.post<{ Params: Params }>(`${base}/:instanceId/${action}`, async (req, reply) => {
        const instance = await service[action](req.params.tenantId, req.params.instanceId);
        return reply.status(202).send({ instance });
      });
    }
    api.delete<{ Params: Params }>(`${base}/:instanceId`, async (req, reply) => {
      const instance = await service.delete(req.params.tenantId, req.params.instanceId);
      return reply.status(202).send({ instance });
    });
  }, { prefix: '/api/v1' });
}
