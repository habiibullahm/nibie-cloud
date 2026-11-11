import { randomUUID } from 'node:crypto';
import type { Instance } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import type { RuntimeManager } from '../../src/modules/runtime/types.js';
import { ConflictError, NotFoundError, RuntimeUnavailableError, ValidationError } from '../../src/shared/errors.js';
import { resetDb } from '../helpers/db.js';
import {
  cleanupDocker, containersFor, docker, key, realRuntime, seed, silentLogger, waitFor, wrapRuntime,
} from '../helpers/service-env.js';
import { ensureStubImage } from '../helpers/stub-image.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
let image: string;
let s: Awaited<ReturnType<typeof seed>>;

const svc = (runtime: RuntimeManager = realRuntime(), over: Record<string, unknown> = {}) =>
  new InstanceService({
    prisma, runtime, image, production: false, logger: silentLogger,
    pollIntervalMs: 200, healthTimeoutMs: 15_000, ...over,
  });

const provision = (service: InstanceService, k = key(), name = 'my agent') =>
  service.provision({ tenantId: s.tenant.id, planId: s.plan.id, name, idempotencyKey: k });

describe('InstanceService', () => {
  beforeAll(async () => {
    image = await ensureStubImage();
  });
  beforeEach(async () => {
    await cleanupDocker();
    await resetDb(prisma);
    s = await seed(prisma);
  });
  afterAll(async () => {
    await cleanupDocker();
    await prisma.$disconnect();
  });

  it('rejects an unpinned image at construction', () => {
    expect(() => svc(realRuntime(), { image: 'hermes:latest' })).toThrow(ValidationError);
  });

  it('provisions an instance to ACTIVE with a persisted container', async () => {
    const service = svc();
    const v = await provision(service);
    expect(v.status).toBe('ACTIVE');
    expect(v.accessUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await containersFor(v.id))).toHaveLength(1);
    const types = (await service.events(s.tenant.id, v.id)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['provisioning.started', 'instance.active']));
    const res = await fetch(`${v.accessUrl}/healthz`);
    expect(res.status).toBe(200);
  });

  it('returns the same instance for a repeated idempotency key', async () => {
    const service = svc();
    const k = key();
    const a = await provision(service, k);
    const b = await provision(service, k);
    expect(b.id).toBe(a.id);
    expect(await prisma.instance.count()).toBe(1);
  });

  it('creates exactly one instance, container and volume for 5 parallel calls with one key', async () => {
    const service = svc();
    const k = key();
    const views = await Promise.all(Array.from({ length: 5 }, () => provision(service, k)));
    expect(new Set(views.map((v) => v.id)).size).toBe(1);
    const id = views[0]!.id;
    await waitFor(async () => (await service.get(s.tenant.id, id)).status === 'ACTIVE');
    expect(await prisma.instance.count()).toBe(1);
    expect(await containersFor(id)).toHaveLength(1);
    const vols = await docker.listVolumes({ filters: { name: [`hermes-data-${id}`] } });
    expect(vols.Volumes).toHaveLength(1);
  });

  it('marks FAILED on a partial provisioning failure and a retry succeeds without duplicates', async () => {
    const real = realRuntime();
    let calls = 0;
    const flaky = wrapRuntime(real, {
      ensure: async (spec) => {
        await real.ensure(spec);
        if (calls++ === 0) throw new Error('boom with secret=hunter2');
        return { hostPort: null };
      },
    });
    const service = svc(flaky);
    const k = key();
    const failed = await provision(service, k);
    expect(failed.status).toBe('FAILED');
    expect(failed.statusReason).toBe('runtime_create_failed');
    const events = await service.events(s.tenant.id, failed.id);
    expect(JSON.stringify(events)).not.toContain('hunter2');

    const retried = await provision(service, k);
    expect(retried.id).toBe(failed.id);
    expect(retried.status).toBe('ACTIVE');
    expect(await containersFor(failed.id)).toHaveLength(1);
    const vols = await docker.listVolumes({ filters: { name: [`hermes-data-${failed.id}`] } });
    expect(vols.Volumes).toHaveLength(1);
  });

  it('stop, start and restart move through STOPPED and ACTIVE', async () => {
    const service = svc();
    const v = await provision(service);
    expect((await service.stop(s.tenant.id, v.id)).status).toBe('STOPPED');
    expect((await service.start(s.tenant.id, v.id)).status).toBe('ACTIVE');
    const restarted = await service.restart(s.tenant.id, v.id);
    expect(restarted.status).toBe('ACTIVE');
    expect(restarted.accessUrl).not.toBeNull();
    expect((await fetch(`${restarted.accessUrl}/healthz`)).status).toBe(200);
  });

  it('lets exactly one of two concurrent restart/stop calls win; the other gets ConflictError', async () => {
    const service = svc();
    const v = await provision(service);
    const results = await Promise.allSettled([
      service.restart(s.tenant.id, v.id),
      service.stop(s.tenant.id, v.id),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.reason).toBeInstanceOf(ConflictError);
  });

  it('rejects restart and start with ConflictError while a stop is still in flight', async () => {
    const real = realRuntime();
    const slowStop = svc(wrapRuntime(real, {
      stop: async (id, t) => { await new Promise((r) => setTimeout(r, 800)); await real.stop(id, t); },
    }));
    const v = await provision(slowStop);
    const stopping = slowStop.stop(s.tenant.id, v.id);
    await new Promise((r) => setTimeout(r, 200));
    expect((await slowStop.get(s.tenant.id, v.id)).status).toBe('STOPPING');
    await expect(slowStop.restart(s.tenant.id, v.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(slowStop.start(s.tenant.id, v.id)).rejects.toBeInstanceOf(ConflictError);
    expect((await stopping).status).toBe('STOPPED');
    expect((await realRuntime().inspect(v.id)).state).toBe('exited');
  });

  it('treats repeated stop and delete as no-ops', async () => {
    const service = svc();
    const v = await provision(service);
    await service.stop(s.tenant.id, v.id);
    await expect(service.stop(s.tenant.id, v.id)).resolves.toMatchObject({ status: 'STOPPED' });
    await service.delete(s.tenant.id, v.id);
    await expect(service.delete(s.tenant.id, v.id)).resolves.toMatchObject({ status: 'DELETED' });
  });

  it('delete removes container, network and volume and sets deletedAt', async () => {
    const service = svc();
    const v = await provision(service);
    const d = await service.delete(s.tenant.id, v.id);
    expect(d.status).toBe('DELETED');
    expect(await containersFor(v.id)).toHaveLength(0);
    expect((await docker.listVolumes({ filters: { name: [`hermes-data-${v.id}`] } })).Volumes ?? []).toHaveLength(0);
    expect((await docker.listNetworks({ filters: { name: [`hermes-net-${v.id}`] } }))).toHaveLength(0);
    const row = (await prisma.instance.findUnique({ where: { id: v.id } })) as Instance;
    expect(row.deletedAt).not.toBeNull();
  });

  it('answers NotFoundError for every method when the tenant does not own the instance', async () => {
    const service = svc();
    const v = await provision(service);
    const t = s.other.id;
    await expect(service.get(t, v.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.start(t, v.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.stop(t, v.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.restart(t, v.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.delete(t, v.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.events(t, v.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await service.list(t)).toHaveLength(0);
    await expect(service.get(s.tenant.id, 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.get(s.tenant.id, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  it('leaves state unchanged and rethrows when Docker is unavailable during start', async () => {
    const service = svc();
    const v = await provision(service);
    await service.stop(s.tenant.id, v.id);
    const down = svc(wrapRuntime(realRuntime(), {
      start: async () => { throw new RuntimeUnavailableError(); },
    }));
    await expect(down.start(s.tenant.id, v.id)).rejects.toBeInstanceOf(RuntimeUnavailableError);
    expect((await service.get(s.tenant.id, v.id)).status).toBe('STOPPED');
  });

  it('does not delete or fail an active instance when Docker is unavailable during delete/restart', async () => {
    const service = svc();
    const v = await provision(service);
    const down = svc(wrapRuntime(realRuntime(), {
      restart: async () => { throw new RuntimeUnavailableError(); },
      remove: async () => { throw new RuntimeUnavailableError(); },
    }));
    await expect(down.restart(s.tenant.id, v.id)).rejects.toBeInstanceOf(RuntimeUnavailableError);
    expect((await service.get(s.tenant.id, v.id)).status).toBe('ACTIVE');
    await expect(down.delete(s.tenant.id, v.id)).rejects.toBeInstanceOf(RuntimeUnavailableError);
    expect((await service.get(s.tenant.id, v.id)).status).toBe('ACTIVE');
  });

  it('marks provisioning FAILED (runtime_unavailable) when Docker is down, and surfaces 503', async () => {
    const down = svc(wrapRuntime(realRuntime(), {
      ensure: async () => { throw new RuntimeUnavailableError(); },
    }));
    const k = key();
    await expect(provision(down, k)).rejects.toBeInstanceOf(RuntimeUnavailableError);
    const row = await prisma.instance.findFirstOrThrow({ where: { idempotencyKey: k } });
    expect(row.status).toBe('FAILED');
    expect(row.statusReason).toBe('runtime_unavailable');
    const retried = await provision(svc(), k);
    expect(retried.status).toBe('ACTIVE');
  });

  it.each(['', 'x'.repeat(64), 'bad\u0000name', 'line\nbreak'])('rejects invalid name %j', async (name) => {
    await expect(provision(svc(), key(), name)).rejects.toBeInstanceOf(ValidationError);
  });

  it('stores hostile names but never uses them in Docker names or labels', async () => {
    const service = svc();
    const name = '"; rm -rf /` $(id) 日本語';
    const v = await provision(service, key(), name);
    expect(v.name).toBe(name);
    const [c] = await containersFor(v.id);
    expect(JSON.stringify(c)).not.toContain('rm -rf');
    expect(c!.Names[0]).toBe(`/hermes-${v.id}`);
  });
});
