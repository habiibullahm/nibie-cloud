import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DockerRuntimeManager } from '../../src/modules/runtime/docker-runtime-manager.js';
import { LABEL_INSTANCE, LABEL_MANAGED, volumeName } from '../../src/modules/runtime/hardening.js';
import type { RuntimeSpec } from '../../src/modules/runtime/types.js';
import { readVolumeQuotaMb, sizedVolumeOpts } from '../../src/modules/runtime/volume-quota.js';
import { VolumeQuotaMissingError } from '../../src/shared/errors.js';

type Vol = { Name: string; Options: Record<string, string> | null };

const notFound = () => Object.assign(new Error('not found'), { statusCode: 404 });

/** Minimal in-memory dockerode: just enough surface for DockerRuntimeManager.ensure(). */
function fakeDocker(opts: { rejectSized?: boolean } = {}) {
  const volumes = new Map<string, Vol>();
  const created: { Name: string; Driver?: string; DriverOpts?: Record<string, string> }[] = [];
  const docker = {
    getVolume: (name: string) => ({
      inspect: async () => {
        const v = volumes.get(name);
        if (!v) throw notFound();
        return v;
      },
    }),
    createVolume: async (o: { Name: string; Driver?: string; DriverOpts?: Record<string, string> }) => {
      if (o.DriverOpts?.size && opts.rejectSized) {
        throw Object.assign(
          new Error(`(HTTP code 400) unexpected - create ${o.Name}: quota size requested but no quota support`),
          { statusCode: 400 },
        );
      }
      created.push(o);
      volumes.set(o.Name, { Name: o.Name, Options: o.DriverOpts ?? null });
      return {};
    },
    getNetwork: () => ({ inspect: async () => ({ Options: {} }) }),
    createNetwork: async () => ({}),
    getContainer: () => ({ inspect: async () => { throw notFound(); } }),
    getImage: () => ({ inspect: async () => ({}) }),
    createContainer: async () => ({}),
  };
  return { docker, volumes, created };
}

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

const spec = (over: Partial<RuntimeSpec> = {}): RuntimeSpec => ({
  instanceId: randomUUID(),
  tenantId: randomUUID(),
  image: `nousresearch/hermes-agent@sha256:${'a'.repeat(64)}`,
  limits: { cpuMillis: 500, memoryMb: 256, pids: 128, storageMb: 512 },
  diskQuota: 'enforce',
  egressPolicy: 'off',
  env: {},
  ...over,
});

const manager = (f: ReturnType<typeof fakeDocker>) =>
  new DockerRuntimeManager({ docker: f.docker as never, logger: silent });

describe('sized tenant volumes', () => {
  it('creates the volume with the sized options when enforce', async () => {
    const f = fakeDocker();
    const s = spec();
    const r = await manager(f).ensure(s);
    expect(f.created).toHaveLength(1);
    expect(f.created[0]).toMatchObject({ Name: volumeName(s.instanceId), Driver: 'local', DriverOpts: sizedVolumeOpts(512) });
    expect(r.volumeQuotaMb).toBe(512);
  });

  it('creates it without size options when off', async () => {
    const f = fakeDocker();
    const r = await manager(f).ensure(spec({ diskQuota: 'off' }));
    expect(f.created[0]?.DriverOpts).toBeUndefined();
    expect(r.volumeQuotaMb).toBeNull();
  });

  it('reports the existing quota in MB through volumeQuotaMb', async () => {
    const f = fakeDocker();
    const s = spec();
    f.volumes.set(volumeName(s.instanceId), { Name: volumeName(s.instanceId), Options: { size: '2g' } });
    const r = await manager(f).ensure(s);
    expect(r.volumeQuotaMb).toBe(2048);
    expect(f.created).toHaveLength(0);
  });

  it('throws VolumeQuotaMissingError for an existing volume without a quota when enforce', async () => {
    const f = fakeDocker();
    const s = spec();
    f.volumes.set(volumeName(s.instanceId), { Name: volumeName(s.instanceId), Options: null });
    await expect(manager(f).ensure(s)).rejects.toBeInstanceOf(VolumeQuotaMissingError);
  });

  it('does not throw for an existing unquotaed volume when off', async () => {
    const f = fakeDocker();
    const s = spec({ diskQuota: 'off' });
    f.volumes.set(volumeName(s.instanceId), { Name: volumeName(s.instanceId), Options: null });
    await expect(manager(f).ensure(s)).resolves.toMatchObject({ volumeQuotaMb: null });
  });

  it('turns a create-time "no quota support" rejection into VolumeQuotaMissingError', async () => {
    const f = fakeDocker({ rejectSized: true });
    await expect(manager(f).ensure(spec())).rejects.toBeInstanceOf(VolumeQuotaMissingError);
  });
});

