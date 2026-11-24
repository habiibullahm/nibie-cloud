import type { Prisma } from '@prisma/client';
import { CapacityFullError } from '../../shared/errors.js';
import type { NodeCapacity, PlacementNode } from '../runtime/fleet.js';

const dimensions = ['cpuMillis', 'memoryMb', 'storageMb'] as const;
const zero = (): NodeCapacity => ({ cpuMillis: 0, memoryMb: 0, storageMb: 0 });
type Reservation = {
  subscriptionId?: string;
  waitlistEmail?: string;
  fixedNodeId?: string;
  preferredNodeId?: string | null;
  currentPlan?: NodeCapacity;
  regions?: readonly string[];
};

function add(used: NodeCapacity, requested: NodeCapacity, previous?: NodeCapacity) {
  for (const key of dimensions) used[key] += Math.max(0, requested[key] - (previous?.[key] ?? 0));
}

export class NodeScheduler {
  constructor(private readonly reachable: () => PlacementNode[]) {}

  /** Every capacity increase and its durable intent must run in the same transaction. */
  async lock(tx: Prisma.TransactionClient) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('runtime-capacity'))`;
  }

  async freeDemand(tx: Prisma.TransactionClient): Promise<NodeCapacity | null> {
    const { _max } = await tx.plan.aggregate({
      where: { active: true, monthlyPriceIdr: null },
      _max: { cpuMillis: true, memoryMb: true, storageMb: true },
    });
    if (_max.cpuMillis === null || _max.memoryMb === null || _max.storageMb === null) return null;
    return { cpuMillis: _max.cpuMillis, memoryMb: _max.memoryMb, storageMb: _max.storageMb };
  }

  async select(tx: Prisma.TransactionClient, demand: NodeCapacity, now: Date, claim: Reservation = {}): Promise<string> {
    await this.lock(tx);
    const live = this.reachable().filter(({ id }) => !claim.fixedNodeId || id === claim.fixedNodeId);
    const needsCordonCheck = claim.fixedNodeId === undefined;
    const regionFilter = claim.regions?.length ? { region: { in: [...claim.regions] } } : {};
    const candidates = await tx.runtimeNode.findMany({
      where: { id: { in: live.map((node) => node.id) }, ...(needsCordonCheck ? { schedulable: true } : {}), ...regionFilter },
      select: { id: true }, orderBy: { name: 'asc' },
    });
    const ids = candidates.map(({ id }) => id);
    if (!ids.length) throw new CapacityFullError();
    const [instances, retired, purchases, invitations, freePlan] = await Promise.all([
      tx.instance.findMany({
        where: { OR: [{ nodeId: { in: ids } }, { recoveryNodeId: { in: ids } }], status: { not: 'DELETED' } },
        select: { nodeId: true, recoveryNodeId: true, plan: { select: { cpuMillis: true, memoryMb: true, storageMb: true } } },
      }),
      tx.retiredRuntime.findMany({ where: { nodeId: { in: ids } }, select: { nodeId: true, storageMb: true } }),
      tx.subscription.findMany({
        where: {
          reservedNodeId: { in: ids }, ...(claim.subscriptionId ? { id: { not: claim.subscriptionId } } : {}),
          OR: [
            { status: 'PENDING_PAYMENT', payments: { some: { status: 'PENDING', expiresAt: { gt: now } } } },
            { status: { in: ['ACTIVE', 'GRACE', 'SUSPENDED'] } },
          ],
        },
        select: {
          reservedNodeId: true, plan: { select: { cpuMillis: true, memoryMb: true, storageMb: true } },
          instance: { select: { status: true, plan: { select: { cpuMillis: true, memoryMb: true, storageMb: true } } } },
        },
      }),
      tx.waitlistEntry.findMany({
        where: {
          reservedNodeId: { in: ids }, status: 'INVITED', inviteExpiresAt: { gt: now },
          ...(claim.waitlistEmail ? { email: { not: claim.waitlistEmail } } : {}),
        },
        select: { reservedNodeId: true },
      }),
      this.freeDemand(tx),
    ]);
    const used = new Map(ids.map((id) => [id, zero()]));
    for (const row of instances) {
      const source = used.get(row.nodeId);
      const recovery = row.recoveryNodeId && used.get(row.recoveryNodeId);
      if (source) add(source, row.plan);
      if (recovery) add(recovery, row.plan);
    }
    for (const copy of retired) used.get(copy.nodeId)!.storageMb += copy.storageMb;
    for (const row of purchases) {
      if (row.reservedNodeId && row.instance?.status !== 'DELETED') add(used.get(row.reservedNodeId)!, row.plan, row.instance?.plan);
    }
    if (freePlan) for (const row of invitations) {
      if (row.reservedNodeId) add(used.get(row.reservedNodeId)!, freePlan);
    }
    const ordered = claim.preferredNodeId && ids.includes(claim.preferredNodeId)
      ? [claim.preferredNodeId, ...ids.filter((id) => id !== claim.preferredNodeId)] : ids;
    for (const id of ordered) {
      const remaining = live.find((node) => node.id === id)!;
      const allocation = used.get(id)!;
      add(allocation, demand, claim.currentPlan);
      if (dimensions.every((key) => allocation[key] <= remaining[key])) return id;
    }
    throw new CapacityFullError();
  }
}
