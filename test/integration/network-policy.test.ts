import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { Reconciler } from '../../src/modules/instances/reconciler.js';
import { NetworkPolicyMissingError } from '../../src/shared/errors.js';
import { createLogger } from '../../src/shared/logger.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { TEST_MASTER_KEY, seed, wrapRuntime } from '../helpers/service-env.js';

// Needs Postgres only: the runtime is an in-memory fake, so these tests do not depend on Docker.
const prisma = createPrisma(process.env.DATABASE_URL!);
const logger = createLogger({ level: 'silent' });
let s: Awaited<ReturnType<typeof seed>>;

const service = (rt: FakeRuntime, egressPolicy: 'enforce' | 'off' = 'enforce') =>
  new InstanceService({
    prisma, runtime: rt, image: 'hermes-stub:0.2.0', production: false, logger, pollIntervalMs: 20, healthTimeoutMs: 300,
    masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy,
  });
const reconciler = (rt: FakeRuntime, egressPolicy: 'enforce' | 'off' = 'enforce') =>
  new Reconciler({ prisma, runtime: rt, logger, pollIntervalMs: 20, healthTimeoutMs: 300, masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy });
const provision = (svc: InstanceService) =>
  svc.provision({ tenantId: s.tenant.id, planId: s.plan.id, name: 'a', idempotencyKey: randomUUID() });

describe('network policy wiring', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seed(prisma);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('passes the egress policy on every ensure call', async () => {
    const rt = new FakeRuntime();
    const v = await provision(service(rt));
    rt.vanish(v.id);
    expect(await reconciler(rt).reconcileInstance(v.id)).toBe('recovered');
    expect(rt.ensured).toHaveLength(2);
    for (const spec of rt.ensured) expect(spec.egressPolicy).toBe('enforce');
  });

  it('passes off through when the policy is not enforced', async () => {
    const rt = new FakeRuntime();
    await provision(service(rt, 'off'));
    expect(rt.ensured[0]!.egressPolicy).toBe('off');
  });

  it('provisioning ends FAILED with reason network_policy_missing', async () => {
    const rt = new FakeRuntime();
    rt.networkPolicyMissing = true;
    const v = await provision(service(rt));
    expect(v.status).toBe('FAILED');
    expect(v.statusReason).toBe('network_policy_missing');
    const events = (await prisma.instanceEvent.findMany({ where: { instanceId: v.id } })).map((e) => e.type);
    expect(events).toContain('provisioning.failed');
  });

  it('recovery never starts the container and ends DEGRADED, then exhausted after the bounded attempts', async () => {
    const rt = new FakeRuntime();
    const v = await provision(service(rt));
    rt.vanish(v.id);
    rt.networkPolicyMissing = true;
    const rec = reconciler(rt);
    expect(await rec.reconcileInstance(v.id)).toBe('degraded');
    expect((await rt.inspect(v.id)).state).toBe('absent');
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('DEGRADED');
  });

  it('a user start with a network that lacks the policy name is refused and never starts the container', async () => {
    const rt = new FakeRuntime();
    const svc = service(rt);
    const v = await provision(svc);
    await svc.stop(s.tenant.id, v.id);
    rt.networkPolicyMissing = true;
    await expect(svc.start(s.tenant.id, v.id)).rejects.toBeInstanceOf(NetworkPolicyMissingError);
    expect((await rt.inspect(v.id)).state).not.toBe('running');
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('STOPPED');
    const events = (await prisma.instanceEvent.findMany({ where: { instanceId: v.id } })).map((e) => e.type);
    expect(events).toContain('runtime.start_refused');
  });

  it('a user start still works when the policy is off', async () => {
    const rt = new FakeRuntime();
    const svc = service(rt, 'off');
    const v = await provision(svc);
    await svc.stop(s.tenant.id, v.id);
    rt.networkPolicyMissing = true;
    expect((await svc.start(s.tenant.id, v.id)).status).toBe('ACTIVE');
  });

  it('a user restart with a network that lacks the policy name is refused and changes nothing', async () => {
    const rt = new FakeRuntime();
    const svc = service(rt);
    const v = await provision(svc);
    rt.networkPolicyMissing = true;
    await expect(svc.restart(s.tenant.id, v.id)).rejects.toBeInstanceOf(NetworkPolicyMissingError);
    expect(rt.restarts).toBe(0);
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('ACTIVE');
  });

  it('a reconciler restart with a network that lacks the policy name never restarts the container', async () => {
    const rt = new FakeRuntime();
    const v = await provision(service(rt));
    rt.networkPolicyMissing = true;
    const unhealthy = wrapRuntime(rt, { checkHealth: async () => ({ ok: false, latencyMs: 1, detail: 'HTTP 500' }) });
    const rec = reconciler(unhealthy as FakeRuntime);
    for (let i = 0; i < 3; i += 1) await rec.reconcileInstance(v.id);
    expect(rt.restarts).toBe(0);
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('DEGRADED');
  });
});
