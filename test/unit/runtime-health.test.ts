import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockerRuntimeManager } from '../../src/modules/runtime/docker-runtime-manager.js';

const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

function fakeDocker(status: 'running' | 'exited' = 'running') {
  return {
    getContainer: () => ({
      inspect: async () => ({
        State: { Status: status, Running: status === 'running', ExitCode: 0, OOMKilled: false, StartedAt: '2026-11-12T00:00:00Z' },
        NetworkSettings: { Ports: { '8642/tcp': [{ HostPort: '49152' }] } },
      }),
    }),
    getVolume: () => ({ inspect: async () => ({}) }),
  } as never;
}

const stubFetch = (status: number) => {
  const fn = vi.fn(async () => new Response('{}', { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
};

afterEach(() => vi.unstubAllGlobals());

describe('DockerRuntimeManager.checkHealth', () => {
  it('is ok on 200 when a key is supplied', async () => {
    stubFetch(200);
    const h = await new DockerRuntimeManager({ docker: fakeDocker(), logger: silent }).checkHealth(ID, 'k');
    expect(h.ok).toBe(true);
  });

  it('is not ok on 401 when a key is supplied, with detail "auth rejected"', async () => {
    stubFetch(401);
    const h = await new DockerRuntimeManager({ docker: fakeDocker(), logger: silent }).checkHealth(ID, 'k');
    expect(h).toMatchObject({ ok: false, detail: 'auth rejected' });
  });

  it('is still ok on 401 when no key is supplied (daemon alive)', async () => {
    stubFetch(401);
    const h = await new DockerRuntimeManager({ docker: fakeDocker(), logger: silent }).checkHealth(ID);
    expect(h.ok).toBe(true);
  });

  it('is ok on 200 when no key is supplied', async () => {
    stubFetch(200);
    const h = await new DockerRuntimeManager({ docker: fakeDocker(), logger: silent }).checkHealth(ID);
    expect(h.ok).toBe(true);
  });

  it('sends the Bearer header when a key is supplied', async () => {
    const f = stubFetch(200);
    await new DockerRuntimeManager({ docker: fakeDocker(), logger: silent }).checkHealth(ID, 'secret-key');
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-key');
  });

  it('returns not ok without calling fetch when the container is not running', async () => {
    const f = stubFetch(200);
    const h = await new DockerRuntimeManager({ docker: fakeDocker('exited'), logger: silent }).checkHealth(ID, 'k');
    expect(h.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});