describe('assertVolumeQuota', () => {
  it('refuses an existing volume without a quota when enforce', async () => {
    const f = fakeDocker();
    const s = spec();
    f.volumes.set(volumeName(s.instanceId), { Name: volumeName(s.instanceId), Options: null });
    await expect(manager(f).assertVolumeQuota(s.instanceId, 'enforce')).rejects.toBeInstanceOf(VolumeQuotaMissingError);
  });

  it('refuses an absent volume when enforce (cannot confirm a quota)', async () => {
    await expect(manager(fakeDocker()).assertVolumeQuota(randomUUID(), 'enforce')).rejects.toBeInstanceOf(VolumeQuotaMissingError);
  });

  it('accepts a volume that has a quota when enforce', async () => {
    const f = fakeDocker();
    const s = spec();
    f.volumes.set(volumeName(s.instanceId), { Name: volumeName(s.instanceId), Options: { size: '512m' } });
    await expect(manager(f).assertVolumeQuota(s.instanceId, 'enforce')).resolves.toBeUndefined();
  });

  it('does nothing when off, whatever the volume looks like', async () => {
    await expect(manager(fakeDocker()).assertVolumeQuota(randomUUID(), 'off')).resolves.toBeUndefined();
  });
});

describe('volumeUsage', () => {
  const labels = (id: string | null, managed = true) => ({
    ...(managed ? { [LABEL_MANAGED]: 'true' } : {}),
    ...(id ? { [LABEL_INSTANCE]: id } : {}),
  });
  const vol = (Name: string, Labels: Record<string, string>, Size?: number) =>
    ({ Name, Labels, UsageData: Size === undefined ? undefined : { Size, RefCount: 1 } });

  function managerWithDf(volumes: unknown, calls: unknown[] = []) {
    const docker = {
      modem: {
        dial: (opts: unknown, cb: (err: Error | null, data?: unknown) => void) => {
          calls.push(opts);
          cb(null, { Volumes: volumes });
        },
      },
    };
    return new DockerRuntimeManager({ docker: docker as never, logger: silent });
  }

  it('keeps only managed volumes with an instance label and a size of 0 or more', async () => {
    const [a, b, c, d, e, f] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const m = managerWithDf([
      vol('v-ok', labels(a), 5_242_880),
      vol('v-zero', labels(b), 0),
      vol('v-negative', labels(c), -1),
      vol('v-nosize', labels(d)),
      vol('v-unmanaged', labels(e, false), 100),
      vol('v-nolabel', labels(null), 100),
      vol('v-upper', labels(f.toUpperCase()), 7),
    ]);
    const usage = await m.volumeUsage();
    expect([...usage.entries()].sort()).toEqual([[a, 5_242_880], [b, 0], [f, 7]].sort());
  });

  it('returns an empty map when Docker reports no volumes (null)', async () => {
    expect((await managerWithDf(null).volumeUsage()).size).toBe(0);
  });

  it('asks Docker for volumes only, with the query in options', async () => {
    const calls: { path: string; options?: unknown }[] = [];
    await managerWithDf([], calls as unknown[]).volumeUsage();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: '/system/df?', method: 'GET', options: { type: 'volume' } });
  });
});

describe('readVolumeQuotaMb', () => {
  it.each([
    [{ size: '64m' }, 64],
    [{ size: '64M' }, 64],
    [{ size: '1g' }, 1024],
    [{ size: '2048k' }, 2],
    [{ size: String(512 * 1024 * 1024) }, 512],
  ])('parses %j as %d MB', (Options, mb) => {
    expect(readVolumeQuotaMb({ Options })).toBe(mb);
  });

  it.each([[null], [undefined], [{}], [{ size: '' }], [{ size: 'abc' }], [{ size: '0' }]])('returns null for %j', (Options) => {
    expect(readVolumeQuotaMb({ Options: Options as never })).toBeNull();
  });
});
