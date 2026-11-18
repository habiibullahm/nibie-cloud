import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { Config } from '../config/env.js';
import type { AuthClaims } from '../modules/auth/token-verifier.js';
import type { AuditService } from '../modules/admin/audit-service.js';
import type { JobQueue } from '../modules/jobs/types.js';
import type { Mailer } from '../modules/billing/mailer.js';
import { renderBetaInvite } from '../modules/billing/email-templates.js';
import { addInvite, INVITE_SELECT, listInvites, maskEmail, maskInvite, normalizeEmail } from '../modules/beta/invites.js';
import { AuthUnavailableError, ForbiddenError, NotFoundError, QueueUnavailableError, UnauthorizedError } from '../shared/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the admin auth hook. Never taken from the request body, path or query. */
    admin?: AuthClaims;
  }
}

export interface AdminDeps {
  verify: (token: string) => Promise<AuthClaims>;
  prisma: PrismaClient;
  audit: AuditService;
  /** The job queue behind `commands`, for the failed-job view. Null: those routes answer 503. */
  queue?: JobQueue | null;
}

const BEARER = /^Bearer ([^\s]+)$/;

/** Methods that change data. They need a second factor (`aal2`), not just a signed-in admin. */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** True when this method changes data, so the admin hook demands `aal2`. */
export function mutating(method: string): boolean {
  return MUTATING.has(method.toUpperCase());
}

/**
 * The two authorization rules that are not "is this token valid": the email must be on the allowlist, and every admin
 * route, reads included, needs a second factor (`aal2`). Pure so both can be tested without a route.
 */
export function assertAdminAllowed(claims: AuthClaims, _method: string, allowed: Set<string>): void {
  // One message for "not an admin": the caller learns nothing about who is.
  if (!allowed.has(claims.email.toLowerCase())) throw new ForbiddenError('Forbidden');
  // The panel shows every customer's data, so a stolen password alone must not open it. Only an admin on the allowlist
  // ever sees this code, which tells the dashboard to ask for the authenticator code.
  if (claims.aal !== 'aal2') {
    throw new ForbiddenError('Two-factor authentication is required for the admin panel', 'mfa_required');
  }
}

const uuid = z.string().uuid();
/** Every change an admin makes carries a reason, kept in the audit trail. */
const reason = z.string().trim().min(3).max(500);
const inviteBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  note: z.string().trim().max(200).optional(),
  reason,
}).strict();
const revokeBody = z.object({ reason }).strict();
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});
const statusQuery = pageQuery.extend({
  status: z.enum(['PENDING', 'PROVISIONING', 'CONFIGURING', 'STARTING', 'ACTIVE', 'DEGRADED', 'STOPPING', 'STOPPED', 'FAILED', 'DELETING', 'DELETED']).optional(),
});

/**
 * Admin API (`/api/v1/admin/*`): a Supabase token whose email is on `ADMIN_EMAILS`, plus `aal2` for
 * anything that changes data. Registered in its own plugin so the customer and operator hooks never
 * apply here. The allowlist is the whole protection — the dashboard is a public Worker, so nothing on
 * the client side guards the data. Nothing under `src/http` may import the secret store; the admin
 * routes read only columns that carry no credentials (see `test/unit/secrets-boundary.test.ts`).
 */
