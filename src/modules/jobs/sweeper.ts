import type { PrismaClient } from '@prisma/client';
import type { JobQueue } from './types.js';

/**
 * Hands PENDING instances that nothing is working on to the queue. A PENDING row is the durable intent
 * of a provision request, so this recovers requests accepted while Redis was down or lost with it.
 * Idempotent: the job id is `<instanceId>_provision`, so repeated sweeps never create a second job.
 * Returns how many instances it handed over. Throws when the queue is unreachable.
 */
export async function sweepPending(o: {
  prisma: PrismaClient;
  queue: JobQueue;
  olderThanMs: number;
  now?: () => Date;
  limit?: number;
}): Promise<number> {
  const cutoff = new Date((o.now ?? (() => new Date()))().getTime() - o.olderThanMs);
  const rows = await o.prisma.instance.findMany({
    where: { status: 'PENDING', createdAt: { lt: cutoff } },
    orderBy: { createdAt: 'asc' },
    take: o.limit ?? 50,
    select: { id: true, tenantId: true },
  });
  for (const r of rows) await o.queue.enqueue({ op: 'provision', tenantId: r.tenantId, instanceId: r.id });
  return rows.length;
}
