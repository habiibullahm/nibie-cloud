import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { createLocker, startScheduler } from '../../src/modules/jobs/scheduler.js';
import { silentLogger } from '../helpers/service-env.js';
import { redisTestUrl, uniquePrefix } from '../helpers/redis.js';

const url = redisTestUrl();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let prefix: string;
let conn: IORedis;
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  prefix = uniquePrefix();
  conn = new IORedis(url, { maxRetriesPerRequest: null });
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  const q = new Queue('maintenance', { connection: conn, prefix });
  await q.obliterate({ force: true });
  await q.close();
  for (const k of await conn.keys(`${prefix}:*`)) await conn.del(k);
  await conn.quit();
});

describe('createLocker', () => {
  it('lets one of two concurrent callers run and skips the other', async () => {
    const locker = createLocker(url, prefix);
    closers.push(() => locker.close());
    let ran = 0;
    const work = async () => { ran++; await sleep(100); };
    const results = await Promise.all([locker.withLock('k', 5000, work), locker.withLock('k', 5000, work)]);
    expect(results.sort()).toEqual(['ran', 'skipped']);
    expect(ran).toBe(1);
  });

  it('releases the lock when the work throws', async () => {
    const locker = createLocker(url, prefix);
    closers.push(() => locker.close());
    await expect(locker.withLock('k', 5000, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await locker.withLock('k', 5000, async () => undefined)).toBe('ran');
  });

  it('frees a lock whose holder vanished once its ttl expires', async () => {
    const locker = createLocker(url, prefix);
    closers.push(() => locker.close());
    await conn.set(`${prefix}:lock:k`, 'dead-holder', 'PX', 250);
    expect(await locker.withLock('k', 5000, async () => undefined)).toBe('skipped');
    await sleep(350);
    expect(await locker.withLock('k', 5000, async () => undefined)).toBe('ran');
  });

  it('does not delete a lock that expired and was taken by someone else', async () => {
    const locker = createLocker(url, prefix);
    closers.push(() => locker.close());
    await locker.withLock('k', 100, async () => {
      await sleep(200);
      await conn.set(`${prefix}:lock:k`, 'other-holder', 'PX', 5000);
    });
    expect(await conn.get(`${prefix}:lock:k`)).toBe('other-holder');
  });
});

describe('startScheduler', () => {
  it('sweeps stranded PENDING instances before it reconciles (so the reaper cannot fail them first)', async () => {
    const order: string[] = [];
    const opts = {
      redisUrl: url, prefix, reconciler: { reconcileAll: async () => { order.push('reconcile'); } },
      sweep: async () => { order.push('sweep'); return 0; }, intervalMs: 100, logger: silentLogger,
    };
    closers.push(startScheduler(opts).stop);
    await waitUntil(() => order.length >= 2);
    expect(order.slice(0, 2)).toEqual(['sweep', 'reconcile']);
  });

  it('keeps reconciling in-process while Redis is unreachable', async () => {
    let calls = 0;
    const sch = startScheduler({
      redisUrl: 'redis://127.0.0.1:1', prefix, reconciler: { reconcileAll: async () => { calls++; } },
      sweep: async () => 0, intervalMs: 100, logger: silentLogger,
    });
    closers.push(() => sch.stop(200));
    expect(sch.isConnected()).toBe(false);
    await waitUntil(() => calls >= 2, 3000);
  });

  it('runs the reconciler on a schedule and never overlaps across two schedulers', async () => {
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    const reconciler = {
      async reconcileAll() {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await sleep(400); // longer than the interval, so ticks would overlap without the lock
        running--;
        calls++;
      },
    };
    const opts = { redisUrl: url, prefix, reconciler, sweep: async () => 0, intervalMs: 150, logger: silentLogger };
    closers.push(startScheduler(opts).stop, startScheduler(opts).stop);
    await sleep(2500);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(maxRunning).toBe(1);
  });

  it('keeps ticking when the sweep throws', async () => {
    let sweeps = 0;
    const opts = {
      redisUrl: url, prefix, reconciler: { reconcileAll: async () => undefined },
      sweep: async () => { sweeps++; throw new Error('queue down'); }, intervalMs: 100, logger: silentLogger,
    };
    closers.push(startScheduler(opts).stop);
    await sleep(1200);
    expect(sweeps).toBeGreaterThanOrEqual(2);
  });

  it('resumes ticking after Redis loses its data (the schedule itself lives in Redis)', async () => {
    let calls = 0;
    const opts = {
      redisUrl: url, prefix, reconciler: { reconcileAll: async () => { calls++; } },
      sweep: async () => 0, intervalMs: 100, reregisterMs: 300, logger: silentLogger,
    };
    closers.push(startScheduler(opts).stop);
    await waitUntil(() => calls >= 2);
    for (const k of await conn.keys(`${prefix}:*`)) await conn.del(k); // what a restart without persistence does
    const before = calls;
    await sleep(150);
    await waitUntil(() => calls >= before + 3, 3000);
  });
});

async function waitUntil(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(25);
  }
}
