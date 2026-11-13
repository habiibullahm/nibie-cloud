import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { createPrisma } from '../../src/db/client.js';
import { INSTANCE_QUEUE, createBullQueue } from '../../src/modules/jobs/bullmq-queue.js';
import { sweepPending } from '../../src/modules/jobs/sweeper.js';
import { resetDb } from '../helpers/db.js';
import { redisTestUrl, uniquePrefix } from '../helpers/redis.js';
import { seed } from '../helpers/service-env.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const url = redisTestUrl();

let s: Awaited<ReturnType<typeof seed>>;
let queue: ReturnType<typeof createBullQueue>;
let raw: Queue;
let conn: IORedis;

const make = (status: 'PENDING' | 'ACTIVE' | 'FAILED' = 'PENDING') =>
  prisma.instance.create({
    data: { tenantId: s.tenant.id, planId: s.plan.id, nodeId: s.node.id, name: 'x', idempotencyKey: crypto.randomUUID(), image: 'hermes-stub:0.2.0', status },
  });
const later = () => new Date(Date.now() + 60_000);

describe('sweepPending', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seed(prisma);
    const prefix = uniquePrefix();
    queue = createBullQueue({ redisUrl: url, prefix });
    conn = new IORedis(url, { maxRetriesPerRequest: null });
    raw = new Queue(INSTANCE_QUEUE, { connection: conn, prefix });
  });
  afterEach(async () => {
    await raw.obliterate({ force: true });
    await raw.close();
    await conn.quit();
    await queue.close();
  });
  afterAll(() => prisma.$disconnect());

  it('enqueues a stale PENDING instance once, however often it sweeps', async () => {
    const i = await make();
    expect(await sweepPending({ prisma, queue, olderThanMs: 30_000, now: later })).toBe(1);
    expect(await sweepPending({ prisma, queue, olderThanMs: 30_000, now: later })).toBe(1);
    expect(await raw.getJobCountByTypes('waiting')).toBe(1);
    expect((await raw.getJob(`${i.id}_provision`))?.data).toEqual({ op: 'provision', tenantId: s.tenant.id, instanceId: i.id });
  });

  it('skips a PENDING instance younger than the threshold', async () => {
    await make();
    expect(await sweepPending({ prisma, queue, olderThanMs: 30_000 })).toBe(0);
    expect(await raw.getJobCountByTypes('waiting')).toBe(0);
  });

  it('skips instances in any other state', async () => {
    await make('ACTIVE');
    await make('FAILED');
    expect(await sweepPending({ prisma, queue, olderThanMs: 30_000, now: later })).toBe(0);
  });

  it('honours the limit, oldest first', async () => {
    for (let n = 0; n < 5; n++) await make();
    expect(await sweepPending({ prisma, queue, olderThanMs: 30_000, now: later, limit: 2 })).toBe(2);
    expect(await raw.getJobCountByTypes('waiting')).toBe(2);
  });
});
