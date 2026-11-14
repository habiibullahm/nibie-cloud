import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  DNS_RESOLV_SEED_SCRIPT, DNS_RESOLV_VOLUME, DnsResolvConfError, ensureDnsResolvConf,
} from '../../src/modules/runtime/dns-resolv-conf.js';
import { createLogger } from '../../src/shared/logger.js';

const IMAGE = `canary@sha256:${'b'.repeat(64)}`;

type CtrCreate = { Image: string; Cmd: string[]; HostConfig: Record<string, unknown> };

function setup(opts: {
  volumeMissing?: boolean;
  volumeInspectError?: Error;
  createVolumeError?: Error;
  createContainerError?: Error;
  startError?: Error;
  waitError?: Error;
  statusCode?: number;
  removeError?: Error;
} = {}) {
  const calls: string[] = [];
  const containers: CtrCreate[] = [];
  const docker = {
    getVolume: () => ({
      inspect: async () => {
        calls.push('volume.inspect');
        if (opts.volumeMissing) throw Object.assign(new Error('no such volume'), { statusCode: 404 });
        if (opts.volumeInspectError) throw opts.volumeInspectError;
        return {};
      },
    }),
    createVolume: async (o: { Name: string }) => {
      calls.push('volume.create');
      if (opts.createVolumeError) throw opts.createVolumeError;
      return o;
    },
    createContainer: async (o: CtrCreate) => {
      calls.push('container.create');
      if (opts.createContainerError) throw opts.createContainerError;
      containers.push(o);
      return {
        start: async () => {
          calls.push('container.start');
          if (opts.startError) throw opts.startError;
        },
        wait: async () => {
          if (opts.waitError) throw opts.waitError;
          return { StatusCode: opts.statusCode ?? 0 };
        },
        remove: async () => { calls.push('container.remove'); if (opts.removeError) throw opts.removeError; },
      };
    },
  };
  let logs = '';
  const logger = createLogger({ level: 'debug', stream: new Writable({ write(c, _e, cb) { logs += c.toString(); cb(); } }) });
  return { docker, calls, containers, logger, logs: () => logs };
}

const run = (s: ReturnType<typeof setup>, resolvers: string[] = ['1.1.1.1', '9.9.9.9'], runtime?: 'runc' | 'runsc') =>
  ensureDnsResolvConf({ docker: s.docker as never, image: IMAGE, resolvers, runtime, logger: s.logger });

describe('ensureDnsResolvConf', () => {
  it('does nothing when there are no resolvers', async () => {
    const s = setup();
    await run(s, []);
    expect(s.calls).toEqual([]);
  });

  it('creates the volume when missing, then seeds it with a container', async () => {
    const s = setup({ volumeMissing: true });
    await run(s);
    expect(s.calls).toEqual(['volume.inspect', 'volume.create', 'container.create', 'container.start', 'container.remove']);
  });

  it('does not recreate the volume when it already exists', async () => {
    const s = setup();
    await run(s);
    expect(s.calls).not.toContain('volume.create');
  });

  it('runs the seed script with resolvers as argv, not interpolated into the script body', async () => {
    const s = setup();
    await run(s, ['1.1.1.1', '9.9.9.9']);
    expect(s.containers[0]!.Cmd).toEqual(['sh', '-c', DNS_RESOLV_SEED_SCRIPT, 'seed', '1.1.1.1', '9.9.9.9']);
    expect(DNS_RESOLV_SEED_SCRIPT).not.toContain('1.1.1.1');
  });

  it('mounts the shared volume at /dns, with no other binds, and drops all capabilities', async () => {
    const s = setup();
    await run(s);
    const hc = s.containers[0]!.HostConfig;
    expect(hc.Mounts).toEqual([{ Target: '/dns', Source: DNS_RESOLV_VOLUME, Type: 'volume' }]);
    expect(hc.Binds).toBeUndefined();
    expect(hc.CapDrop).toEqual(['ALL']);
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.NetworkMode).toBe('none');
  });

  it('runs the seed container under the given OCI runtime, with a raised pids limit under runsc', async () => {
    const gv = setup();
    await run(gv, ['1.1.1.1'], 'runsc');
    expect(gv.containers[0]!.HostConfig.Runtime).toBe('runsc');
    expect(gv.containers[0]!.HostConfig.PidsLimit).toBe(256);
    const rc = setup();
    await run(rc, ['1.1.1.1'], 'runc');
    expect(rc.containers[0]!.HostConfig.Runtime).toBe('runc');
    expect(rc.containers[0]!.HostConfig.PidsLimit).toBe(32);
  });

  it('always removes the seed container, even when the volume already existed', async () => {
    const s = setup();
    await run(s);
    expect(s.calls).toContain('container.remove');
  });

  it('rejects with DnsResolvConfError, not a raw Docker error, when the volume cannot be inspected', async () => {
    const s = setup({ volumeInspectError: Object.assign(new Error('daemon down'), { statusCode: 500 }) });
    const err = await run(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DnsResolvConfError);
    expect(s.calls).not.toContain('container.create');
  });

  it('rejects with DnsResolvConfError when the volume cannot be created', async () => {
    const s = setup({ volumeMissing: true, createVolumeError: new Error('boom') });
    const err = await run(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DnsResolvConfError);
    expect(s.calls).not.toContain('container.create');
  });

  it('rejects with DnsResolvConfError when the container cannot be created, and still resolves without a remove call', async () => {
    const s = setup({ createContainerError: new Error('boom: /var/lib/docker/secret') });
    const err = await run(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DnsResolvConfError);
    expect((err as Error).message).not.toContain('/var/lib');
    expect(s.calls).not.toContain('container.remove');
  });

  it('rejects with DnsResolvConfError and still removes the container when starting it fails', async () => {
    const s = setup({ startError: new Error('boom') });
    const err = await run(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DnsResolvConfError);
    expect(s.calls).toContain('container.remove');
  });

  it('rejects with DnsResolvConfError and still removes the container when waiting fails', async () => {
    const s = setup({ waitError: new Error('daemon went away') });
    const err = await run(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DnsResolvConfError);
    expect(s.calls).toContain('container.remove');
  });

  it('rejects with DnsResolvConfError when the seed script exits non-zero', async () => {
    const s = setup({ statusCode: 1 });
    const err = await run(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DnsResolvConfError);
    expect(s.calls).toContain('container.remove');
  });

  it('does not throw when removing the container fails, but logs the failure by reason only', async () => {
    const s = setup({ removeError: new Error('cannot remove') });
    await expect(run(s)).resolves.toBeUndefined();
    expect(s.logs()).toContain('container_remove_failed');
  });
});
