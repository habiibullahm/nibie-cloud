import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { IdentityService } from '../../src/modules/auth/identity-service.js';
import { InstanceCommands } from '../../src/modules/instances/instance-commands.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import type { FailedJob, InstanceOpPayload, JobQueue } from '../../src/modules/jobs/types.js';
import { ConflictError, NotFoundError, QueueUnavailableError } from '../../src/shared/errors.js';
import { TEST_ADMIN_TOKEN, createTestAuth, testConfig } from '../helpers/auth.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { TEST_MASTER_KEY, seed, silentLogger } from '../helpers/service-env.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const IMAGE = 'hermes-stub:0.2.0';

/** In-memory JobQueue: records what was enqueued, can be switched off like an unreachable Redis. */
class StubQueue implements JobQueue {
  readonly jobs: InstanceOpPayload[] = [];
  down = false;
  async enqueue(p: InstanceOpPayload) {
    if (this.down) throw new QueueUnavailableError();
    this.jobs.push(p);
    return { jobId: `${p.instanceId}_${p.op}` };
  }
  async listFailed(): Promise<FailedJob[]> { return []; }
  async retryFailed(): Promise<void> {}
  async close(): Promise<void> {}
}

let s: Awaited<ReturnType<typeof seed>>;
let runtime: FakeRuntime;
let service: InstanceService;
let queue: StubQueue;

const provisionInput = (tenantId = s.tenant.id, key = randomUUID()) => ({ tenantId, name: 'agent', planId: s.plan.id, idempotencyKey: key });
const status = async (id: string) => (await prisma.instance.findUniqueOrThrow({ where: { id } })).status;

describe('InstanceCommands', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seed(prisma);
    runtime = new FakeRuntime();
    queue = new StubQueue();
    service = new InstanceService({
      prisma, runtime, image: IMAGE, production: false, logger: silentLogger, masterKey: TEST_MASTER_KEY,
      diskQuota: 'off', egressPolicy: 'off', pollIntervalMs: 10, healthTimeoutMs: 2000,
    });
  });
  afterAll(() => prisma.$disconnect());

  const inline = () => new InstanceCommands({ service, queue: null, logger: silentLogger });
  const queued = () => new InstanceCommands({ service, queue, logger: silentLogger });

  async function activeInstance() {
    const { instance } = await inline().provision(provisionInput());
    return instance.id;
  }

  describe('inline mode (no queue)', () => {
    it('runs the whole operation in the request and returns jobId null', async () => {
      const r = await inline().provision(provisionInput());
      expect(r.instance.status).toBe('ACTIVE');
      expect(r.jobId).toBeNull();
      const stopped = await inline().stop(s.tenant.id, r.instance.id);
      expect(stopped.instance.status).toBe('STOPPED');
      expect(stopped.jobId).toBeNull();
    });
  });

  describe('queue mode', () => {
    it('provision creates the PENDING row, enqueues ids only and does not touch the runtime', async () => {
      const r = await queued().provision(provisionInput());
      expect(r.instance.status).toBe('PENDING');
      expect(r.jobId).toBe(`${r.instance.id}_provision`);
      expect(queue.jobs).toEqual([{ op: 'provision', tenantId: s.tenant.id, instanceId: r.instance.id }]);
      expect(runtime.ensured).toEqual([]);
    });

    it('replaying a provision key returns the same instance and does not create a second row', async () => {
      const input = provisionInput();
      const a = await queued().provision(input);
      const b = await queued().provision(input);
      expect(b.instance.id).toBe(a.instance.id);
      expect(await prisma.instance.count()).toBe(1);
    });

    it('provision still answers PENDING with jobId null when Redis is down (the sweeper delivers it)', async () => {
      queue.down = true;
      const r = await queued().provision(provisionInput());
      expect(r.instance.status).toBe('PENDING');
      expect(r.jobId).toBeNull();
      expect(await prisma.instance.count()).toBe(1);
    });

    it('stop on an ACTIVE instance enqueues and leaves the state and runtime untouched', async () => {
      const id = await activeInstance();
      const r = await queued().stop(s.tenant.id, id);
      expect(r.instance.status).toBe('ACTIVE');
      expect(r.jobId).toBe(`${id}_stop`);
      expect(await status(id)).toBe('ACTIVE');
    });

    it('stop, start, restart and delete answer 503 queue_unavailable and change nothing when Redis is down', async () => {
      const id = await activeInstance();
      queue.down = true;
      await expect(queued().stop(s.tenant.id, id)).rejects.toBeInstanceOf(QueueUnavailableError);
      await expect(queued().restart(s.tenant.id, id)).rejects.toBeInstanceOf(QueueUnavailableError);
      await expect(queued().delete(s.tenant.id, id)).rejects.toBeInstanceOf(QueueUnavailableError);
      expect(await status(id)).toBe('ACTIVE');
    });

    it('rejects an impossible transition with 409 before enqueueing', async () => {
      const id = await activeInstance();
      await prisma.instance.update({ where: { id }, data: { status: 'STOPPING' } });
      await expect(queued().restart(s.tenant.id, id)).rejects.toBeInstanceOf(ConflictError);
      expect(queue.jobs).toEqual([]);
    });

    it('treats stop on a STOPPED instance as already done: no job', async () => {
      const id = await activeInstance();
      await inline().stop(s.tenant.id, id);
      const r = await queued().stop(s.tenant.id, id);
      expect(r.instance.status).toBe('STOPPED');
      expect(r.jobId).toBeNull();
      expect(queue.jobs).toEqual([]);
    });

    it('answers 404 for another tenant\'s instance and enqueues nothing', async () => {
      const id = await activeInstance();
      await expect(queued().stop(s.other.id, id)).rejects.toBeInstanceOf(NotFoundError);
      expect(queue.jobs).toEqual([]);
    });
  });

  describe('HTTP contract', () => {
    it('adds jobId to the 202 bodies of the customer and operator APIs', async () => {
      const auth = await createTestAuth();
      const commands = queued();
      const app = buildServer({
        service, commands, logger: silentLogger,
        config: testConfig(IMAGE, TEST_MASTER_KEY, { betaAllowedEmails: ['a@example.test'] }),
        customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
      });
      const headers = { authorization: `Bearer ${await auth.signToken({ sub: randomUUID(), email: 'a@example.test' })}` };
      const created = await app.inject({ method: 'POST', url: '/api/v1/instances', headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { name: 'agent', planId: s.plan.id } });
      expect(created.statusCode).toBe(202);
      const body = created.json() as { instance: { id: string; status: string }; jobId: string };
      expect(body.instance.status).toBe('PENDING');
      expect(body.jobId).toBe(`${body.instance.id}_provision`);

      const op = await app.inject({
        method: 'POST', url: `/api/v1/tenants/${s.tenant.id}/instances`,
        headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}`, 'idempotency-key': randomUUID() }, payload: { name: 'op', planId: s.plan.id },
      });
      expect(op.statusCode).toBe(202);
      expect((op.json() as { jobId: string }).jobId).toMatch(/_provision$/);
    });
  });
});
