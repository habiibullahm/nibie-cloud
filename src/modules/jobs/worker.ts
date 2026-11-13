import { UnrecoverableError, Worker } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import type { InstanceService } from '../instances/instance-service.js';
import { INSTANCE_QUEUE, workerBackoff } from './bullmq-queue.js';
import { watchConnection } from './redis-log.js';
import { closeWithin } from './shutdown.js';
import { INSTANCE_OPS, type InstanceOpPayload } from './types.js';

const payloadSchema = z.object({
  op: z.enum(INSTANCE_OPS),
  tenantId: z.string().uuid(),
  instanceId: z.string().uuid(),
}).strict();

/**
 * Permanent: retrying cannot change the outcome (wrong state, missing row, malformed job).
 * Everything else, including runtime and database outages, is retried with backoff.
 */
export function classify(e: unknown): 'permanent' | 'retry' {
  return e instanceof ConflictError || e instanceof NotFoundError || e instanceof ValidationError ? 'permanent' : 'retry';
}

async function run(service: InstanceService, p: InstanceOpPayload): Promise<void> {
  switch (p.op) {
    case 'provision': await service.runProvisionById(p.tenantId, p.instanceId); return;
    case 'start': await service.start(p.tenantId, p.instanceId); return;
    case 'stop': await service.stop(p.tenantId, p.instanceId); return;
    case 'restart': await service.restart(p.tenantId, p.instanceId); return;
    case 'delete': await service.delete(p.tenantId, p.instanceId); return;
  }
}

export function createInstanceWorker(o: {
  redisUrl: string;
  prefix?: string;
  queueName?: string;
  service: InstanceService;
  logger: Logger;
  concurrency?: number;
  /** Retry delay for `attemptsMade` failures so far. Tests shorten it. */
  backoffMs?: (attemptsMade: number) => number;
  /** Stalled-job detection timing; tests shorten it. */
  stalledInterval?: number;
  lockDuration?: number;
}): { close(deadlineMs?: number): Promise<void> } {
  const connection = new IORedis(o.redisUrl, { maxRetriesPerRequest: null });
  watchConnection(connection, o.logger, 'worker');
  const worker = new Worker(
    o.queueName ?? INSTANCE_QUEUE,
    async (job) => {
      const parsed = payloadSchema.safeParse(job.data);
      if (!parsed.success) throw new UnrecoverableError('ValidationError');
      const p = parsed.data;
      try {
        await run(o.service, p);
      } catch (e) {
        // Only the class name leaves this function: error messages can carry secrets and end up in Redis.
        const name = e instanceof Error ? e.name : 'Error';
        o.logger.warn({ jobId: job.id, op: p.op, instanceId: p.instanceId, attempt: job.attemptsMade + 1, errName: name }, 'instance job failed');
        throw classify(e) === 'permanent' ? new UnrecoverableError(name) : new Error(name);
      }
    },
    {
      connection,
      ...(o.prefix ? { prefix: o.prefix } : {}),
      concurrency: o.concurrency ?? 4,
      // A job whose lock was lost is failed (JobStalled), never redelivered: restart is not idempotent by
      // state, and a crashed operation is resolved by the lease reaper, not by running it again.
      maxStalledCount: 0,
      ...(o.stalledInterval ? { stalledInterval: o.stalledInterval } : {}),
      ...(o.lockDuration ? { lockDuration: o.lockDuration } : {}),
      settings: { backoffStrategy: o.backoffMs ?? workerBackoff },
    },
  );
  worker.on('error', (e) => o.logger.error({ errName: e.name }, 'job worker error'));
  return {
    // Waits for running jobs, but not past the deadline (a dead Redis would otherwise block shutdown).
    close: async (deadlineMs = 10_000) => {
      await closeWithin(deadlineMs, () => worker.close(), () => worker.close(true));
      connection.disconnect();
    },
  };
}
