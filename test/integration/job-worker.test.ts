import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { createPrisma } from '../../src/db/client.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { INSTANCE_QUEUE, createBullQueue } from '../../src/modules/jobs/bullmq-queue.js';
import { classify, createInstanceWorker } from '../../src/modules/jobs/worker.js';
import { ConflictError, NotFoundError, RuntimeUnavailableError, ValidationError } from '../../src/shared/errors.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { redisTestUrl, uniquePrefix } from '../helpers/redis.js';
import { TEST_MASTER_KEY, seed, silentLogger, waitFor } from '../helpers/service-env.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const url = redisTestUrl();
const IMAGE = 'hermes-stub:0.2.0';

let prefix: string;
let queue: ReturnType<typeof createBullQueue>;
let raw: Queue;
let rawConn: IORedis;
let worker: { close(): Promise<void> } | undefined;
let runtime: FakeRuntime;
let s: Awaited<ReturnType<typeof seed>>;

function startWorker(extra: { stalledInterval?: number; lockDuration?: number } = {}) {
  const service = new InstanceService({
    prisma, runtime, image: IMAGE, production: false, logger: silentLogger, masterKey: TEST_MASTER_KEY,
    diskQuota: 'off', egressPolicy: 'off', pollIntervalMs: 10, healthTimeoutMs: 2000,
  });
  worker = createInstanceWorker({ redisUrl: url, prefix, service, logger: silentLogger, backoffMs: () => 20, ...extra });
}

async function pending(status: 'PENDING' | 'ACTIVE' | 'STOPPED' | 'PROVISIONING' | 'DELETED' = 'PENDING') {
  return prisma.instance.create({
    data: { tenantId: s.tenant.id, planId: s.plan.id, nodeId: s.node.id, name: 'x', idempotencyKey: crypto.randomUUID(), image: IMAGE, status },
  });
}
const payload = (op: 'provision' | 'start' | 'stop' | 'restart' | 'delete', instanceId: string) => ({ op, tenantId: s.tenant.id, instanceId });
const statusOf = async (id: string) => (await prisma.instance.findUniqueOrThrow({ where: { id } })).status;
const failedOf = async (jobId: string) => (await queue.listFailed()).find((j) => j.jobId === jobId);

describe('classify', () => {
  it('treats state, lookup and validation errors as permanent and everything else as retryable', () => {
    expect(classify(new ConflictError('x'))).toBe('permanent');
    expect(classify(new NotFoundError())).toBe('permanent');
    expect(classify(new ValidationError('x'))).toBe('permanent');
    expect(classify(new RuntimeUnavailableError())).toBe('retry');
    expect(classify(new Error('boom'))).toBe('retry');
  });
});

