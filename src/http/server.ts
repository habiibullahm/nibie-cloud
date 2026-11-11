import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import type { Config } from '../config/env.js';
import type { InstanceService } from '../modules/instances/instance-service.js';
import { AppError, NotFoundError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';

const createBody = z.object({ name: z.string(), planId: z.string().uuid() }).strict();
const idempotencyKey = z.string().min(1).max(128);

const digest = (s: string) => createHash('sha256').update(s).digest();

function authorized(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  if (!m) return false;
  return timingSafeEqual(digest(m[1]!), digest(token));
}

/**
 * Operator-only API (bearer ADMIN_TOKEN). It is NOT the customer API: customer auth and
 * tenant membership arrive in a later milestone. Bind it to loopback; never expose publicly.
 */
export function buildServer(deps: { service: InstanceService; config: Config; logger: Logger }): FastifyInstance {
  const { service, config, logger } = deps;
  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger, disableRequestLogging: false });

  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'validation_error', message: 'Invalid request' } });
    }
    const e = err as { name?: string; statusCode?: number };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: 'bad_request', message: 'Bad request' } });
    }
    // Free-text error messages can contain secrets, so only the error class is logged.
    req.log.error({ errName: e.name }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Internal error' } });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.register(async (api) => {
    api.addHook('onRequest', async (req, reply) => {
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

  app.setNotFoundHandler(async () => {
    throw new NotFoundError('Route not found');
  });

  return app;
}
