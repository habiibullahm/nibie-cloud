import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { Config } from '../config/env.js';
import type { InstanceCommands } from '../modules/instances/instance-commands.js';
import type { InstanceService } from '../modules/instances/instance-service.js';
import { BetaFullError, CapacityFullError, ForbiddenError } from '../shared/errors.js';
import type { LogService } from '../modules/integrations/log-service.js';
import type { Integrations } from '../modules/integrations/types.js';
import { registerCustomerIntegrationRoutes } from './integration-routes.js';
import { createBody, idempotencyKey } from './operator-routes.js';
import { stockLeft, totalLoad } from '../modules/instances/capacity.js';
import { freeBetaRemaining, hasActiveInvite } from '../modules/instances/free-beta.js';
import { markWaitlistRegistered } from '../modules/waitlist/waitlist.js';
import { isInvited } from '../modules/beta/invites.js';
import { registerBillingRoutes } from './billing-routes.js';
import type { BillingService } from '../modules/billing/billing-service.js';
import { AppError } from '../shared/errors.js';
import { isUuid } from '../shared/uuid.js';
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
  const admins = new Set(config.adminEmails);
  // Invited means listed in BETA_ALLOWED_EMAILS or holding an active BetaInvite row.
  const isInvitedEmail = async (email: string): Promise<boolean> => allowed.has(email.toLowerCase()) || (await isInvited(prisma, email));
  // With email configured the platform invites people already waiting, so a freed slot is theirs before a visitor's.
  const queueFirst = config.mail !== null;
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
    api.get('/plans', async (req) => {
      // Every active plan is listed for everyone; `available` says whether this account can take it now (the dashboard
      // shows the others as out of stock). A plan without a price is the free beta preview plan: available to invited
      // accounts, and to everyone else only while free slots remain. Priced plans are available to everyone unless the
      // launch switch (PAID_CHECKOUT_OPEN) is off or their stock (set by an admin) is used up, for invited accounts too.
      // POST /instances and checkout enforce the same rules.
      const email = principalOf(req).email;
      const invited = await isInvitedEmail(email);
      const freeOpen = invited || (config.freeBetaSlots > 0
        && ((await freeBetaRemaining(prisma, config.freeBetaSlots, { queueFirst })) > 0 || (await hasActiveInvite(prisma, email, new Date()))));
      const paidOpen = invited || config.paidCheckoutOpen;
      const rows = await prisma.plan.findMany({
        where: { active: true },
        orderBy: [{ cpuMillis: 'asc' }, { slug: 'asc' }],
      });
      const now = new Date();
      const left = await Promise.all(rows.map((p) => stockLeft(prisma, p, now)));
      return {
        plans: rows.map((p, i) => ({
          id: p.id, slug: p.slug, name: p.name, cpuMillis: p.cpuMillis, memoryMb: p.memoryMb,
          storageMb: p.storageMb, pids: p.pids, monthlyPriceIdr: p.monthlyPriceIdr,
          // One-time AI credit that comes with the first payment, in US$ (null: none).
          includedCreditUsd: p.includedCreditNano ? Number(p.includedCreditNano) / 1e9 : null,
          available: p.monthlyPriceIdr === null ? freeOpen : paidOpen && left[i] !== 0,
        })),
      };
    });

    type Params = { instanceId: string };

    api.post('/instances', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
      const p = principalOf(req);
      const key = idempotencyKey.parse(req.headers['idempotency-key']);
      const body = createBody.parse(req.body);
      // Paid instances are created by the billing flow after a verified payment. Only an admin (ADMIN_EMAILS) may create one
      // here directly, for testing; an invited account may not, or it would get a paid plan without paying.
      const plan = isUuid(body.planId) ? await prisma.plan.findUnique({ where: { id: body.planId } }) : null;
      if (plan && plan.monthlyPriceIdr !== null && !admins.has(p.email.toLowerCase())) {
        throw new ForbiddenError('Paid plans are created through checkout', 'provisioning_not_enabled');
      }
      // Invited accounts skip the free slots. Everyone else may take only the free plan, and only while free slots remain.
      if (!(await isInvitedEmail(p.email))) {
        if (!plan || config.freeBetaSlots <= 0) {
          throw new ForbiddenError('Instance creation is not enabled for this account yet', 'provisioning_not_enabled');
        }
        const replay = await prisma.instance.findFirst({ where: { tenantId: p.tenantId, idempotencyKey: key }, select: { id: true } });
        // An open waiting-list invitation holds a slot for exactly this person, so it never meets `beta_full`.
        if (!replay && (await freeBetaRemaining(prisma, config.freeBetaSlots, { queueFirst })) <= 0 && !(await hasActiveInvite(prisma, p.email, new Date()))) throw new BetaFullError();
      }
      // Whole-server cap. A replay of a creation that already exists is not a new instance and is never refused.
      if (config.maxTotalInstances !== null) {
        const replay = await prisma.instance.findFirst({ where: { tenantId: p.tenantId, idempotencyKey: key }, select: { id: true } });
        if (!replay && (await totalLoad(prisma, new Date())) >= config.maxTotalInstances) throw new CapacityFullError();
      }
      const { instance, jobId } = await commands.provision({
        tenantId: p.tenantId, name: body.name, planId: body.planId, idempotencyKey: key,
        maxInstances: config.maxInstancesPerTenant, activePlanOnly: true,
      });
      // The person now holds a free instance: stop counting them as waiting or invited.
      if (config.freeBetaSlots > 0) await markWaitlistRegistered(prisma, p.email);
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
      registerBillingRoutes(api, deps.billing, async (email) => {
        if ((sandboxOnly || !config.paidCheckoutOpen) && !(await isInvitedEmail(email))) throw new ForbiddenError('Payments are not open yet', 'billing_not_open');
      });
    }
    registerCustomerIntegrationRoutes(api, deps.integrations, deps.logs);
  }, { prefix: '/api/v1' });
}