describe('instance worker', () => {
  beforeAll(() => {
    rawConn = new IORedis(url, { maxRetriesPerRequest: null });
  });
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seed(prisma);
    prefix = uniquePrefix();
    runtime = new FakeRuntime();
    queue = createBullQueue({ redisUrl: url, prefix });
    raw = new Queue(INSTANCE_QUEUE, { connection: rawConn, prefix });
  });
  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    await raw.obliterate({ force: true });
    await raw.close();
    await queue.close();
  });
  afterAll(async () => {
    await rawConn.quit();
    await prisma.$disconnect();
  });

  it('takes a PENDING instance to ACTIVE with a provision job', async () => {
    const i = await pending();
    startWorker();
    await queue.enqueue(payload('provision', i.id));
    await waitFor(async () => (await statusOf(i.id)) === 'ACTIVE');
  });

  it('stops and starts an instance with jobs', async () => {
    const i = await pending();
    startWorker();
    await queue.enqueue(payload('provision', i.id));
    await waitFor(async () => (await statusOf(i.id)) === 'ACTIVE');
    await queue.enqueue(payload('stop', i.id));
    await waitFor(async () => (await statusOf(i.id)) === 'STOPPED');
    await queue.enqueue(payload('start', i.id));
    await waitFor(async () => (await statusOf(i.id)) === 'ACTIVE');
  });

  it('treats a second stop for an already stopped instance as a no-op (one stopped event)', async () => {
    const i = await pending();
    startWorker();
    await queue.enqueue(payload('provision', i.id));
    await waitFor(async () => (await statusOf(i.id)) === 'ACTIVE');
    await queue.enqueue(payload('stop', i.id));
    await waitFor(async () => (await statusOf(i.id)) === 'STOPPED');
    await waitFor(async () => (await raw.getJobCountByTypes('active', 'waiting')) === 0);
    await queue.enqueue(payload('stop', i.id));
    await waitFor(async () => (await raw.getJobCountByTypes('active', 'waiting')) === 0);
    expect(await statusOf(i.id)).toBe('STOPPED');
    expect(await prisma.instanceEvent.count({ where: { instanceId: i.id, type: 'instance.stopped' } })).toBe(1);
    expect(await queue.listFailed()).toEqual([]);
  });

  it('does not retry a restart for an instance in a transitional state (permanent, one attempt)', async () => {
    const i = await pending('PROVISIONING');
    startWorker();
    const { jobId } = await queue.enqueue(payload('restart', i.id));
    const f = await waitFor(() => failedOf(jobId));
    expect(f).toMatchObject({ op: 'restart', attempts: 1, reason: 'ConflictError' });
  });

  it('retries a transient runtime failure and then succeeds', async () => {
    const i = await pending();
    startWorker();
    await queue.enqueue(payload('provision', i.id));
    await waitFor(async () => (await statusOf(i.id)) === 'ACTIVE');
    let failures = 0;
    runtime.stop = async () => {
      if (failures++ < 2) throw new RuntimeUnavailableError();
    };
    await queue.enqueue(payload('stop', i.id));
    await waitFor(async () => (await statusOf(i.id)) === 'STOPPED');
    expect(failures).toBe(3);
    expect(await queue.listFailed()).toEqual([]);
  });

  it('gives up after four attempts and records only the error class, never its message', async () => {
    const i = await pending();
    runtime.ensure = async () => {
      throw new RuntimeUnavailableError('secret-token-xyz in message');
    };
    startWorker();
    const { jobId } = await queue.enqueue(payload('provision', i.id));
    const f = await waitFor(() => failedOf(jobId));
    expect(f).toMatchObject({ attempts: 4, reason: 'RuntimeUnavailableError' });
    expect(JSON.stringify(f)).not.toContain('secret-token-xyz');
    // What Redis itself holds, not just the sanitised listing.
    const stored = await raw.getJob(jobId);
    expect(JSON.stringify({ reason: stored?.failedReason, stack: stored?.stacktrace, data: stored?.data })).not.toContain('secret-token-xyz');
    expect(await statusOf(i.id)).toBe('FAILED');
  });

  it('fails an unknown operation permanently', async () => {
    startWorker();
    await raw.add('bogus', { op: 'bogus', tenantId: s.tenant.id, instanceId: crypto.randomUUID() }, { jobId: 'bogus-1' });
    const f = await waitFor(() => failedOf('bogus-1'));
    expect(f).toMatchObject({ attempts: 1, reason: 'ValidationError' });
  });

  it('completes a delete job for an instance that is already deleted', async () => {
    const i = await pending('DELETED');
    startWorker();
    await queue.enqueue(payload('delete', i.id));
    await waitFor(async () => (await raw.getJobCountByTypes('active', 'waiting')) === 0);
    expect(await queue.listFailed()).toEqual([]);
    expect(await statusOf(i.id)).toBe('DELETED');
  });

  it('does not run a restart twice when its job stalls: it fails as JobStalled instead of being redelivered', async () => {
    const i = await pending();
    startWorker({ stalledInterval: 200, lockDuration: 1000 });
    await queue.enqueue(payload('provision', i.id));
    await waitFor(async () => (await statusOf(i.id)) === 'ACTIVE');

    let restarts = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    runtime.restart = async () => { restarts++; await gate; };
    const { jobId } = await queue.enqueue(payload('restart', i.id));
    await waitFor(async () => restarts === 1);
    await rawConn.del(`${prefix}:${INSTANCE_QUEUE}:${jobId}:lock`); // the worker "lost" its lock, as after a long Redis blip

    const f = await waitFor(() => failedOf(jobId), 10_000);
    expect(f.reason).toBe('JobStalled');
    release();
    await new Promise((r) => setTimeout(r, 300));
    expect(restarts).toBe(1);
  });
});
