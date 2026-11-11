import type { Instance, InstanceStatus, Plan, PrismaClient } from '@prisma/client';
import { ConflictError, NotFoundError, RuntimeUnavailableError, ValidationError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import { assertPinnedImage } from '../runtime/image-policy.js';
import type { RuntimeManager } from '../runtime/types.js';
import { findOwned, revert, transition } from './instance-repo.js';

export interface InstanceView {
  id: string;
  tenantId: string;
  name: string;
  status: InstanceStatus;
  statusReason: string | null;
  accessUrl: string | null;
  createdAt: Date;
}

export interface InstanceServiceDeps {
  prisma: PrismaClient;
  runtime: RuntimeManager;
  image: string;
  production: boolean;
  logger: Logger;
  pollIntervalMs?: number;
  healthTimeoutMs?: number;
}

class HealthTimeout extends Error {}

const RESET_RECOVERY = { consecutiveFailures: 0, recoveryAttempts: 0, nextRecoveryAt: null };

export function toView(i: Instance): InstanceView {
  const reachable = i.hostPort !== null && (i.status === 'ACTIVE' || i.status === 'DEGRADED');
  return {
    id: i.id,
    tenantId: i.tenantId,
    name: i.name,
    status: i.status,
    statusReason: i.statusReason,
    accessUrl: reachable ? `http://127.0.0.1:${i.hostPort}` : null,
    createdAt: i.createdAt,
  };
}

function validateName(name: string): void {
  if (typeof name !== 'string' || name.length < 1 || name.length > 63 || /\p{Cc}/u.test(name)) {
    throw new ValidationError('name must be 1-63 characters without control characters');
  }
}

export class InstanceService {
  private readonly prisma: PrismaClient;
  private readonly runtime: RuntimeManager;
  private readonly image: string;
  private readonly logger: Logger;
  private readonly pollIntervalMs: number;
  private readonly healthTimeoutMs: number;

  constructor(deps: InstanceServiceDeps) {
    assertPinnedImage(deps.image, { production: deps.production });
    this.prisma = deps.prisma;
    this.runtime = deps.runtime;
    this.image = deps.image;
    this.logger = deps.logger;
    this.pollIntervalMs = deps.pollIntervalMs ?? 500;
    this.healthTimeoutMs = deps.healthTimeoutMs ?? 30_000;
  }

  async provision(input: { tenantId: string; name: string; planId: string; idempotencyKey: string }): Promise<InstanceView> {
    validateName(input.name);
    if (!input.idempotencyKey || input.idempotencyKey.length > 128) throw new ValidationError('invalid idempotency key');
    const tenant = await this.prisma.tenant.findUnique({ where: { id: input.tenantId } }).catch(() => null);
    if (!tenant) throw new NotFoundError('Tenant not found');
    const plan = await this.prisma.plan.findUnique({ where: { id: input.planId } }).catch(() => null);
    if (!plan) throw new NotFoundError('Plan not found');
    const node = await this.prisma.runtimeNode.findFirst({ where: { schedulable: true }, orderBy: { name: 'asc' } });
    if (!node) throw new RuntimeUnavailableError('No schedulable runtime node');

    let row: Instance;
    try {
      row = await this.prisma.instance.create({
        data: {
          tenantId: tenant.id, planId: plan.id, nodeId: node.id, name: input.name,
          idempotencyKey: input.idempotencyKey, image: this.image,
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e;
      const existing = await this.prisma.instance.findFirstOrThrow({
        where: { tenantId: tenant.id, idempotencyKey: input.idempotencyKey },
      });
      return existing.status === 'FAILED' ? this.runProvision(existing, plan) : toView(existing);
    }
    return this.runProvision(row, plan);
  }

  async get(tenantId: string, instanceId: string): Promise<InstanceView> {
    return toView(await findOwned(this.prisma, tenantId, instanceId));
  }

  async list(tenantId: string): Promise<InstanceView[]> {
    const rows = await this.prisma.instance.findMany({ where: { tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
    return rows.map(toView);
  }

  async events(tenantId: string, instanceId: string) {
    await findOwned(this.prisma, tenantId, instanceId);
    const rows = await this.prisma.instanceEvent.findMany({ where: { instanceId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map((e) => ({ type: e.type, message: e.message, createdAt: e.createdAt }));
  }

  async start(tenantId: string, instanceId: string): Promise<InstanceView> {
    const i = await findOwned(this.prisma, tenantId, instanceId);
    if (i.status === 'ACTIVE' || i.status === 'DEGRADED') return toView(i);
    if (i.status !== 'STOPPED') throw new ConflictError(`Cannot start an instance in state ${i.status}`);
    return this.startFlow(i, 'start');
  }

  async restart(tenantId: string, instanceId: string): Promise<InstanceView> {
    const i = await findOwned(this.prisma, tenantId, instanceId);
    if (i.status === 'STOPPED') return this.startFlow(i, 'start');
    if (i.status !== 'ACTIVE' && i.status !== 'DEGRADED') {
      throw new ConflictError(`Cannot restart an instance in state ${i.status}`);
    }
    return this.startFlow(i, 'restart');
  }

  async stop(tenantId: string, instanceId: string): Promise<InstanceView> {
    const i = await findOwned(this.prisma, tenantId, instanceId);
    if (i.status === 'STOPPED') return toView(i);
    if (i.status !== 'ACTIVE' && i.status !== 'DEGRADED') {
      throw new ConflictError(`Cannot stop an instance in state ${i.status}`);
    }
    const from = i.status;
    await transition(this.prisma, { id: i.id, from, to: 'STOPPING', eventType: 'instance.stopping', message: 'Instance stopping' });
    try {
      await this.runtime.stop(i.id);
    } catch (e) {
      await revert(this.prisma, {
        id: i.id, from: 'STOPPING', to: from, eventType: 'runtime.unavailable', message: 'Stop could not be completed',
      });
      throw e;
    }
    await transition(this.prisma, { id: i.id, from: 'STOPPING', to: 'STOPPED', eventType: 'instance.stopped', message: 'Instance stopped' });
    return this.get(tenantId, instanceId);
  }

  async delete(tenantId: string, instanceId: string): Promise<InstanceView> {
    const i = await findOwned(this.prisma, tenantId, instanceId);
    if (i.status === 'DELETED') return toView(i);
    if (!['ACTIVE', 'DEGRADED', 'STOPPED', 'FAILED'].includes(i.status)) {
      throw new ConflictError(`Cannot delete an instance in state ${i.status}`);
    }
    const from = i.status;
    await transition(this.prisma, { id: i.id, from, to: 'DELETING', eventType: 'deletion.started', message: 'Deletion started' });
    try {
      await this.runtime.remove(i.id, { deleteVolume: true });
    } catch (e) {
      await revert(this.prisma, {
        id: i.id, from: 'DELETING', to: from, eventType: 'deletion.failed', message: 'Deletion could not be completed',
      });
      throw e;
    }
    await transition(this.prisma, {
      id: i.id, from: 'DELETING', to: 'DELETED', eventType: 'instance.deleted', message: 'Instance and data deleted',
      data: { deletedAt: new Date(), hostPort: null },
    });
    return this.get(tenantId, instanceId);
  }

  private async runProvision(inst: Instance, plan: Plan): Promise<InstanceView> {
    const tenantId = inst.tenantId;
    try {
      await transition(this.prisma, {
        id: inst.id, from: inst.status, to: 'PROVISIONING', eventType: 'provisioning.started', message: 'Provisioning started',
      });
    } catch (e) {
      if (e instanceof ConflictError) return this.get(tenantId, inst.id); // another caller is driving it
      throw e;
    }
    let current: InstanceStatus = 'PROVISIONING';
    try {
      await this.runtime.ensure({
        instanceId: inst.id,
        tenantId,
        image: inst.image,
        limits: { cpuMillis: plan.cpuMillis, memoryMb: plan.memoryMb, pids: plan.pids },
        env: { HERMES_INSTANCE_ID: inst.id },
      });
      await transition(this.prisma, { id: inst.id, from: 'PROVISIONING', to: 'CONFIGURING', eventType: 'runtime.created', message: 'Runtime created' });
      current = 'CONFIGURING';
      await transition(this.prisma, { id: inst.id, from: 'CONFIGURING', to: 'STARTING', eventType: 'runtime.starting', message: 'Runtime starting' });
      current = 'STARTING';
      await this.runtime.start(inst.id);
      await this.waitHealthy(inst.id);
      const port = (await this.runtime.inspect(inst.id)).hostPort;
      await transition(this.prisma, {
        id: inst.id, from: 'STARTING', to: 'ACTIVE', eventType: 'instance.active', message: 'Instance is active',
        data: { hostPort: port, lastHealthAt: new Date(), ...RESET_RECOVERY },
      });
    } catch (e) {
      const reason =
        e instanceof RuntimeUnavailableError ? 'runtime_unavailable'
          : e instanceof HealthTimeout ? 'health_check_timeout'
            : 'runtime_create_failed';
      this.logger.error({ instanceId: inst.id, reason }, 'provisioning failed');
      await transition(this.prisma, {
        id: inst.id, from: current, to: 'FAILED', reason, eventType: 'provisioning.failed', message: `Provisioning failed: ${reason}`,
      }).catch(() => undefined);
      // A failed instance must not keep consuming node capacity (best effort; the daemon may be down).
      await this.runtime.stop(inst.id).catch(() => undefined);
      if (e instanceof RuntimeUnavailableError) throw e;
    }
    return this.get(tenantId, inst.id);
  }

  private async startFlow(i: Instance, op: 'start' | 'restart'): Promise<InstanceView> {
    const from = i.status;
    await transition(this.prisma, {
      id: i.id, from, to: 'STARTING', eventType: `runtime.${op}`, message: op === 'start' ? 'Runtime starting' : 'Runtime restarting',
    });
    try {
      await this.runtime[op](i.id);
    } catch (e) {
      if (e instanceof RuntimeUnavailableError) {
        await revert(this.prisma, { id: i.id, from: 'STARTING', to: from, eventType: 'runtime.unavailable', message: 'Operation could not be completed' });
        throw e;
      }
      this.logger.error({ instanceId: i.id, errName: (e as Error).name }, 'start failed');
      await this.degradeAfterStart(i.id, 'runtime_start_failed');
      return this.get(i.tenantId, i.id);
    }
    // From here the container may be running, so never revert to STOPPED: hand over to the Reconciler.
    try {
      await this.waitHealthy(i.id);
      const port = (await this.runtime.inspect(i.id)).hostPort;
      await transition(this.prisma, {
        id: i.id, from: 'STARTING', to: 'ACTIVE', eventType: 'instance.active', message: 'Instance is active',
        data: { hostPort: port, lastHealthAt: new Date(), ...RESET_RECOVERY },
      });
    } catch (e) {
      const reason = e instanceof HealthTimeout ? 'health_check_timeout'
        : e instanceof RuntimeUnavailableError ? 'runtime_unavailable' : 'runtime_start_failed';
      this.logger.error({ instanceId: i.id, reason }, 'start did not complete');
      await this.degradeAfterStart(i.id, reason);
    }
    return this.get(i.tenantId, i.id);
  }

  private async degradeAfterStart(instanceId: string, reason: string): Promise<void> {
    await transition(this.prisma, {
      id: instanceId, from: 'STARTING', to: 'DEGRADED', reason, eventType: 'instance.degraded', message: `Instance degraded: ${reason}`,
    }).catch(() => undefined);
  }

  private async waitHealthy(instanceId: string): Promise<void> {
    const end = Date.now() + this.healthTimeoutMs;
    for (;;) {
      if ((await this.runtime.checkHealth(instanceId)).ok) return;
      if (Date.now() >= end) throw new HealthTimeout();
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }
}

