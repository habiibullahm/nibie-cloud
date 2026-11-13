import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import type { Logger } from '../../shared/logger.js';
import { watchConnection } from './redis-log.js';
import { closeWithin } from './shutdown.js';

export const MAINTENANCE_QUEUE = 'maintenance';

/** Delete the key only if it still holds our token, so an expired lock taken by someone else survives. */
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/** A `SET NX PX` lock in Redis. One connection for the process; `skipped` when someone else holds it. */
export function createLocker(redisUrl: string, prefix = 'bull') {
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: 2 });
  redis.on('error', () => { /* ioredis reconnects; callers see the failed command */ });
  return {
    async withLock(key: string, ttlMs: number, fn: () => Promise<void>): Promise<'ran' | 'skipped'> {
      const redisKey = `${prefix}:lock:${key}`;
      const token = randomUUID();
      if ((await redis.set(redisKey, token, 'PX', ttlMs, 'NX')) !== 'OK') return 'skipped';
      try {
        await fn();
        return 'ran';
      } finally {
        await redis.eval(RELEASE, 1, redisKey, token).catch(() => undefined);
      }
    },
    close: async (): Promise<void> => { redis.disconnect(); },
  };
}

export interface Scheduler {
  /** Stops this process's part. Waits for a running tick, but never past `deadlineMs` (default 10 s). */
  stop(deadlineMs?: number): Promise<void>;
  /** False while Redis is unreachable; the in-process fallback runs then. */
  isConnected(): boolean;
  /** Resolves once the schedule is registered in Redis (never, while Redis is down). */
  registered: Promise<void>;
}

/**
 * Runs `sweep()` and then `reconciler.reconcileAll()` every `intervalMs`: the sweep first, so stranded
 * PENDING instances are enqueued before the reaper looks at them. The schedule lives in Redis (one
 * scheduler id, so any number of replicas share it) and each run holds a Redis lock, so replicas
 * do not normally reconcile at once (the lock is not renewed; database claims keep overlap safe).
 * While Redis is unreachable the ticks cannot run, so this process reconciles on its own timer instead:
 * recovery and lease reaping never depend on Redis being up.
 */
export function startScheduler(o: {
  redisUrl: string;
  prefix?: string;
  reconciler: { reconcileAll(): Promise<void> };
  sweep: () => Promise<number>;
  intervalMs: number;
  /** How often the schedule is re-registered, in case Redis lost it. Default 60 s. */
  reregisterMs?: number;
  logger: Logger;
}): Scheduler {
  const prefixOpt = o.prefix ? { prefix: o.prefix } : {};
  const queueConn = new IORedis(o.redisUrl, { maxRetriesPerRequest: null });
  const workerConn = new IORedis(o.redisUrl, { maxRetriesPerRequest: null });
  watchConnection(queueConn, o.logger, 'scheduler-queue');
  watchConnection(workerConn, o.logger, 'scheduler-worker');
  const locker = createLocker(o.redisUrl, o.prefix);
  const ttl = Math.max(3 * o.intervalMs, 60_000);

  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async () => {
      const outcome = await locker.withLock('maintenance', ttl, async () => {
        try {
          await o.sweep();
        } catch (e) {
          o.logger.warn({ errName: (e as Error).name }, 'pending sweep failed');
        }
        await o.reconciler.reconcileAll();
      });
      if (outcome === 'skipped') o.logger.debug('maintenance tick skipped: another replica holds the lock');
    },
    { connection: workerConn, concurrency: 1, ...prefixOpt },
  );
  worker.on('error', (e) => o.logger.error({ errName: e.name }, 'maintenance worker error'));
  worker.on('failed', (_job, e) => o.logger.error({ errName: e.name }, 'maintenance tick failed'));

  const queue = new Queue(MAINTENANCE_QUEUE, { connection: queueConn, ...prefixOpt, defaultJobOptions: { removeOnComplete: true, removeOnFail: true } });
  queue.on('error', () => undefined);
  const register = () => queue.upsertJobScheduler('tick', { every: o.intervalMs }, { name: 'tick', data: {} });
  const registered = register().then(() => undefined);
  registered.catch(() => undefined);
  // The schedule is data in Redis: a restart without persistence would silently stop the reconciler.
  const keepAlive = setInterval(() => {
    register().catch((e: Error) => o.logger.warn({ errName: e.name }, 'could not re-register the maintenance schedule'));
  }, o.reregisterMs ?? 60_000);
  keepAlive.unref();

  const isConnected = () => workerConn.status === 'ready' && queueConn.status === 'ready';
  let fallbackRunning = false;
  const fallback = setInterval(() => {
    if (isConnected() || fallbackRunning) return;
    fallbackRunning = true;
    o.reconciler.reconcileAll()
      .catch((e: Error) => o.logger.error({ errName: e.name }, 'fallback reconcile failed'))
      .finally(() => { fallbackRunning = false; });
  }, o.intervalMs);
  fallback.unref();

  return {
    isConnected,
    registered,
    stop: async (deadlineMs = 10_000) => {
      clearInterval(keepAlive);
      clearInterval(fallback);
      await closeWithin(deadlineMs, () => worker.close(), () => worker.close(true));
      await closeWithin(2000, () => queue.close(), () => undefined);
      await locker.close();
      queueConn.disconnect();
      workerConn.disconnect();
    },
  };
}
