import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { Reconciler } from '../../src/modules/instances/reconciler.js';
import { deriveApiKey } from '../../src/modules/runtime/api-key.js';
import { createLogger } from '../../src/shared/logger.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { TEST_MASTER_KEY, seed } from '../helpers/service-env.js';

// Needs Postgres only: the runtime is an in-memory fake, so these tests do not depend on Docker.
const prisma = createPrisma(process.env.DATABASE_URL!);
const IMAGE = 'hermes-stub:0.2.0';
let s: Awaited<ReturnType<typeof seed>>;
let logs = '';
const logStream = new Writable({ write(c, _e, cb) { logs += c.toString(); cb(); } });
const logger = createLogger({ level: 'debug', stream: logStream });

const service = (rt: FakeRuntime, over: Record<string, unknown> = {}) =>
  new InstanceService({
    prisma, runtime: rt, image: IMAGE, production: false, logger, pollIntervalMs: 20, healthTimeoutMs: 300,
    masterKey: TEST_MASTER_KEY, diskQuota: 'off', containerRuntime: 'runc', ...over,
  });
const reconciler = (rt: FakeRuntime) =>
  new Reconciler({ prisma, runtime: rt, logger, pollIntervalMs: 20, healthTimeoutMs: 300, masterKey: TEST_MASTER_KEY, diskQuota: 'off', containerRuntime: 'runc' });
const provision = (svc: InstanceService) =>
  svc.provision({ tenantId: s.tenant.id, planId: s.plan.id, name: 'a', idempotencyKey: randomUUID() });

describe('API key and runtime wiring', () => {
  beforeEach(async () => {
    logs = '';
    await resetDb(prisma);
    s = await seed(prisma);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('passes a derived API key and the configured runtime to ensure, never in env', async () => {
    const rt = new FakeRuntime();
    const v = await provision(service(rt));
    expect(v.status).toBe('ACTIVE');
    const spec = rt.ensured[0]!;
    expect(spec.apiServerKey).toBe(deriveApiKey(TEST_MASTER_KEY, v.id));
    expect(spec.runtime).toBe('runc');
    expect(JSON.stringify(spec.env)).not.toContain(spec.apiServerKey!);
  });

  it('passes runsc through when configured', async () => {
    const rt = new FakeRuntime();
    await provision(service(rt, { containerRuntime: 'runsc' }));
    expect(rt.ensured[0]!.runtime).toBe('runsc');
  });

  it('probes readiness with the derived key', async () => {
    const rt = new FakeRuntime();
    const v = await provision(service(rt));
    expect(rt.probeKeys.length).toBeGreaterThan(0);
    expect(new Set(rt.probeKeys)).toEqual(new Set([deriveApiKey(TEST_MASTER_KEY, v.id)]));
  });

  it('fails provisioning with health_check_timeout when the gateway rejects the key', async () => {
    const rt = new FakeRuntime();
    rt.rejectKey = true;
    const v = await provision(service(rt));
    expect(v.status).toBe('FAILED');
    expect(v.statusReason).toBe('health_check_timeout');
  });

  it('recreates a vanished container with the same key and probes with it', async () => {
    const rt = new FakeRuntime();
    const v = await provision(service(rt));
    rt.vanish(v.id);
    rt.probeKeys.length = 0;
    expect(await reconciler(rt).reconcileInstance(v.id)).toBe('recovered');
    expect(rt.ensured).toHaveLength(2);
    expect(rt.ensured[1]!.apiServerKey).toBe(rt.ensured[0]!.apiServerKey);
    expect(rt.ensured[1]!.runtime).toBe('runc');
    expect(new Set(rt.probeKeys)).toEqual(new Set([deriveApiKey(TEST_MASTER_KEY, v.id)]));
  });

  it('marks a rejected key as degraded (auth_rejected) at once, and never restarts for it', async () => {
    const rt = new FakeRuntime();
    const v = await provision(service(rt));
    rt.rejectKey = true; // e.g. the control plane came back with a different HERMES_MASTER_KEY
    const rec = reconciler(rt);
    for (let i = 0; i < 4; i += 1) expect(await rec.reconcileInstance(v.id)).toBe('degraded');
    const row = await prisma.instance.findUniqueOrThrow({ where: { id: v.id } });
    expect(row).toMatchObject({ status: 'DEGRADED', statusReason: 'auth_rejected', recoveryAttempts: 0 });
    expect(rt.restarts).toBe(0);
    const events = (await prisma.instanceEvent.findMany({ where: { instanceId: v.id } })).filter((e) => e.type === 'instance.degraded');
    expect(events).toHaveLength(1);
    expect(events[0]!.message).toContain('recreate');
    rt.rejectKey = false;
    expect(await rec.reconcileInstance(v.id)).toBe('recovered');
  });

  it('never exposes the key or the master key in the view, events or logs', async () => {
    const rt = new FakeRuntime();
    const svc = service(rt);
    const v = await provision(svc);
    rt.vanish(v.id);
    await reconciler(rt).reconcileInstance(v.id);
    // Also drive an error path, so something is really logged for the assertions below to inspect.
    rt.rejectKey = true;
    const failed = await provision(svc);
    expect(failed.status).toBe('FAILED');
    expect(logs).not.toBe('');
    const dump = JSON.stringify([
      await svc.get(s.tenant.id, v.id), await svc.events(s.tenant.id, v.id),
      await svc.get(s.tenant.id, failed.id), await svc.events(s.tenant.id, failed.id),
    ]) + logs;
    for (const id of [v.id, failed.id]) expect(dump).not.toContain(deriveApiKey(TEST_MASTER_KEY, id));
    expect(dump).not.toContain(TEST_MASTER_KEY);
  });
});
