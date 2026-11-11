import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { transition } from '../../src/modules/instances/instance-repo.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { newLease, startHeartbeat } from '../../src/modules/instances/lease.js';
import { Reconciler } from '../../src/modules/instances/reconciler.js';
import type { RuntimeManager } from '../../src/modules/runtime/types.js';
import { ConflictError } from '../../src/shared/errors.js';
import { resetDb } from '../helpers/db.js';
import { cleanupDocker, docker, realRuntime, seed, silentLogger, waitFor, wrapRuntime } from '../helpers/service-env.js';
import { ensureStubImage } from '../helpers/stub-image.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
let image: string;
let s: Awaited<ReturnType<typeof seed>>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const service = (runtime: RuntimeManager = realRuntime(), over: Record<string, unknown> = {}) =>
  new InstanceService({
    prisma, runtime, image, production: false, logger: silentLogger,
    pollIntervalMs: 100, healthTimeoutMs: 20_000, leaseTtlMs: 600, ...over,
  });
const reaper = (runtime: RuntimeManager = realRuntime(), over: Record<string, unknown> = {}) =>
  new Reconciler({
    prisma, runtime, logger: silentLogger, pollIntervalMs: 100, healthTimeoutMs: 3_000,
    leaseTtlMs: 600, staleTransitionMs: 1_000, ...over,
  });
const row = (id: string) => prisma.instance.findUniqueOrThrow({ where: { id } });
const input = (k = randomUUID()) => ({ tenantId: s.tenant.id, planId: s.plan.id, name: 'a', idempotencyKey: k });

/** Run `reapStale` repeatedly until `done` settles; returns how many instances it resolved. */
async function reapWhile(done: Promise<unknown>, r = reaper()): Promise<number> {
  let settled = false;
  void done.finally(() => { settled = true; });
  let total = 0;
  while (!settled) {
    total += await r.reapStale();
    await sleep(150);
  }
  return total;
}

