import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { Reconciler } from '../../src/modules/instances/reconciler.js';
import { VolumeQuotaMissingError } from '../../src/shared/errors.js';
import { createLogger } from '../../src/shared/logger.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { TEST_MASTER_KEY, TEST_PLAN, seed, wrapRuntime } from '../helpers/service-env.js';

// Needs Postgres only: the runtime is an in-memory fake, so these tests do not depend on Docker.
const prisma = createPrisma(process.env.DATABASE_URL!);
const logger = createLogger({ level: 'silent' });
let s: Awaited<ReturnType<typeof seed>>;

const service = (rt: FakeRuntime, diskQuota: 'enforce' | 'off' = 'enforce') =>
  new InstanceService({
    prisma, runtime: rt, image: 'hermes-stub:0.2.0', production: false, logger, pollIntervalMs: 20, healthTimeoutMs: 300,
    masterKey: TEST_MASTER_KEY, diskQuota, egressPolicy: 'off',
  });
const reconciler = (rt: FakeRuntime, diskQuota: 'enforce' | 'off' = 'enforce') =>
  new Reconciler({ prisma, runtime: rt, logger, pollIntervalMs: 20, healthTimeoutMs: 300, masterKey: TEST_MASTER_KEY, diskQuota, egressPolicy: 'off' });
const provision = (svc: InstanceService) =>
  svc.provision({ tenantId: s.tenant.id, planId: s.plan.id, name: 'a', idempotencyKey: randomUUID() });
const eventTypes = async (id: string) => (await prisma.instanceEvent.findMany({ where: { instanceId: id } })).map((e) => e.type);

describe('disk quota wiring', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seed(prisma);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it("passes the plan's storageMb and the quota mode on every ensure call", async () => {
    const rt = new FakeRuntime();
    rt.volumeQuotaMb = TEST_PLAN.storageMb;
    const v = await provision(service(rt));
    rt.vanish(v.id);
    expect(await reconciler(rt).reconcileInstance(v.id)).toBe('recovered');
    expect(rt.ensured).toHaveLength(2);
    for (const spec of rt.ensured) {
      expect(spec.limits.storageMb).toBe(TEST_PLAN.storageMb);
      expect(spec.diskQuota).toBe('enforce');
    }
  });

  it('passes off through when quotas are not enforced', async () => {
    const rt = new FakeRuntime();
    await provision(service(rt, 'off'));
    expect(rt.ensured[0]!.diskQuota).toBe('off');
  });

  it('provisioning with a missing quota ends FAILED with reason volume_quota_missing', async () => {
    const rt = new FakeRuntime();
    rt.quotaMissing = true;
    const v = await provision(service(rt));
    expect(v.status).toBe('FAILED');
    expect(v.statusReason).toBe('volume_quota_missing');
    expect(await eventTypes(v.id)).toContain('provisioning.failed');
  });

  it('recovery with a missing quota never starts the container and ends DEGRADED', async () => {
    const rt = new FakeRuntime();
    rt.volumeQuotaMb = TEST_PLAN.storageMb;
    const v = await provision(service(rt));
    rt.vanish(v.id);
    rt.quotaMissing = true;
    expect(await reconciler(rt).reconcileInstance(v.id)).toBe('degraded');
    expect((await rt.inspect(v.id)).state).toBe('absent');
    const row = await prisma.instance.findUniqueOrThrow({ where: { id: v.id } });
    expect(row.status).toBe('DEGRADED');
  });

  it('a quota different from the plan records one disk.quota_mismatch event and keeps the instance ACTIVE', async () => {
    const rt = new FakeRuntime();
    rt.volumeQuotaMb = TEST_PLAN.storageMb / 2;
    const v = await provision(service(rt));
    expect(v.status).toBe('ACTIVE');
    expect((await eventTypes(v.id)).filter((t) => t === 'disk.quota_mismatch')).toHaveLength(1);
  });

  it('a matching quota records no event', async () => {
    const rt = new FakeRuntime();
    rt.volumeQuotaMb = TEST_PLAN.storageMb;
    const v = await provision(service(rt));
    expect(await eventTypes(v.id)).not.toContain('disk.quota_mismatch');
  });

  it('no quota (off) records no mismatch event', async () => {
    const rt = new FakeRuntime();
    const v = await provision(service(rt, 'off'));
    expect(await eventTypes(v.id)).not.toContain('disk.quota_mismatch');
  });

  it('a user start with a missing quota is refused and never starts the container', async () => {
    const rt = new FakeRuntime();
    rt.volumeQuotaMb = TEST_PLAN.storageMb;
    const svc = service(rt);
    const v = await provision(svc);
    await svc.stop(s.tenant.id, v.id);
    rt.quotaMissing = true;
    await expect(svc.start(s.tenant.id, v.id)).rejects.toBeInstanceOf(VolumeQuotaMissingError);
    expect((await rt.inspect(v.id)).state).not.toBe('running');
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('STOPPED');
    expect(await eventTypes(v.id)).toContain('runtime.start_refused');
  });

  it('a user start still works without a quota when quotas are off', async () => {
    const rt = new FakeRuntime();
    const svc = service(rt, 'off');
    const v = await provision(svc);
    await svc.stop(s.tenant.id, v.id);
    rt.quotaMissing = true;
    expect((await svc.start(s.tenant.id, v.id)).status).toBe('ACTIVE');
  });

  it('a user restart with a missing quota is refused and leaves the instance as it was', async () => {
    const rt = new FakeRuntime();
    rt.volumeQuotaMb = TEST_PLAN.storageMb;
    const svc = service(rt);
    const v = await provision(svc);
    rt.quotaMissing = true;
    await expect(svc.restart(s.tenant.id, v.id)).rejects.toBeInstanceOf(VolumeQuotaMissingError);
    expect(rt.restarts).toBe(0);
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('ACTIVE');
  });

  it('a reconciler restart with a missing quota never restarts the container', async () => {
    const rt = new FakeRuntime();
    rt.volumeQuotaMb = TEST_PLAN.storageMb;
    const v = await provision(service(rt));
    rt.quotaMissing = true;
    const unhealthy = wrapRuntime(rt, { checkHealth: async () => ({ ok: false, latencyMs: 1, detail: 'HTTP 500' }) });
    const rec = reconciler(unhealthy as FakeRuntime);
    for (let i = 0; i < 3; i += 1) await rec.reconcileInstance(v.id);
    expect(rt.restarts).toBe(0);
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('DEGRADED');
  });
});
