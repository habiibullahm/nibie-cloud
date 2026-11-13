import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { InstanceCommands } from '../../src/modules/instances/instance-commands.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { INSTANCE_QUEUE, createBullQueue } from '../../src/modules/jobs/bullmq-queue.js';
import { createInstanceWorker } from '../../src/modules/jobs/worker.js';
import { RuntimeUnavailableError } from '../../src/shared/errors.js';
import { TEST_ADMIN_TOKEN, testConfig } from '../helpers/auth.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { redisTestUrl, uniquePrefix } from '../helpers/redis.js';
import { TEST_MASTER_KEY, seed, silentLogger, waitFor } from '../helpers/service-env.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const url = redisTestUrl();
const IMAGE = 'hermes-stub:0.2.0';
const admin = { authorization: `Bearer ${TEST_ADMIN_TOKEN}` };

let s: Awaited<ReturnType<typeof seed>>;
let runtime: FakeRuntime;
let service: InstanceService;
let queue: ReturnType<typeof createBullQueue>;
let raw: Queue;
let conn: IORedis;
let worker: { close(): Promise<void> } | undefined;
let prefix: string;

const appWith = (q: ReturnType<typeof createBullQueue> | null) =>
  buildServer({
    service, queue: q, commands: new InstanceCommands({ service, queue: q, logger: silentLogger }),
    logger: silentLogger, config: testConfig(IMAGE, TEST_MASTER_KEY),
  });

describe('operator job routes', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seed(prisma);
    prefix = uniquePrefix();
    runtime = new FakeRuntime();
    service = new InstanceService({
      prisma, runtime, image: IMAGE, production: false, logger: silentLogger, masterKey: TEST_MASTER_KEY,
      diskQuota: 'off', egressPolicy: 'off', pollIntervalMs: 10, healthTimeoutMs: 2000,
    });
    queue = createBullQueue({ redisUrl: url, prefix });
    conn = new IORedis(url, { maxRetriesPerRequest: null });
    raw = new Queue(INSTANCE_QUEUE, { connection: conn, prefix });
  });
  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    await raw.obliterate({ force: true });
    await raw.close();
    await conn.quit();
    await queue.close();
  });
  afterAll(() => prisma.$disconnect());

  it('requires the admin token', async () => {
    const app = appWith(queue);
    expect((await app.inject({ method: 'GET', url: '/api/v1/jobs/failed' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/jobs/failed/x/retry' })).statusCode).toBe(401);
  });

  it('answers 503 queue_unavailable in inline mode', async () => {
    const app = appWith(null);
    const list = await app.inject({ method: 'GET', url: '/api/v1/jobs/failed', headers: admin });
    expect(list.statusCode).toBe(503);
    expect(list.json().error.code).toBe('queue_unavailable');
    expect((await app.inject({ method: 'POST', url: '/api/v1/jobs/failed/x/retry', headers: admin })).statusCode).toBe(503);
  });

  it('lists an exhausted job without message text, and a retry brings the instance up once the runtime is fixed', async () => {
    runtime.ensure = async () => { throw new RuntimeUnavailableError('secret-token-xyz'); };
    worker = createInstanceWorker({ redisUrl: url, prefix, service, logger: silentLogger, backoffMs: () => 20 });
    const app = appWith(queue);
    const created = await app.inject({
      method: 'POST', url: `/api/v1/tenants/${s.tenant.id}/instances`,
      headers: { ...admin, 'idempotency-key': randomUUID() }, payload: { name: 'agent', planId: s.plan.id },
    });
    const { instance, jobId } = created.json() as { instance: { id: string }; jobId: string };

    const body = await waitFor(async () => {
      const r = await app.inject({ method: 'GET', url: '/api/v1/jobs/failed', headers: admin });
      const jobs = (r.json() as { jobs: { jobId: string }[] }).jobs;
      return jobs.some((j) => j.jobId === jobId) ? r.body : undefined;
    });
    expect(JSON.parse(body).jobs[0]).toMatchObject({ jobId, op: 'provision', instanceId: instance.id, attempts: 4, reason: 'RuntimeUnavailableError' });
    expect(body).not.toContain('secret-token-xyz');

    delete (runtime as { ensure?: unknown }).ensure; // back to FakeRuntime.prototype.ensure
    const retry = await app.inject({ method: 'POST', url: `/api/v1/jobs/failed/${jobId}/retry`, headers: admin });
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toEqual({ jobId });
    await waitFor(async () => (await prisma.instance.findUniqueOrThrow({ where: { id: instance.id } })).status === 'ACTIVE');
  });

  it('answers 404 when retrying a job that is not in the failed set', async () => {
    const r = await appWith(queue).inject({ method: 'POST', url: '/api/v1/jobs/failed/nope/retry', headers: admin });
    expect(r.statusCode).toBe(404);
  });
});
