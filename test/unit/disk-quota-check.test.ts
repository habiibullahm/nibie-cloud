import { describe, expect, it, vi } from 'vitest';
import { assertDiskQuotaSupported } from '../../src/modules/runtime/disk-quota-check.js';

function fakeDocker(over: { create?: () => Promise<unknown>; inspect?: () => Promise<{ Options?: Record<string, string> | null }> } = {}) {
  const removed: string[] = [];
  let created: { Name: string; Driver?: string; DriverOpts?: Record<string, string> } | undefined;
  const docker = {
    createVolume: vi.fn(async (o: { Name: string; Driver?: string; DriverOpts?: Record<string, string> }) => {
      created = o;
      return over.create ? over.create() : {};
    }),
    getVolume: (name: string) => ({
      inspect: over.inspect ?? (async () => ({ Options: created?.DriverOpts ?? null })),
      remove: async () => { removed.push(name); },
    }),
  };
  return { docker, removed, created: () => created };
}

describe('assertDiskQuotaSupported', () => {
  it('does nothing and never calls Docker when off', async () => {
    const f = fakeDocker();
    await expect(assertDiskQuotaSupported(f.docker, 'off')).resolves.toBeUndefined();
    expect(f.docker.createVolume).not.toHaveBeenCalled();
  });

  it('creates and removes a 64 MB probe volume when enforce', async () => {
    const f = fakeDocker();
    await expect(assertDiskQuotaSupported(f.docker, 'enforce')).resolves.toBeUndefined();
    expect(f.created()).toMatchObject({ Driver: 'local', DriverOpts: { size: '64m' } });
    expect(f.created()!.Name).toMatch(/^hermes-quota-probe-[0-9a-f-]{36}$/);
    expect(f.removed).toEqual([f.created()!.Name]);
  });

  it('removes the probe volume even when creation succeeds but inspection shows no quota', async () => {
    const f = fakeDocker({ inspect: async () => ({ Options: null }) });
    await expect(assertDiskQuotaSupported(f.docker, 'enforce')).rejects.toThrow('HERMES_DISK_QUOTA');
    expect(f.removed).toHaveLength(1);
  });

  it('fails with a message naming HERMES_DISK_QUOTA when Docker rejects the size option', async () => {
    const f = fakeDocker({
      create: async () => {
        throw Object.assign(new Error('(HTTP code 400) create x: quota size requested but no quota support'), { statusCode: 400 });
      },
    });
    const err = await assertDiskQuotaSupported(f.docker, 'enforce').catch((e: Error) => e);
    expect((err as Error).message).toContain('HERMES_DISK_QUOTA');
    expect((err as Error).message).not.toContain('(HTTP code');
  });

  it('fails with a message naming HERMES_DISK_QUOTA when Docker is unreachable', async () => {
    const f = fakeDocker({ create: async () => { throw Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' }); } });
    await expect(assertDiskQuotaSupported(f.docker, 'enforce')).rejects.toThrow('HERMES_DISK_QUOTA');
  });
});
