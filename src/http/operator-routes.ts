import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config/env.js';
import type { InstanceCommands } from '../modules/instances/instance-commands.js';
import type { JobQueue } from '../modules/jobs/types.js';
import type { InstanceService } from '../modules/instances/instance-service.js';
import type { Integrations } from '../modules/integrations/types.js';
import { registerOperatorIntegrationRoutes } from './integration-routes.js';
import { NotFoundError, QueueUnavailableError } from '../shared/errors.js';
import type { PrismaClient } from '@prisma/client';
import type { RuntimeFleet } from '../modules/runtime/fleet.js';
import type { NodeRecovery } from '../modules/instances/node-recovery.js';
import type { NodeScheduler } from '../modules/instances/node-scheduler.js';
import { nodeName } from '../modules/runtime/agent-protocol.js';

export interface NodeOperatorDeps {
  prisma: PrismaClient;
  fleet: RuntimeFleet;
  recovery: NodeRecovery;
  placement: NodeScheduler;
}

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
export function registerOperatorRoutes(app: FastifyInstance, deps: { service: InstanceService; commands: InstanceCommands; queue: JobQueue | null; config: Config; integrations: Integrations | null; nodes?: NodeOperatorDeps }): void {
  const { service, commands, queue, config } = deps;
  app.register(async (api) => {
    api.addHook('onRequest', async (req, reply) => {
      // Defence in depth for a misconfigured public proxy: the operator API does not exist for
      // proxied requests, whatever token they carry. The proxy's path filter is still required.
      if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) throw new NotFoundError('Route not found');
      if (!authorized(req.headers.authorization, config.adminToken)) {
        return reply.status(401).send({ error: { code: 'unauthorized', message: 'Unauthorized' } });
      }
    });

    // Jobs that used up their retries. Reasons are error class names only; payloads are ids.
    api.get('/jobs/failed', async () => {
      if (!queue) throw new QueueUnavailableError();
      return { jobs: await queue.listFailed() };
    });
    api.post<{ Params: { jobId: string } }>('/jobs/failed/:jobId/retry', async (req, reply) => {
      if (!queue) throw new QueueUnavailableError();
      await queue.retryFailed(req.params.jobId);
      return reply.status(202).send({ jobId: req.params.jobId });
    });

    // Plan disk per live instance, for the host job that raises volume quotas (ops/host/hermes-volume-quota.sh).
    api.get('/volume-quotas', async () => ({ volumes: await service.volumeQuotas() }));

    registerOperatorIntegrationRoutes(api, deps.integrations);

    const base = '/tenants/:tenantId/instances';
    type Params = { tenantId: string; instanceId: string };

    if (deps.nodes) {
      const { prisma, fleet, recovery, placement } = deps.nodes;
      api.get('/runtime-nodes', async () => {
        const nodes = await prisma.runtimeNode.findMany({ orderBy: { name: 'asc' } });
        return { nodes: nodes.map((node) => ({ ...node, ...fleet.nodeStatus(node.id) })) };
      });
      api.post<{ Params: { name: string } }>('/runtime-nodes/:name/schedulable', async (req) => {
        const name = nodeName.parse(req.params.name);
        const { schedulable } = z.strictObject({ schedulable: z.boolean() }).parse(req.body);
        const result = await prisma.$transaction(async (tx) => {
          await placement.lock(tx);
          return tx.runtimeNode.updateMany({ where: { name }, data: { schedulable } });
        });
        if (!result.count) throw new NotFoundError('Runtime node not found');
        return { name, schedulable };
      });
      api.get('/runtime-backup-live', async () => ({
        instanceIds: (await prisma.instance.findMany({ where: { status: { not: 'DELETED' } }, select: { id: true } })).map(({ id }) => id),
      }));
      api.post<{ Params: Params }>(`${base}/:instanceId/recovery/prepare`, async (req) => {
        const { tenantId, instanceId } = req.params;
        const body = z.strictObject({ node: nodeName, sourceFenced: z.boolean().default(false) }).parse(req.body);
        return recovery.prepare(tenantId, instanceId, body.node, body.sourceFenced);
      });
      api.post<{ Params: Params }>(`${base}/:instanceId/recovery/finish`, async (req) => {
        const { tenantId, instanceId } = req.params;
        const body = z.strictObject({ restoreVerified: z.literal(true), sourceFenced: z.boolean().default(false) }).parse(req.body);
        return recovery.finish(tenantId, instanceId, body.sourceFenced);
      });
      api.post<{ Params: Params }>(`${base}/:instanceId/recovery/cancel`, async (req) => {
        z.strictObject({ discardTarget: z.literal(true) }).parse(req.body);
        return recovery.cancel(req.params.tenantId, req.params.instanceId);
      });
      api.post<{ Params: Params }>(`${base}/:instanceId/recovery/retire`, async (req) => {
        const { node } = z.strictObject({ node: nodeName, discardSource: z.literal(true) }).parse(req.body);
        return recovery.retire(req.params.tenantId, req.params.instanceId, node);
      });
    }

    api.post<{ Params: { tenantId: string } }>(base, async (req, reply) => {
      const key = idempotencyKey.parse(req.headers['idempotency-key']);
      const body = createBody.parse(req.body);
      const { instance, jobId } = await commands.provision({
        tenantId: req.params.tenantId, name: body.name, planId: body.planId, idempotencyKey: key,
      });
      return reply.status(202).send({ instance, jobId });
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
        const { instance, jobId } = await commands[action](req.params.tenantId, req.params.instanceId);
        return reply.status(202).send({ instance, jobId });
      });
    }
    api.delete<{ Params: Params }>(`${base}/:instanceId`, async (req, reply) => {
      const { instance, jobId } = await commands.delete(req.params.tenantId, req.params.instanceId);
      return reply.status(202).send({ instance, jobId });
    });
  }, { prefix: '/api/v1' });
}