export function registerAdminRoutes(app: FastifyInstance, deps: { admin: AdminDeps; config: Config; mailer?: Mailer | null }): void {
  const { config } = deps;
  const mailer = deps.mailer ?? null;
  const { prisma, audit } = deps.admin;
  const queue = deps.admin.queue ?? null;
  // Empty list means nobody: a missing or misspelled variable must never open the panel.
  const allowed = new Set(config.adminEmails);

  app.register(async (api) => {
    // Auth first so the rate limit below can key on the admin, not on the proxy's address.
    api.decorateRequest('admin', undefined);
    api.addHook('onRequest', async (req) => {
      const m = BEARER.exec(req.headers.authorization ?? '');
      if (!m) throw new UnauthorizedError();
      let claims: AuthClaims;
      try {
        claims = await deps.admin.verify(m[1]!);
      } catch (e) {
        // An outage must be visible to the operator; a bad token is routine and stays quiet.
        if (e instanceof AuthUnavailableError) req.log.error('admin token verification unavailable: key set could not be loaded');
        throw e;
      }
      // The allowlist and the aal2 rule are the whole protection; one shared helper, one message.
      assertAdminAllowed(claims, req.method, allowed);
      req.admin = claims;
    });
    await api.register(rateLimit, {
      global: true,
      max: 120,
      timeWindow: '1 minute',
      keyGenerator: (req) => req.admin?.userId ?? req.ip,
    });
    api.addHook('onSend', async (_req, reply, payload) => {
      reply.header('cache-control', 'no-store');
      return payload;
    });

    /** Who am I, as far as this API is concerned. The dashboard calls it to decide whether to render. */
    api.get('/me', async (req) => {
      const admin = req.admin!;
      return { id: admin.userId, email: admin.email, aal: admin.aal };
    });

    /**
     * Whether optional subsystems are on. Read from the same config the routes were built with, so the
     * panel never has to guess from a failing request.
     */
    api.get('/system', async () => ({
      billing: config.billing !== null,
      billingGateway: config.billing?.gateway ?? null,
      router: config.router !== null,
      mail: config.mail !== null,
      redis: config.redisUrl !== null,
      customerApi: config.supabaseUrl !== null,
      freeBetaSlots: config.freeBetaSlots,
      adminEmails: config.adminEmails.length,
    }));

    api.get('/overview', async () => {
      const [customers, instances, subscriptions, pendingPayments, byStatus] = await Promise.all([
        prisma.tenant.count(),
        prisma.instance.count({ where: { deletedAt: null } }),
        prisma.subscription.count(),
        prisma.payment.count({ where: { status: 'PENDING' } }),
        prisma.instance.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } }),
      ]);
      return {
        counts: {
          customers,
          instances,
          subscriptions,
          pendingPayments,
          activeInstances: byStatus.find((r) => r.status === 'ACTIVE')?._count._all ?? 0,
          failedInstances: byStatus.find((r) => r.status === 'FAILED')?._count._all ?? 0,
        },
        byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
        system: {
          billing: config.billing !== null,
          router: config.router !== null,
          redis: config.redisUrl !== null,
        },
      };
    });

    api.get<{ Querystring: { q?: string } }>('/customers', async (req) => {
      const { limit, cursor } = pageQuery.parse(req.query);
      const q = (req.query.q ?? '').trim();
      const rows = await prisma.tenant.findMany({
        where: q ? { members: { some: { user: { email: { contains: q, mode: 'insensitive' } } } } } : {},
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: uuid.parse(cursor) }, skip: 1 } : {}),
        select: {
          id: true, name: true, createdAt: true,
          members: { select: { role: true, user: { select: { id: true, email: true } } } },
          _count: { select: { instances: { where: { deletedAt: null } } } },
        },
      });
      const page = rows.slice(0, limit);
      return {
        customers: page.map((t) => ({
          tenantId: t.id,
          name: t.name,
          createdAt: t.createdAt,
          // Beta: one user = one tenant, so the owner is the customer.
          email: t.members[0]?.user.email ?? null,
          userId: t.members[0]?.user.id ?? null,
          instanceCount: t._count.instances,
        })),
        nextCursor: rows.length > limit ? page.at(-1)?.id ?? null : null,
      };
    });

    api.get<{ Params: { tenantId: string } }>('/customers/:tenantId', async (req) => {
      const tenantId = uuid.parse(req.params.tenantId);
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          id: true, name: true, createdAt: true, routerUserId: true,
          members: { select: { role: true, user: { select: { id: true, email: true, createdAt: true } } } },
        },
      });
      if (!tenant) throw new NotFoundError('Customer not found');
      const [instances, subscriptions, payments] = await Promise.all([
        prisma.instance.findMany({
          where: { tenantId, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, name: true, status: true, statusReason: true, createdAt: true, diskUsedBytes: true, diskLevel: true,
            plan: { select: { slug: true, name: true } },
            node: { select: { name: true } },
          },
        }),
        prisma.subscription.findMany({
          where: { tenantId },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, status: true, instanceId: true, intendedName: true, currentPeriodEnd: true, graceEndsAt: true,
            cancelAtPeriodEnd: true, createdAt: true, plan: { select: { slug: true } },
          },
        }),
        prisma.payment.findMany({
          where: { subscription: { tenantId } },
          orderBy: { createdAt: 'desc' },
          take: 100,
          select: {
            id: true, merchantOrderId: true, amountIdr: true, purpose: true, status: true, paidAt: true, expiresAt: true, createdAt: true,
          },
        }),
      ]);
      return {
        customer: {
          tenantId: tenant.id, name: tenant.name, createdAt: tenant.createdAt,
          email: tenant.members[0]?.user.email ?? null,
          user: tenant.members[0]?.user ?? null,
          // Whether a router user exists, never the router key.
          hasRouterUser: tenant.routerUserId !== null,
        },
        instances, subscriptions, payments,
      };
    });

    api.get<{ Querystring: { status?: string } }>('/instances', async (req) => {
      const { limit, cursor, status } = statusQuery.parse(req.query);
      const rows = await prisma.instance.findMany({
        where: { deletedAt: null, ...(status ? { status } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: uuid.parse(cursor) }, skip: 1 } : {}),
        select: {
          id: true, name: true, status: true, statusReason: true, createdAt: true, updatedAt: true,
          diskUsedBytes: true, diskLevel: true, recoveryAttempts: true,
          tenant: { select: { id: true, members: { select: { user: { select: { email: true } } } } } },
          plan: { select: { slug: true } },
          node: { select: { name: true } },
        },
      });
      const page = rows.slice(0, limit);
      return {
        instances: page.map((i) => ({
          id: i.id, name: i.name, status: i.status, statusReason: i.statusReason,
          createdAt: i.createdAt, updatedAt: i.updatedAt,
          diskUsedBytes: i.diskUsedBytes, diskLevel: i.diskLevel, recoveryAttempts: i.recoveryAttempts,
          tenantId: i.tenant.id, email: i.tenant.members[0]?.user.email ?? null,
          plan: i.plan.slug, node: i.node.name,
        })),
        nextCursor: rows.length > limit ? page.at(-1)?.id ?? null : null,
      };
    });

    api.get<{ Params: { instanceId: string } }>('/instances/:instanceId', async (req) => {
      const id = uuid.parse(req.params.instanceId);
      const instance = await prisma.instance.findFirst({
        where: { id, deletedAt: null },
        select: {
          id: true, name: true, status: true, statusReason: true, image: true, hostPort: true,
          createdAt: true, updatedAt: true, lastHealthAt: true, diskUsedBytes: true, diskLevel: true,
          consecutiveFailures: true, recoveryAttempts: true, nextRecoveryAt: true,
          configRevision: true, appliedRevision: true,
          tenant: { select: { id: true, members: { select: { user: { select: { email: true } } } } } },
          plan: { select: { slug: true, name: true, cpuMillis: true, memoryMb: true, storageMb: true, pids: true } },
          node: { select: { name: true, region: true } },
          // Whether a provider is attached and which kind, never the key or the secret id's contents.
          provider: { select: { kind: true, baseUrl: true, model: true, status: true, lastTestedAt: true, lastErrorCode: true } },
          telegram: { select: { botUsername: true, status: true, verifiedAt: true, lastErrorCode: true } },
        },
      });
      if (!instance) throw new NotFoundError('Instance not found');
      const events = await prisma.instanceEvent.findMany({
        where: { instanceId: id },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { id: true, type: true, message: true, createdAt: true },
      });
      return {
        instance: {
          ...instance,
          tenantId: instance.tenant.id,
          email: instance.tenant.members[0]?.user.email ?? null,
          tenant: undefined,
        },
        events,
      };
    });

    api.get('/plans', async () => {
      const plans = await prisma.plan.findMany({ orderBy: [{ active: 'desc' }, { slug: 'asc' }] });
      return {
        plans: plans.map((p) => ({
          ...p,
          // BigInt does not survive JSON, and the panel shows US$ anyway.
          includedCreditNano: p.includedCreditNano?.toString() ?? null,
          includedCreditUsd: p.includedCreditNano ? Number(p.includedCreditNano) / 1e9 : null,
        })),
      };
    });

    /**
     * The beta waiting list, read only. The platform invites people by itself; nothing here changes data. Oldest first, so the
     * position is the order in which free slots are offered. `lapsed` means the claim window passed without a registration.
     */
    api.get('/waitlist', async () => {
      const now = new Date();
      const [unconfirmed, waiting, invited, lapsed, registered, rows] = await Promise.all([
        prisma.waitlistEntry.count({ where: { status: 'UNCONFIRMED' } }),
        prisma.waitlistEntry.count({ where: { status: 'WAITING' } }),
        prisma.waitlistEntry.count({ where: { status: 'INVITED', inviteExpiresAt: { gt: now } } }),
        prisma.waitlistEntry.count({ where: { status: 'INVITED', inviteExpiresAt: { lte: now } } }),
        prisma.waitlistEntry.count({ where: { status: 'REGISTERED' } }),
        prisma.waitlistEntry.findMany({
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 500,
          select: { id: true, name: true, email: true, useCase: true, status: true, createdAt: true, confirmedAt: true, invitedAt: true, inviteExpiresAt: true, inviteFailures: true, registeredAt: true },
        }),
      ]);
      const entries = rows.map((e) => ({ ...e, lapsed: e.status === 'INVITED' && e.inviteExpiresAt !== null && e.inviteExpiresAt <= now }));
      return {
        counts: { unconfirmed, waiting, invited, lapsed, registered },
        freeBetaSlots: config.freeBetaSlots,
        entries,
      };
    });

    /**
     * Beta invites. An account is invited when its email is in `BETA_ALLOWED_EMAILS` (read only, set on the host) or has an
     * active row here. Revoked rows stay for the history. A change applies to the next request, with no restart.
     */
    api.get('/beta-invites', async () => {
      const rows = await listInvites(prisma, { includeRevoked: true });
      return {
        invites: rows.slice(0, 500).map(maskInvite),
        fromEnv: config.betaAllowedEmails.map(maskEmail),
        freeBetaSlots: config.freeBetaSlots,
      };
    });

    api.post('/beta-invites', async (req, reply) => {
      const admin = req.admin!;
      const body = inviteBody.parse(req.body);
      const invite = await prisma.$transaction(async (tx) => {
        const row = await addInvite(tx, { email: body.email, note: body.note ?? null, addedBy: admin.email });
        await audit.record({
          actorEmail: admin.email, action: 'POST /beta-invites', targetType: 'beta_invite', targetId: row.id,
          reason: body.reason, detail: { email: row.email },
        }, tx);
        return row;
      });
      // The invite is already saved and audited. The email is best effort: `emailSent` tells the panel whether it went out,
      // so a failed send never undoes the invite and an admin can tell the person by other means.
      let emailSent = false;
      if (mailer?.enabled) {
        try {
          await mailer.send({ to: invite.email, ...renderBetaInvite({ registerUrl: `${config.dashboardOrigin ?? 'https://cloud.nibie.app'}/dashboard/register` }) });
          emailSent = true;
        } catch { /* the mailer already logged the failure by class name */ }
      }
      return reply.status(201).send({ invite: maskInvite(invite), emailSent });
    });

    api.post<{ Params: { inviteId: string } }>('/beta-invites/:inviteId/revoke', async (req) => {
      const admin = req.admin!;
      const id = uuid.parse(req.params.inviteId);
      const body = revokeBody.parse(req.body);
      const invite = await prisma.$transaction(async (tx) => {
        const existing = await tx.betaInvite.findUnique({ where: { id }, select: INVITE_SELECT });
        if (!existing) throw new NotFoundError('Invite not found');
        // Revoking an already revoked invite changes nothing, so it is not recorded as a change.
        if (existing.revokedAt) return existing;
        const row = await tx.betaInvite.update({ where: { id }, data: { revokedAt: new Date() }, select: INVITE_SELECT });
        await audit.record({
          actorEmail: admin.email, action: 'POST /beta-invites/:inviteId/revoke', targetType: 'beta_invite', targetId: id,
          reason: body.reason, detail: { email: normalizeEmail(row.email) },
        }, tx);
        return row;
      });
      return { invite: maskInvite(invite) };
    });

    api.get('/nodes', async () => {
      const nodes = await prisma.runtimeNode.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, region: true, schedulable: true, _count: { select: { instances: { where: { deletedAt: null } } } } },
      });
      return { nodes: nodes.map((n) => ({ id: n.id, name: n.name, region: n.region, schedulable: n.schedulable, instanceCount: n._count.instances })) };
    });

    api.get('/subscriptions', async (req) => {
      const { limit, cursor } = pageQuery.parse(req.query);
      const rows = await prisma.subscription.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: uuid.parse(cursor) }, skip: 1 } : {}),
        select: {
          id: true, status: true, instanceId: true, intendedName: true, currentPeriodEnd: true, graceEndsAt: true,
          suspendedAt: true, retentionEndsAt: true, cancelAtPeriodEnd: true, restartPending: true, createdAt: true,
          plan: { select: { slug: true, monthlyPriceIdr: true } },
          tenant: { select: { id: true, members: { select: { user: { select: { email: true } } } } } },
        },
      });
      const page = rows.slice(0, limit);
      return {
        subscriptions: page.map((s) => ({
          ...s, tenantId: s.tenant.id, email: s.tenant.members[0]?.user.email ?? null, tenant: undefined,
        })),
        nextCursor: rows.length > limit ? page.at(-1)?.id ?? null : null,
      };
    });

    api.get('/payments', async (req) => {
      const { limit, cursor } = pageQuery.parse(req.query);
      const rows = await prisma.payment.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: uuid.parse(cursor) }, skip: 1 } : {}),
        select: {
          id: true, merchantOrderId: true, amountIdr: true, purpose: true, status: true, reference: true,
          resultCode: true, paidAt: true, expiresAt: true, createdAt: true,
          subscription: {
            select: {
              id: true, status: true,
              tenant: { select: { id: true, members: { select: { user: { select: { email: true } } } } } },
            },
          },
        },
      });
      const page = rows.slice(0, limit);
      return {
        payments: page.map((p) => ({
          id: p.id, merchantOrderId: p.merchantOrderId, amountIdr: p.amountIdr, purpose: p.purpose, status: p.status,
          reference: p.reference, resultCode: p.resultCode, paidAt: p.paidAt, expiresAt: p.expiresAt, createdAt: p.createdAt,
          subscriptionId: p.subscription.id, subscriptionStatus: p.subscription.status,
          tenantId: p.subscription.tenant.id, email: p.subscription.tenant.members[0]?.user.email ?? null,
        })),
        nextCursor: rows.length > limit ? page.at(-1)?.id ?? null : null,
      };
    });

    api.get('/jobs/failed', async () => {
      if (!queue) throw new QueueUnavailableError();
      return { jobs: await queue.listFailed() };
    });

    api.get('/audit', async (req) => {
      const { limit, cursor } = pageQuery.parse(req.query);
      return audit.list({ limit, ...(cursor ? { cursor } : {}) });
    });

    // Reads are recorded too: "who looked at customer X" is part of the trail (PRD 14).
    api.addHook('onResponse', async (req) => {
      if (!req.admin) return;
      // Only reads: a Fase B action records its own entry with a reason and a target.
      if (mutating(req.method)) return;
      await audit
        .record({
          actorEmail: req.admin.email,
          action: `${req.method} ${req.routeOptions.url ?? req.url}`,
          targetType: null, targetId: null, reason: null, detail: null,
        })
        // The response is already sent, so a failure cannot reach the admin; it must reach the operator instead.
        .catch((e: unknown) => req.log.error({ errName: e instanceof Error ? e.name : 'unknown' }, 'admin audit write failed'));
    });
  }, { prefix: '/api/v1/admin' });
}
