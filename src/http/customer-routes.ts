import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { Config } from '../config/env.js';
import type { InstanceCommands } from '../modules/instances/instance-commands.js';
import type { InstanceService } from '../modules/instances/instance-service.js';
import { ForbiddenError } from '../shared/errors.js';
import type { LogService } from '../modules/integrations/log-service.js';
import type { Integrations } from '../modules/integrations/types.js';
import { registerCustomerIntegrationRoutes } from './integration-routes.js';
import { createBody, idempotencyKey } from './operator-routes.js';
import { registerBillingRoutes } from './billing-routes.js';
import type { BillingService } from '../modules/billing/billing-service.js';
import { AppError } from '../shared/errors.js';
import { principalOf, registerCustomerAuth, type CustomerAuthDeps } from './customer-auth.js';

export interface CustomerDeps extends CustomerAuthDeps {
  prisma: PrismaClient;
}

/**
 * Customer API: Supabase access token required, tenant taken from the verified user's membership.
 * Registered in its own plugin so the operator API's bearer hook never applies here, and vice versa.
 */
export function registerCustomerRoutes(app: FastifyInstance, deps: { customer: CustomerDeps; service: InstanceService; commands: InstanceCommands; config: Config; integrations: Integrations | null; logs: LogService | null; billing: BillingService | null }): void {
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

    // Resource limits, plus the monthly price once the operator has set one (null: not for sale, PRD 5.2).
    api.get('/plans', async () => {
      const rows = await prisma.plan.findMany({ where: { active: true }, orderBy: [{ cpuMillis: 'asc' }, { slug: 'asc' }] });
      return {
        plans: rows.map((p) => ({
          id: p.id, slug: p.slug, name: p.name, cpuMillis: p.cpuMillis, memoryMb: p.memoryMb,
          storageMb: p.storageMb, pids: p.pids, monthlyPriceIdr: p.monthlyPriceIdr,
          // One-time AI credit that comes with the first payment, in US$ (null: none).
          includedCreditUsd: p.includedCreditNano ? Number(p.includedCreditNano) / 1e9 : null,
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
        const tenantId = principalOf(req).tenantId;
        if (deps.billing && action !== 'stop') {
          // Ownership first (404 for another tenant's id), then the suspension guard: a suspended instance
          // comes back only through a verified renewal, never through this button.
          await service.get(tenantId, req.params.instanceId);
          if ((await deps.billing.subscriptionOfInstance(req.params.instanceId))?.status === 'SUSPENDED') {
            throw new AppError('This instance is suspended until the subscription is renewed', 409, 'subscription_suspended');
          }
        }
        const { instance, jobId } = await commands[action](tenantId, req.params.instanceId);
        return reply.status(202).send({ instance, jobId });
      });
    }
    api.delete<{ Params: Params }>('/instances/:instanceId', async (req, reply) => {
      const tenantId = principalOf(req).tenantId;
      const { instance, jobId } = await commands.delete(tenantId, req.params.instanceId);
      // Deleting by hand ends the paid subscription with it, so no reminder or suspension follows.
      await deps.billing?.endForInstance(tenantId, req.params.instanceId);
      return reply.status(202).send({ instance, jobId });
    });

    if (deps.billing) {
      // A production deployment whose gateways are all sandbox takes no real money, so a sandbox "payment" would hand out a
      // free instance. Until a production gateway is configured, only invited beta users may start a purchase.
      const cfg = config.billing;
      const sandboxOnly = config.nodeEnv === 'production' && cfg !== null && [cfg.duitku, cfg.sumopod].every((g) => g === null || g.env === 'sandbox');
      registerBillingRoutes(api, deps.billing, (email) => {
        if (sandboxOnly && !allowed.has(email.toLowerCase())) throw new ForbiddenError('Payments are not open yet', 'billing_not_open');
      });
    }
    registerCustomerIntegrationRoutes(api, deps.integrations, deps.logs);
  }, { prefix: '/api/v1' });
}
