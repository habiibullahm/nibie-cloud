import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { Reconciler } from '../../src/modules/instances/reconciler.js';
import type { RuntimeManager } from '../../src/modules/runtime/types.js';
import { RuntimeUnavailableError } from '../../src/shared/errors.js';
import { resetDb } from '../helpers/db.js';
import { execIn } from '../helpers/exec.js';
import { cleanupDocker, docker, realRuntime, seed, silentLogger, wrapRuntime } from '../helpers/service-env.js';
import { ensureStubImage } from '../helpers/stub-image.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
let image: string;
let s: Awaited<ReturnType<typeof seed>>;
let clock = new Date('2026-01-01T00:00:00Z');
const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

const service = (runtime: RuntimeManager = realRuntime()) =>
  new InstanceService({ prisma, runtime, image, production: false, logger: silentLogger, pollIntervalMs: 200, healthTimeoutMs: 15_000 });
const reconciler = (runtime: RuntimeManager = realRuntime()) =>
  new Reconciler({ prisma, runtime, logger: silentLogger, now: () => clock, pollIntervalMs: 200, healthTimeoutMs: 3_000 });

async function provisioned() {
  const v = await service().provision({ tenantId: s.tenant.id, planId: s.plan.id, name: 'a', idempotencyKey: randomUUID() });
  expect(v.status).toBe('ACTIVE');
  return v;
}
const row = (id: string) => prisma.instance.findUniqueOrThrow({ where: { id } });
const eventTypes = async (id: string) => (await prisma.instanceEvent.findMany({ where: { instanceId: id } })).map((e) => e.type);
async function boots(id: string) {
  const r = await realRuntime().inspect(id);
  return ((await (await fetch(`http://127.0.0.1:${r.hostPort}/state`)).json()) as { boots: number }).boots;
}

