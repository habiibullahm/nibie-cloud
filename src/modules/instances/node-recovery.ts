import type { Instance, PrismaClient } from '@prisma/client';
import { ConflictError, NotFoundError, RuntimeUnavailableError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import type { RuntimeConfigLoader } from '../integrations/runtime-env.js';
import type { RuntimeFleet } from '../runtime/fleet.js';
import { findOwned } from './instance-repo.js';
import type { NodeScheduler } from './node-scheduler.js';
import { runtimeSpec, type SpecDeps } from './runtime-apply.js';

/** Best-effort cleanup of retired source volumes once an instance has been deleted. */
export async function retireDeletedCopies(
  d: { prisma: PrismaClient; fleet: Pick<RuntimeFleet, 'runtimeForNode'>; logger: Logger },
  instanceId: string,
): Promise<void> {
  const copies = await d.prisma.retiredRuntime.findMany({ where: { instanceId } });
  for (const copy of copies) {
    try {
      const rt = d.fleet.runtimeForNode(copy.nodeId);
      const state = await rt.inspect(instanceId);
      if (['running', 'restarting'].includes(state.state)) continue;
      await rt.remove(instanceId, { deleteVolume: true });
      await d.prisma.retiredRuntime.deleteMany({ where: { nodeId: copy.nodeId, instanceId } });
    } catch (e) {
      d.logger.warn({ instanceId, nodeId: copy.nodeId, errName: (e as Error).name }, 'retired copy cleanup deferred');
    }
  }
}

/** Recovery preserves the instance identity. The operator fences the old host and restores its data offline. */
export class NodeRecovery {
  constructor(private readonly d: {
    prisma: PrismaClient;
    fleet: RuntimeFleet;
    placement: NodeScheduler;
    config: SpecDeps;
    loadConfig: RuntimeConfigLoader;
  }) {}

  private async checkSource(i: Instance, fenced: boolean) {
    try {
      const source = await this.d.fleet.inspect(i.id);
      if (['running', 'restarting'].includes(source.state)) throw new ConflictError('Stop the source instance before recovery');
    } catch (error) {
      if (!(error instanceof RuntimeUnavailableError) || !fenced) throw error;
    }
  }

  async prepare(tenantId: string, instanceId: string, nodeName: string, sourceFenced: boolean) {
    const { prisma, placement, fleet } = this.d;
    const i = await findOwned(prisma, tenantId, instanceId);
    const target = await prisma.runtimeNode.findUnique({ where: { name: nodeName } });
    if (!target) throw new NotFoundError('Recovery node not found');
    if (target.id === i.nodeId || (i.recoveryNodeId && i.recoveryNodeId !== target.id)) throw new ConflictError('Invalid recovery node');
    if (!['ACTIVE', 'DEGRADED', 'STOPPED'].includes(i.status) || (!sourceFenced && i.status !== 'STOPPED')) {
      throw new ConflictError('Stop the instance or confirm the source host is fenced');
    }
    if (!i.recoveryNodeId && !target.schedulable) throw new ConflictError('Recovery node is cordoned');
    const runtime = fleet.runtimeForNode(target.id);
    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: i.planId } });
    if (!i.recoveryNodeId) {
      const existing = await runtime.inspect(instanceId);
      if (existing.state !== 'absent' || existing.volumePresent) throw new ConflictError('Recovery node has an existing copy');
      await this.checkSource(i, sourceFenced);
      await prisma.$transaction(async (tx) => {
        const now = new Date();
        const upgrade = await tx.subscription.findFirst({
          where: {
            instanceId: i.id,
            planId: { not: i.planId },
            OR: [
              { status: 'PENDING_PAYMENT', payments: { some: { status: 'PENDING', expiresAt: { gt: now } } } },
              { status: { in: ['ACTIVE', 'GRACE', 'SUSPENDED'] } },
            ],
          },
          select: { id: true, plan: { select: { cpuMillis: true, memoryMb: true, storageMb: true } } },
        });
        const demand = upgrade
          ? {
              cpuMillis: Math.max(plan.cpuMillis, upgrade.plan.cpuMillis),
              memoryMb: Math.max(plan.memoryMb, upgrade.plan.memoryMb),
              storageMb: Math.max(plan.storageMb, upgrade.plan.storageMb),
            }
          : plan;
        await placement.select(tx, demand, now, { fixedNodeId: target.id, ...(upgrade ? { subscriptionId: upgrade.id } : {}) });
        if (!await tx.runtimeNode.count({ where: { id: target.id, schedulable: true } })) throw new ConflictError('Recovery node is cordoned');
        if (await tx.retiredRuntime.count({ where: { nodeId: target.id, instanceId } })) {
          throw new ConflictError('Discard the previous source copy before reusing this node');
        }
        const claimed = await tx.instance.updateMany({
          where: { id: i.id, nodeId: i.nodeId, planId: i.planId, status: i.status, operationOwner: null, recoveryNodeId: null },
          data: { status: 'STOPPED', statusReason: 'node_recovery', hostPort: null, recoveryNodeId: target.id },
        });
        if (!claimed.count) throw new ConflictError('Instance changed during recovery preparation');
        await tx.instanceEvent.create({ data: { instanceId, type: 'runtime.recovery_prepared', message: 'Recovery capacity reserved' } });
      });
    }
    const cfg = await this.d.loadConfig(i.tenantId, i.id);
    await runtime.ensure(runtimeSpec(this.d.config, i, plan, cfg));
    return { node: target.name, instanceId, status: 'prepared' };
  }

  async finish(tenantId: string, instanceId: string, sourceFenced: boolean) {
    const { prisma, fleet, placement } = this.d;
    const i = await findOwned(prisma, tenantId, instanceId);
    if (!i.recoveryNodeId || i.status !== 'STOPPED') throw new ConflictError('No recovery is in progress');
    const targetId = i.recoveryNodeId;
    const runtime = fleet.runtimeForNode(targetId);
    const staged = await runtime.inspect(instanceId);
    if (!staged.volumePresent || !['created', 'exited'].includes(staged.state)) throw new ConflictError('Recovery volume is not ready');
    await this.checkSource(i, sourceFenced);
    await prisma.$transaction(async (tx) => {
      await placement.lock(tx);
      const moved = await tx.instance.updateMany({
        where: { id: i.id, nodeId: i.nodeId, status: 'STOPPED', recoveryNodeId: targetId },
        data: {
          nodeId: targetId, recoveryNodeId: null, statusReason: null, hostPort: null, diskUsedBytes: null, diskLevel: 'ok',
          consecutiveFailures: 0, recoveryAttempts: 0, nextRecoveryAt: null, lastHealthAt: null,
          configRevision: { increment: 1 },
        },
      });
      if (!moved.count) throw new ConflictError('Instance changed during recovery');
      await tx.subscription.updateMany({
        where: { instanceId: i.id, reservedNodeId: i.nodeId },
        data: { reservedNodeId: targetId },
      });
      const plan = await tx.plan.findUniqueOrThrow({ where: { id: i.planId }, select: { storageMb: true } });
      await tx.retiredRuntime.create({ data: { nodeId: i.nodeId, instanceId, storageMb: plan.storageMb } });
      await tx.instanceEvent.create({ data: { instanceId, type: 'runtime.recovered_on_node', message: 'Instance moved to recovery node' } });
    });
    return { instanceId, status: 'restored' };
  }

  async retire(tenantId: string, instanceId: string, nodeName: string) {
    const { prisma, fleet, placement } = this.d;
    await findOwned(prisma, tenantId, instanceId);
    const node = await prisma.runtimeNode.findUnique({ where: { name: nodeName } });
    if (!node) throw new NotFoundError('Runtime node not found');
    const where = { nodeId_instanceId: { nodeId: node.id, instanceId } };
    if (!await prisma.retiredRuntime.findUnique({ where })) return { instanceId, status: 'retired' };
    const runtime = fleet.runtimeForNode(node.id);
    const state = await runtime.inspect(instanceId);
    if (['running', 'restarting'].includes(state.state)) throw new ConflictError('The old runtime must be stopped');
    // Remote Docker removal runs outside the global capacity lock; RetiredRuntime keeps disk reserved until deleted below.
    await runtime.remove(instanceId, { deleteVolume: true });
    await prisma.$transaction(async (tx) => {
      await placement.lock(tx);
      const deleted = await tx.retiredRuntime.deleteMany({ where: { nodeId: node.id, instanceId } });
      if (deleted.count > 0) {
        await tx.instanceEvent.create({ data: { instanceId, type: 'runtime.source_retired', message: 'Old source volume discarded by operator' } });
      }
    });
    return { instanceId, status: 'retired' };
  }

  async cancel(tenantId: string, instanceId: string) {
    const { prisma, fleet, placement } = this.d;
    const i = await findOwned(prisma, tenantId, instanceId);
    if (!i.recoveryNodeId || i.status !== 'STOPPED') throw new ConflictError('No recovery is in progress');
    const source = await fleet.inspect(instanceId);
    if (!source.volumePresent || ['running', 'restarting'].includes(source.state)) {
      throw new ConflictError('A stopped copy on the source node is required to cancel recovery');
    }
    const target = fleet.runtimeForNode(i.recoveryNodeId);
    // Remote Docker removal runs outside the global capacity lock; recoveryNodeId stays set until the copy is gone.
    await target.remove(instanceId, { deleteVolume: true });
    await prisma.$transaction(async (tx) => {
      await placement.lock(tx);
      const cancelled = await tx.instance.updateMany({
        where: { id: i.id, nodeId: i.nodeId, status: 'STOPPED', recoveryNodeId: i.recoveryNodeId },
        data: { recoveryNodeId: null, statusReason: null },
      });
      if (!cancelled.count) throw new ConflictError('Instance changed during recovery');
      await tx.instanceEvent.create({ data: { instanceId, type: 'runtime.recovery_cancelled', message: 'Recovery cancelled by operator' } });
    });
    return { instanceId, status: 'cancelled' };
  }
}
