import { afterEach, describe, expect, it } from 'vitest';
import { createBullQueue } from '../../src/modules/jobs/bullmq-queue.js';
import { startScheduler } from '../../src/modules/jobs/scheduler.js';
import { createInstanceWorker } from '../../src/modules/jobs/worker.js';
import type { InstanceService } from '../../src/modules/instances/instance-service.js';
import { silentLogger } from '../helpers/service-env.js';
import { startPrivateRedis } from '../helpers/redis.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0)) await c().catch(() => undefined); });

async function within(ms: number, fn: () => Promise<unknown>): Promise<number> {
  const started = Date.now();
  await Promise.race([fn(), sleep(ms).then(() => { throw new Error(`did not finish within ${ms} ms`); })]);
  return Date.now() - started;
}

describe('shutdown while Redis is down', () => {
  it('closes the instance worker within its deadline', async () => {
    const redis = await startPrivateRedis(6391);
    cleanup.push(redis.kill);
    const w = createInstanceWorker({ redisUrl: redis.url, service: {} as InstanceService, logger: silentLogger });
    await sleep(300);
    await redis.kill();
    await sleep(200);
    await within(3000, () => w.close(300));
  });

  it('stops the scheduler within its deadline', async () => {
    const redis = await startPrivateRedis(6392);
    cleanup.push(redis.kill);
    const sch = startScheduler({
      redisUrl: redis.url, reconciler: { reconcileAll: async () => undefined }, sweep: async () => 0, intervalMs: 200, logger: silentLogger,
    });
    await sch.registered;
    await redis.kill();
    await sleep(200);
    await within(3000, () => sch.stop(300));
  });

  it('closes the producer queue without hanging', async () => {
    const redis = await startPrivateRedis(6393);
    cleanup.push(redis.kill);
    const q = createBullQueue({ redisUrl: redis.url });
    await q.enqueue({ op: 'stop', tenantId: '11111111-1111-4111-8111-111111111111', instanceId: '22222222-2222-4222-8222-222222222222' });
    await redis.kill();
    await sleep(200);
    await within(3000, () => q.close());
  });
});