describe('Reconciler', () => {
  beforeAll(async () => { image = await ensureStubImage(); });
  beforeEach(async () => {
    clock = new Date('2026-01-01T00:00:00Z');
    await cleanupDocker();
    await resetDb(prisma);
    s = await seed(prisma);
  });
  afterAll(async () => { await cleanupDocker(); await prisma.$disconnect(); });

  it('does nothing to a healthy instance', async () => {
    const v = await provisioned();
    expect(await reconciler().reconcileInstance(v.id)).toBe('ok');
    expect((await row(v.id)).status).toBe('ACTIVE');
  });

  it('recovers a killed container with data intact', async () => {
    const v = await provisioned();
    await execIn(docker, v.id, ['sh', '-c', 'echo keep > /data/marker']);
    await docker.getContainer(`hermes-${v.id}`).kill();
    expect(await reconciler().reconcileInstance(v.id)).toBe('recovered');
    const r = await row(v.id);
    expect(r.status).toBe('ACTIVE');
    expect(r.recoveryAttempts).toBe(0);
    expect(await boots(v.id)).toBe(2);
    expect((await execIn(docker, v.id, ['cat', '/data/marker'])).out.trim()).toBe('keep');
    expect(await eventTypes(v.id)).toContain('recovery.succeeded');
  });

  it('recovers when the container is gone but the volume remains', async () => {
    const v = await provisioned();
    await execIn(docker, v.id, ['sh', '-c', 'echo keep > /data/marker']);
    await docker.getContainer(`hermes-${v.id}`).remove({ force: true });
    expect(await reconciler().reconcileInstance(v.id)).toBe('recovered');
    expect((await execIn(docker, v.id, ['cat', '/data/marker'])).out.trim()).toBe('keep');
  });

  it('bounds a crash loop: backoff, then exhausted with one event and no further starts', async () => {
    const v = await provisioned();
    const real = realRuntime();
    let starts = 0;
    const crashing = wrapRuntime(real, {
      start: async (id) => { starts++; await real.start(id); await real.stop(id, 1); },
    });
    const rec = reconciler(crashing);
    await docker.getContainer(`hermes-${v.id}`).kill();

    expect(await rec.reconcileInstance(v.id)).toBe('degraded');
    expect(await rec.reconcileInstance(v.id)).toBe('waiting'); // clock not advanced
    expect(starts).toBe(1);
    advance(120_000);
    expect(await rec.reconcileInstance(v.id)).toBe('degraded');
    advance(120_000);
    expect(await rec.reconcileInstance(v.id)).toBe('exhausted');
    expect(starts).toBe(3);

    const after = await real.inspect(v.id);
    advance(600_000);
    expect(await rec.reconcileInstance(v.id)).toBe('exhausted');
    expect(starts).toBe(3);
    expect((await real.inspect(v.id)).startedAt).toEqual(after.startedAt);

    const r = await row(v.id);
    expect(r.status).toBe('DEGRADED');
    expect(r.statusReason).toBe('recovery_exhausted');
    expect((await eventTypes(v.id)).filter((t) => t === 'recovery.exhausted')).toHaveLength(1);
  });

  it('a manual restart after exhaustion resets the counters', async () => {
    const v = await provisioned();
    await prisma.instance.update({ where: { id: v.id }, data: { status: 'DEGRADED', statusReason: 'recovery_exhausted', recoveryAttempts: 3 } });
    const restarted = await service().restart(s.tenant.id, v.id);
    expect(restarted.status).toBe('ACTIVE');
    const r = await row(v.id);
    expect(r.recoveryAttempts).toBe(0);
    expect(r.statusReason).toBeNull();
  });

  it('reports an out-of-memory exit in the event without leaking anything else', async () => {
    const v = await provisioned();
    const real = realRuntime();
    const oom = wrapRuntime(real, {
      inspect: async (id) => ({ ...(await real.inspect(id)), state: 'exited', exitCode: 137, oomKilled: true, hostPort: null }),
      start: async () => { throw new Error('still failing'); },
    });
    await reconciler(oom).reconcileInstance(v.id);
    const events = await prisma.instanceEvent.findMany({ where: { instanceId: v.id, type: 'recovery.attempted' } });
    expect(events[0]!.message).toContain('out of memory');
  });

  it('marks an unhealthy-but-running instance degraded and only restarts after the threshold', async () => {
    const v = await provisioned();
    const real = realRuntime();
    let restarts = 0;
    const unhealthy = wrapRuntime(real, {
      checkHealth: async () => ({ ok: false, latencyMs: 1, detail: 'HTTP 500' }),
      restart: async (id) => { restarts++; await real.restart(id); },
    });
    const rec = reconciler(unhealthy);
    expect(await rec.reconcileInstance(v.id)).toBe('degraded');
    expect((await row(v.id)).status).toBe('DEGRADED');
    expect(await rec.reconcileInstance(v.id)).toBe('degraded');
    expect(restarts).toBe(0);
    await rec.reconcileInstance(v.id);
    expect(restarts).toBe(1);
  });

  it('returns a degraded instance to ACTIVE when it is healthy again', async () => {
    const v = await provisioned();
    await prisma.instance.update({ where: { id: v.id }, data: { status: 'DEGRADED', consecutiveFailures: 2 } });
    expect(await reconciler().reconcileInstance(v.id)).toBe('recovered');
    const r = await row(v.id);
    expect(r.status).toBe('ACTIVE');
    expect(r.consecutiveFailures).toBe(0);
  });

  it('never restarts a STOPPED instance', async () => {
    const v = await provisioned();
    await service().stop(s.tenant.id, v.id);
    expect(await reconciler().reconcileInstance(v.id)).toBe('ok');
    expect((await realRuntime().inspect(v.id)).state).toBe('exited');
  });

  it('skips and changes nothing when Docker is unavailable', async () => {
    const v = await provisioned();
    const down = wrapRuntime(realRuntime(), { inspect: async () => { throw new RuntimeUnavailableError(); } });
    expect(await reconciler(down).reconcileInstance(v.id)).toBe('skipped');
    const r = await row(v.id);
    expect(r.status).toBe('ACTIVE');
    expect(r.recoveryAttempts).toBe(0);
  });

  it('reconcileAll visits every watched instance and survives one failing', async () => {
    const a = await provisioned();
    const b = await provisioned();
    await docker.getContainer(`hermes-${a.id}`).kill();
    await docker.getContainer(`hermes-${b.id}`).kill();
    await reconciler().reconcileAll();
    expect((await row(a.id)).status).toBe('ACTIVE');
    expect((await row(b.id)).status).toBe('ACTIVE');
  });
});
