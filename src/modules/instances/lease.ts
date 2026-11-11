import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from '../../shared/logger.js';

export interface Lease {
  owner: string;
  expiresAt: Date;
}

export function newLease(ttlMs: number, now: () => Date = () => new Date()): Lease {
  return { owner: randomUUID(), expiresAt: new Date(now().getTime() + ttlMs) };
}

export interface HeartbeatOpts {
  prisma: PrismaClient;
  instanceId: string;
  owner: string;
  ttlMs: number;
  /** Stop renewing after this long so a hung operation eventually becomes reapable. */
  maxOperationMs: number;
  logger: Logger;
  now?: () => Date;
}

/**
 * Renews the operation lease every ttl/3 while the operation runs. Renewal only succeeds
 * while `operationOwner` still matches, so an operation that lost its lease (reaped or taken
 * over) quietly stops beating. Returns a stop function; call it in `finally`.
 */
export function startHeartbeat(o: HeartbeatOpts): () => void {
  const now = o.now ?? (() => new Date());
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
  timer = setInterval(() => {
    if (stopped) return;
    if (Date.now() - startedAt > o.maxOperationMs) {
      o.logger.warn({ instanceId: o.instanceId }, 'operation exceeded max duration; lease no longer renewed');
      return stop();
    }
    o.prisma.instance
      .updateMany({
        where: { id: o.instanceId, operationOwner: o.owner },
        data: { leaseExpiresAt: new Date(now().getTime() + o.ttlMs) },
      })
      .then((res) => { if (res.count === 0) stop(); })
      .catch((e: unknown) => o.logger.warn({ instanceId: o.instanceId, errName: (e as Error).name }, 'lease renewal failed'));
  }, Math.max(50, Math.floor(o.ttlMs / 3)));
  timer.unref();
  return stop;
}