describe('operation leases and the stale reaper', () => {
  beforeAll(async () => { image = await ensureStubImage(); });
  beforeEach(async () => { await cleanupDocker(); await resetDb(prisma); s = await seed(prisma); });
  afterAll(async () => { await cleanupDocker(); await prisma.$disconnect(); });

  it('never reaps a long-running provisioning (heartbeat keeps the lease alive) and clears the lease when done', async () => {
    const real = realRuntime();
    const t0 = Date.now();
    const slow = wrapRuntime(real, {
      checkHealth: async (id) => (Date.now() - t0 < 3_500 ? { ok: false, latencyMs: 1, detail: 'warming up' } : real.checkHealth(id)),
    });
    const p = service(slow).provision(input());
    const seen = await waitFor(async () => (await prisma.instance.findFirst({ where: { status: 'STARTING' } })) ?? undefined, 5_000);
    expect(seen.operationOwner).not.toBeNull();
    const resolved = await reapWhile(p);
    expect(resolved).toBe(0);
    const v = await p;
    expect(v.status).toBe('ACTIVE');
    const done = await row(v.id);
    expect(done.operationOwner).toBeNull();
    expect(done.leaseExpiresAt).toBeNull();
  });

  it('never reaps a slow stop or a slow delete', async () => {
    const real = realRuntime();
    const v = await service().provision(input());
    const slowStop = service(wrapRuntime(real, { stop: async (id, t) => { await sleep(2_500); await real.stop(id, t); } }));
    const stopping = slowStop.stop(s.tenant.id, v.id);
    expect(await reapWhile(stopping)).toBe(0);
    expect((await stopping).status).toBe('STOPPED');

    const slowDelete = service(wrapRuntime(real, { remove: async (id, o) => { await sleep(2_500); await real.remove(id, o); } }));
    const deleting = slowDelete.delete(s.tenant.id, v.id);
    expect(await reapWhile(deleting)).toBe(0);
    expect((await deleting).status).toBe('DELETED');
  });

  it('never reaps an in-flight reconciler recovery', async () => {
    const real = realRuntime();
    const v = await service().provision(input());
    await docker.getContainer(`hermes-${v.id}`).kill();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = wrapRuntime(real, { start: async (id) => { await gate; await real.start(id); } });
    const recovery = reaper(slow, { leaseTtlMs: 400 }).reconcileInstance(v.id);
    await waitFor(async () => (await row(v.id)).status === 'STARTING', 3_000);
    expect((await row(v.id)).operationOwner).not.toBeNull();
    await sleep(1_500); // several lease TTLs
    expect(await reaper().reapStale()).toBe(0);
    release();
    expect(await recovery).toBe('recovered');
    expect((await row(v.id)).operationOwner).toBeNull();
  });

  it('reaps an operation whose lease expired (owner process died), even if the row was updated recently', async () => {
    const v = await service().provision(input());
    await prisma.instance.update({
      where: { id: v.id },
      data: { status: 'PROVISIONING', operationOwner: randomUUID(), leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await reaper().reapStale()).toBe(1);
    const r = await row(v.id);
    expect(r.status).toBe('FAILED');
    expect(r.statusReason).toBe('stalled');
    expect(r.operationOwner).toBeNull();
  });

  it('keeps an old-looking row alone while its lease is still valid', async () => {
    const v = await service().provision(input());
    await prisma.instance.update({
      where: { id: v.id },
      data: { status: 'STARTING', operationOwner: randomUUID(), leaseExpiresAt: new Date(Date.now() + 30_000), updatedAt: new Date(Date.now() - 3_600_000) },
    });
    expect(await reaper().reapStale()).toBe(0);
    expect((await row(v.id)).status).toBe('STARTING');
  });

  it('reaps once a heartbeat stops (simulated crash) but not while it is beating', async () => {
    const v = await service().provision(input());
    const lease = newLease(600);
    await prisma.instance.update({ where: { id: v.id }, data: { status: 'STARTING', operationOwner: lease.owner, leaseExpiresAt: lease.expiresAt } });
    const stop = startHeartbeat({ prisma, instanceId: v.id, owner: lease.owner, ttlMs: 600, maxOperationMs: 60_000, logger: silentLogger });
    await sleep(1_500);
    expect(await reaper().reapStale()).toBe(0);
    stop(); // the "process" dies
    await sleep(900);
    expect(await reaper().reapStale()).toBe(1);
    expect((await row(v.id)).status).toBe('DEGRADED');
    expect((await row(v.id)).statusReason).toBe('stalled');
  });

  it('finishes an abandoned DELETING instance whose lease expired', async () => {
    const v = await service().provision(input());
    await prisma.instance.update({
      where: { id: v.id },
      data: { status: 'DELETING', operationOwner: randomUUID(), leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await reaper().reapStale()).toBe(1);
    expect((await row(v.id)).status).toBe('DELETED');
    expect((await realRuntime().inspect(v.id))).toMatchObject({ state: 'absent', volumePresent: false });
  });

  it('fences the takeover: a lease renewed after the reaper looked cannot be overwritten', async () => {
    const v = await service().provision(input());
    const owner = randomUUID();
    await prisma.instance.update({ where: { id: v.id }, data: { status: 'STARTING', operationOwner: owner, leaseExpiresAt: new Date(Date.now() - 1_000) } });
    const looked = new Date();
    // the live operation renews just after the reaper read the row...
    await prisma.instance.update({ where: { id: v.id }, data: { leaseExpiresAt: new Date(Date.now() + 30_000) } });
    // ...so the reaper's fenced write must lose
    await expect(
      transition(prisma, {
        id: v.id, from: 'STARTING', to: 'DEGRADED', reason: 'stalled', eventType: 'x', message: 'x',
        fence: { leaseExpiresAt: { lt: looked } },
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await row(v.id)).status).toBe('STARTING');
  });

  it('stops renewing after maxOperationMs so a hung operation is eventually reaped, and the zombie cannot overwrite the result', async () => {
    const real = realRuntime();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const hung = wrapRuntime(real, { ensure: async (spec) => { await gate; return real.ensure(spec); } });
    const p = service(hung, { leaseTtlMs: 400, maxOperationMs: 600 }).provision(input());
    const inst = await waitFor(async () => (await prisma.instance.findFirst({ where: { status: 'PROVISIONING' } })) ?? undefined, 3_000);
    await sleep(1_800);
    expect(await reaper().reapStale()).toBe(1);
    expect((await row(inst.id)).status).toBe('FAILED');
    release();
    const v = await p;
    expect(v.status).toBe('FAILED');
    expect(v.statusReason).toBe('stalled');
    expect((await realRuntime().inspect(inst.id)).state).not.toBe('running');
  });
});
