import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { Config } from '../config/env.js';
import type { InstanceCommands } from '../modules/instances/instance-commands.js';
import type { InstanceService } from '../modules/instances/instance-service.js';
import { ForbiddenError } from '../shared/errors.js';
import { createBody, idempotencyKey } from './operator-routes.js';
import { principalOf, registerCustomerAuth, type CustomerAuthDeps } from './customer-auth.js';

export interface CustomerDeps extends CustomerAuthDeps {
  prisma: PrismaClient;
}

/**
 * Customer API: Supabase access token required, tenant taken from the verified user's membership.
 * Registered in its own plugin so the operator API's bearer hook never applies here, and vice versa.
 */
export function registerCustomerRoutes(app: FastifyInstance, deps: { customer: CustomerDeps; service: InstanceService; commands: InstanceCommands; config: Config }): void {
  const { service, commands, config } = deps;
  const { prisma } = deps.customer;
  const allowed = new Set(config.betaAllowedEmails);
  app.register(async (api) => {
    // Auth first so the rate limit below can key on the user. Token verification is local and cheap;
    // brute-forcing credentials is Supabase's job to limit, not ours.
    registerCustomerAuth(api, deps.customer);
    await api.register(rateLimit, {
      global: true,
      max: 120,
      timeWindow: '1 minute',
      keyGenerator: (req) => req.principal?.userId ?? req.ip,
    });
    api.addHook('onSend', async (_req, reply, payload) => {
      reply.header('cache-control', 'no-store');
      return payload;
    });

    api.get('/me', async (req) => {
      const p = principalOf(req);
      return { id: p.userId, email: p.email, tenantId: p.tenantId };
    });

    // Resource limits only. Pricing is not approved (PRD 5.2), so the price is always null.
    api.get('/plans', async () => {
      const rows = await prisma.plan.findMany({ where: { active: true }, orderBy: [{ cpuMillis: 'asc' }, { slug: 'asc' }] });
      return {
        plans: rows.map((p) => ({
          id: p.id, slug: p.slug, name: p.name, cpuMillis: p.cpuMillis, memoryMb: p.memoryMb,
          storageMb: p.storageMb, pids: p.pids, monthlyPriceIdr: null,
        })),
      };
    });

    type Params = { instanceId: string };

    api.post('/instances', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
      const p = principalOf(req);
      // Until payments exist, only invited beta users may create containers. Empty list: nobody.
      if (!allowed.has(p.email.toLowerCase())) {
        throw new ForbiddenError('Instance creation is not enabled for this account yet', 'provisioning_not_enabled');
      }
      const key = idempotencyKey.parse(req.headers['idempotency-key']);
      const body = createBody.parse(req.body);
      const { instance, jobId } = await commands.provision({
        tenantId: p.tenantId, name: body.name, planId: body.planId, idempotencyKey: key,
        maxInstances: config.maxInstancesPerTenant, activePlanOnly: true,
      });
      return reply.status(202).send({ instance, jobId });
    });

    api.get('/instances', async (req) => ({ instances: await service.list(principalOf(req).tenantId) }));
    api.get<{ Params: Params }>('/instances/:instanceId', async (req) => ({
      instance: await service.get(principalOf(req).tenantId, req.params.instanceId),
    }));
    api.get<{ Params: Params }>('/instances/:instanceId/status', async (req) => {
      const i = await service.get(principalOf(req).tenantId, req.params.instanceId);
      return { status: i.status, statusReason: i.statusReason, accessUrl: i.accessUrl };
    });
    api.get<{ Params: Params }>('/instances/:instanceId/events', async (req) => ({
      events: await service.events(principalOf(req).tenantId, req.params.instanceId),
    }));
    for (const action of ['start', 'stop', 'restart'] as const) {
      api.post<{ Params: Params }>(`/instances/:instanceId/${action}`, async (req, reply) => {
        const { instance, jobId } = await commands[action](principalOf(req).tenantId, req.params.instanceId);
        return reply.status(202).send({ instance, jobId });
      });
    }
    api.delete<{ Params: Params }>('/instances/:instanceId', async (req, reply) => {
      const { instance, jobId } = await commands.delete(principalOf(req).tenantId, req.params.instanceId);
      return reply.status(202).send({ instance, jobId });
    });
  }, { prefix: '/api/v1' });
}
