import { describe, expect, it, vi } from 'vitest';
import { assertRuntimeAvailable } from '../../src/modules/runtime/runtime-availability.js';

const docker = (info: () => Promise<{ Runtimes?: Record<string, unknown> }>) => ({ info: vi.fn(info) });

describe('assertRuntimeAvailable', () => {
  it('never calls info for runc', async () => {
    const d = docker(async () => ({}));
    await expect(assertRuntimeAvailable(d, 'runc')).resolves.toBeUndefined();
    expect(d.info).not.toHaveBeenCalled();
  });

  it('passes for runsc when the daemon lists it', async () => {
    const d = docker(async () => ({ Runtimes: { runc: {}, runsc: {} } }));
    await expect(assertRuntimeAvailable(d, 'runsc')).resolves.toBeUndefined();
  });

  it('fails with a clear message for runsc when it is missing', async () => {
    const d = docker(async () => ({ Runtimes: { runc: {} } }));
    await expect(assertRuntimeAvailable(d, 'runsc')).rejects.toThrow('Docker runtime "runsc" is not available on this host');
  });

  it('fails for runsc when the daemon reports no Runtimes at all', async () => {
    const d = docker(async () => ({}));
    await expect(assertRuntimeAvailable(d, 'runsc')).rejects.toThrow('Docker runtime "runsc" is not available on this host');
  });
});
