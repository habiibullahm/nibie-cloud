import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { createBullQueue, jobIdFor, INSTANCE_QUEUE } from '../../src/modules/jobs/bullmq-queue.js';
import { NotFoundError } from '../../src/shared/errors.js';
import { redisTestUrl, uniquePrefix } from '../helpers/redis.js';

const url = redisTestUrl();
const prefix = uniquePrefix();
const T = '11111111-1111-4111-8111-111111111111';
const I = '22222222-2222-4222-8222-222222222222';
const payload = (op: 'provision' | 'restart' | 'stop' = 'restart') => ({ op, tenantId: T, instanceId: I }) as const;

let q: ReturnType<typeof createBullQueue>;
let raw: Queue;
let rawConn: IORedis;

beforeAll(() => {
  q = createBullQueue({ redisUrl: url, prefix });
  rawConn = new IORedis(url, { maxRetriesPerRequest: null });
  raw = new Queue(INSTANCE_QUEUE, { connection: rawConn, prefix });
});
afterAll(async () => {
  await raw.obliterate({ force: true });
  await raw.close();
  await rawConn.quit();
  await q.close();
});


/** Runs a worker that fails every job permanently, until the given job has failed. */
async function failUntil(jobId: string): Promise<void> {
  const w = new Worker(INSTANCE_QUEUE, async () => { throw new UnrecoverableError('ConflictError'); }, { connection: new IORedis(url, { maxRetriesPerRequest: null }), prefix });
  await new Promise<void>((resolve) => w.on('failed', (job) => { if (job?.id === jobId) resolve(); }));
  await w.close();
}

describe('jobIdFor', () => {
  it('never contains a colon and is stable per instance and op', () => {
    expect(jobIdFor(payload('restart'))).toBe(`${I}_restart`);
    expect(jobIdFor(payload('provision'), 'key-1')).toBe(`${I}_provision_key-1`);
    expect(jobIdFor(payload('stop'), 'a:b')).not.toContain(':');
  });
});

describe('BullMQ job queue', () => {
  it('returns the same job for a double click and keeps one waiting job', async () => {
    const a = await q.enqueue(payload('restart'));
    const b = await q.enqueue(payload('restart'));
    expect(b.jobId).toBe(a.jobId);
    expect(await raw.getJobCountByTypes('waiting')).toBe(1);
  });

  it('gives different jobs to different dedupe keys', async () => {
    const a = await q.enqueue(payload('provision'), { dedupeKey: 'k1' });
    const b = await q.enqueue(payload('provision'), { dedupeKey: 'k2' });
    expect(a.jobId).not.toBe(b.jobId);
  });

  it('stores exactly the ids and nothing else', async () => {
    const { jobId } = await q.enqueue(payload('stop'));
    const job = await raw.getJob(jobId);
    expect(job?.data).toEqual({ op: 'stop', tenantId: T, instanceId: I });
  });

  it('lists a permanently failed job with its class name only, retries it, and lets it be enqueued again', async () => {
    const { jobId } = await q.enqueue({ ...payload('stop'), instanceId: '33333333-3333-4333-8333-333333333333' });
    await failUntil(jobId);

    const failed = await q.listFailed();
    const f = failed.find((j) => j.jobId === jobId);
    expect(f).toMatchObject({ jobId, op: 'stop', instanceId: '33333333-3333-4333-8333-333333333333', attempts: 1, reason: 'ConflictError' });

    await q.retryFailed(jobId);
    expect(await (await raw.getJob(jobId))!.getState()).toBe('waiting');
  });

  it('removes a failed job when the same operation is enqueued again', async () => {
    const p = { ...payload('restart'), instanceId: '44444444-4444-4444-8444-444444444444' };
    const { jobId } = await q.enqueue(p);
    await failUntil(jobId);
    expect(await (await raw.getJob(jobId))!.getState()).toBe('failed');
    await q.enqueue(p);
    expect(await (await raw.getJob(jobId))!.getState()).toBe('waiting');
  });

  it('rejects a retry for an unknown job with NotFoundError', async () => {
    await expect(q.retryFailed('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('BullMQ job queue: repeated use', () => {
  it('does not add an error listener per call (no MaxListenersExceededWarning)', async () => {
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(w.name);
    process.on('warning', onWarning);
    const local = createBullQueue({ redisUrl: url, prefix: uniquePrefix() });
    for (let n = 0; n < 15; n++) await local.enqueue({ ...payload('stop'), instanceId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` });
    await local.listFailed();
    await new Promise((r) => setTimeout(r, 50));
    process.off('warning', onWarning);
    await local.close();
    expect(warnings).not.toContain('MaxListenersExceededWarning');
  });

  it('does not drop a request whose twin job is still active: it gets its own job', async () => {
    const p = { ...payload('restart'), instanceId: '55555555-5555-4555-8555-555555555555' };
    const first = await q.enqueue(p);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const isActive = new Promise<void>((r) => { started = r; });
    const w = new Worker(INSTANCE_QUEUE, async (job) => { if (job.id !== first.jobId) return; started(); await gate; }, { connection: new IORedis(url, { maxRetriesPerRequest: null }), prefix, concurrency: 1 });
    await isActive;
    const second = await q.enqueue(p);
    expect(second.jobId).not.toBe(first.jobId);
    expect(await (await raw.getJob(second.jobId))!.getState()).toBe('waiting');
    release();
    await w.close();
  });
});

describe('BullMQ job queue without Redis', () => {
  it('fails fast with queue_unavailable instead of hanging', async () => {
    const dead = createBullQueue({ redisUrl: 'redis://127.0.0.1:1', prefix });
    const started = Date.now();
    await expect(dead.enqueue(payload('stop'))).rejects.toMatchObject({ status: 503, code: 'queue_unavailable' });
    expect(Date.now() - started).toBeLessThan(5000);
    await dead.close();
  });
});
