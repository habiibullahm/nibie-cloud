import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { NotFoundError, QueueUnavailableError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import { backoffMs } from '../instances/reconciler.js';
import { watchConnection } from './redis-log.js';
import { closeWithin } from './shutdown.js';
import type { FailedJob, InstanceOp, InstanceOpPayload, JobQueue } from './types.js';

export const INSTANCE_QUEUE = 'instance-ops';
export const MAX_ATTEMPTS = 4;
const FAILED_RETENTION_SECONDS = 7 * 24 * 3600;
const READY_TIMEOUT_MS = 1500;
const FAILED_PAGE = 100;

/** BullMQ forbids `:` in custom ids, so ids use `_`. A dedupe key makes one job per request. */
export function jobIdFor(p: InstanceOpPayload, dedupeKey?: string): string {
  const base = `${p.instanceId}_${p.op}`;
  return dedupeKey === undefined ? base : `${base}_${dedupeKey.replaceAll(':', '-')}`;
}

/** Worker-side backoff: the first retry (attemptsMade = 1) waits like reconciler attempt 0. */
export const workerBackoff = (attemptsMade: number): number => backoffMs(Math.max(0, attemptsMade - 1));

const isReason = (r: string): boolean => /^[A-Za-z0-9_]{1,64}$/.test(r);
/** BullMQ's own failure texts are not error class names; give the stalled one a stable label. */
const reasonOf = (r: string | undefined): string => (isReason(r ?? '') ? r! : /stalled/i.test(r ?? '') ? 'JobStalled' : 'Error');

export function createBullQueue(o: { redisUrl: string; prefix?: string; queueName?: string; logger?: Logger }): JobQueue {
  // No offline queue: when Redis is down a request fails at once instead of waiting for it to return.
  const connection = new IORedis(o.redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: READY_TIMEOUT_MS });
  // Errors are surfaced per call as QueueUnavailableError; the log only needs to show that Redis is away.
  if (o.logger) watchConnection(connection, o.logger, 'queue');
  else connection.on('error', () => undefined);
  // BullMQ runs INFO while constructing a Queue, which fails on a connection that is not ready yet
  // (no offline queue), so the Queue is created on first use, after the connection is ready.
  let queue: Queue | null = null;
  function q(): Queue {
    if (queue) return queue;
    queue = new Queue(o.queueName ?? INSTANCE_QUEUE, {
      connection,
      ...(o.prefix ? { prefix: o.prefix } : {}),
      skipWaitingForReady: true,
      defaultJobOptions: {
        attempts: MAX_ATTEMPTS,
        backoff: { type: 'custom' },
        removeOnComplete: true,
        removeOnFail: { age: FAILED_RETENTION_SECONDS },
      },
    });
    queue.on('error', () => undefined); // once per Queue, not per call
    return queue;
  }

  async function ready(): Promise<void> {
    if (connection.status === 'ready') return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new QueueUnavailableError()); }, READY_TIMEOUT_MS);
      const onReady = () => { cleanup(); resolve(); };
      const cleanup = () => { clearTimeout(timer); connection.off('ready', onReady); };
      connection.on('ready', onReady);
      if (connection.status === 'wait' || connection.status === 'end') connection.connect().catch(() => { /* timer rejects */ });
    });
  }

  async function guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      await ready();
      return await fn();
    } catch (e) {
      if (e instanceof QueueUnavailableError || e instanceof NotFoundError) throw e;
      throw new QueueUnavailableError();
    }
  }

  return {
    enqueue: (p, opts) => guard(async () => {
      let jobId = jobIdFor(p, opts?.dedupeKey);
      const existing = await q().getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (state === 'failed') await existing.remove();
        // BullMQ ignores an add whose id exists in any state. A twin that is already running (or just
        // finished) cannot absorb this request, which passed its state check later: give it its own job.
        else if (state === 'active' || state === 'completed') jobId = `${jobId}_${randomUUID().slice(0, 8)}`;
      }
      await q().add(p.op, { op: p.op, tenantId: p.tenantId, instanceId: p.instanceId }, { jobId });
      return { jobId };
    }),

    listFailed: () => guard(async () => {
      const jobs = await q().getFailed(0, FAILED_PAGE - 1);
      return jobs.map((j): FailedJob => ({
        jobId: j.id ?? '',
        op: j.data.op as InstanceOp,
        instanceId: String(j.data.instanceId),
        attempts: j.attemptsMade,
        reason: reasonOf(j.failedReason),
        failedAt: new Date(j.finishedOn ?? 0),
      }));
    }),

    retryFailed: (jobId) => guard(async () => {
      const job = await q().getJob(jobId);
      if (!job || (await job.getState()) !== 'failed') throw new NotFoundError('Failed job not found');
      await job.retry('failed');
    }),

    close: async () => {
      await closeWithin(5000, async () => { await queue?.close(); }, async () => undefined);
      connection.disconnect();
    },
  };
}
