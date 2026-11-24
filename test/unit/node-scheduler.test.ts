import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { NodeScheduler } from '../../src/modules/instances/node-scheduler.js';
import type { PlacementNode } from '../../src/modules/runtime/fleet.js';
import { CapacityFullError } from '../../src/shared/errors.js';

interface FakeNodeRow {
  id: string;
  name: string;
  region: string;
  schedulable: boolean;
}

interface FakeInstanceRow {
  nodeId: string;
  recoveryNodeId: string | null;
  plan: { cpuMillis: number; memoryMb: number; storageMb: number };
}

function makeFakeTx(nodes: FakeNodeRow[], instances: FakeInstanceRow[] = []) {
  const tx = {
    $executeRaw: async () => 0,
    runtimeNode: {
      findMany: async (args: {
        where: { id: { in: string[] }; schedulable?: boolean; region?: { in: string[] } };
      }) => {
        const ids = new Set(args.where.id.in);
        const regions = args.where.region ? new Set(args.where.region.in) : null;
        return nodes
          .filter(
            (n) =>
              ids.has(n.id) &&
              (args.where.schedulable === undefined || n.schedulable === args.where.schedulable) &&
              (regions === null || regions.has(n.region)),
          )
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(({ id }) => ({ id }));
      },
    },
    instance: {
      findMany: async (args: { where: { OR: Array<{ nodeId?: { in: string[] }; recoveryNodeId?: { in: string[] } }> } }) => {
        const ids = new Set(args.where.OR.flatMap((c) => c.nodeId?.in ?? c.recoveryNodeId?.in ?? []));
        return instances.filter((i) => ids.has(i.nodeId) || (i.recoveryNodeId !== null && ids.has(i.recoveryNodeId)));
      },
    },
    retiredRuntime: { findMany: async () => [] },
    subscription: { findMany: async () => [] },
    waitlistEntry: { findMany: async () => [] },
    plan: { aggregate: async () => ({ _max: { cpuMillis: 500, memoryMb: 256, storageMb: 1024 } }) },
  };
  return tx as unknown as Prisma.TransactionClient;
}

describe('NodeScheduler region filtering', () => {
  const demand = { cpuMillis: 1000, memoryMb: 512, storageMb: 1024 };
  const now = new Date('2026-11-25T00:00:00.000Z');
  const nodes: FakeNodeRow[] = [
    { id: 'n-jkt', name: 'jkt-1', region: 'id-jakarta', schedulable: true },
    { id: 'n-sg', name: 'jkt-2', region: 'sg-singapore', schedulable: true },
  ];
  const placementNodes: PlacementNode[] = [
    { id: 'n-jkt', cpuMillis: 1000, memoryMb: 512, storageMb: 1024 },
    { id: 'n-sg', cpuMillis: 1000, memoryMb: 512, storageMb: 1024 },
  ];

  it('skips nodes outside regions and throws CapacityFullError when matching nodes are full', async () => {
    const scheduler = new NodeScheduler(() => placementNodes);
    const tx = makeFakeTx(nodes, [{ nodeId: 'n-jkt', recoveryNodeId: null, plan: demand }]);

    await expect(scheduler.select(tx, demand, now, { regions: ['id-jakarta'] })).rejects.toBeInstanceOf(
      CapacityFullError,
    );
    await expect(scheduler.select(tx, demand, now)).resolves.toBe('n-sg');
    await expect(scheduler.select(tx, demand, now, { regions: [] })).resolves.toBe('n-sg');
  });

  it('selects a matching node when regions are given', async () => {
    const scheduler = new NodeScheduler(() => placementNodes);
    const tx = makeFakeTx(nodes);

    await expect(scheduler.select(tx, demand, now, { regions: ['sg-singapore'] })).resolves.toBe('n-sg');
    await expect(scheduler.select(tx, demand, now, { regions: ['id-jakarta'] })).resolves.toBe('n-jkt');
  });
});
