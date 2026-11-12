import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CANARY_SCRIPT, EgressCanaryError, EgressPolicyError, evaluateCanary, runEgressCanary,
} from '../../src/modules/runtime/egress-canary.js';
import { BRIDGE_NAME_OPTION } from '../../src/modules/runtime/hardening.js';
import { createLogger } from '../../src/shared/logger.js';

const GATEWAY = '172.31.0.1';
const PRIVATE_IP = '192.0.2.77';
const IMAGE = `canary@sha256:${'b'.repeat(64)}`;

type NetCreate = { Name: string; EnableIPv6?: boolean; Options?: Record<string, string> };
type CtrCreate = { Image: string; Cmd: string[]; HostConfig: Record<string, unknown>; [k: string]: unknown };

function setup(opts: {
  output?: string;
  createContainerError?: Error;
  imageMissing?: boolean;
  noGateway?: boolean;
  waitError?: Error;
  statusCode?: number;
  removeError?: Error;
} = {}) {
  const calls: string[] = [];
  const networks: NetCreate[] = [];
  const containers: CtrCreate[] = [];
  const listens: { host: string; port: number; closed: boolean }[] = [];
  let nextPort = 40_000;
  const docker = {
    getImage: () => ({
      inspect: async () => {
        calls.push('image.inspect');
        if (opts.imageMissing) throw Object.assign(new Error('no such image'), { statusCode: 404 });
        return {};
      },
    }),
    createNetwork: async (o: NetCreate) => { calls.push('network.create'); networks.push(o); return {}; },
    getNetwork: () => ({
      inspect: async () => ({ IPAM: { Config: opts.noGateway ? [] : [{ Gateway: GATEWAY }] } }),
      remove: async () => { calls.push('network.remove'); },
    }),
    createContainer: async (o: CtrCreate) => {
      calls.push('container.create');
      if (opts.createContainerError) throw opts.createContainerError;
      containers.push(o);
      return {
        start: async () => { calls.push('container.start'); },
        wait: async () => {
          if (opts.waitError) throw opts.waitError;
          return { StatusCode: opts.statusCode ?? 0 };
        },
        logs: async () => Buffer.from(opts.output ?? 'gateway=blocked\nprivate=blocked\nmetadata=blocked\n'),
        remove: async () => { calls.push('container.remove'); if (opts.removeError) throw opts.removeError; },
      };
    },
  };
  const listen = async (host: string) => {
    const l = { host, port: (nextPort += 1), closed: false };
    listens.push(l);
    calls.push('listen');
    return { port: l.port, close: async () => { l.closed = true; calls.push('listen.close'); } };
  };
  let logs = '';
  const logger = createLogger({ level: 'debug', stream: new Writable({ write(c, _e, cb) { logs += c.toString(); cb(); } }) });
  return { docker, calls, networks, containers, listens, listen, logger, logs: () => logs };
}

const run = (s: ReturnType<typeof setup>, privateIp?: string, runtime?: 'runc' | 'runsc') =>
  runEgressCanary({ docker: s.docker as never, image: IMAGE, privateIp, runtime, listen: s.listen, logger: s.logger });

/** The probes the canary container was told to run: [check, host, port] triples after the script. */
const probes = (s: ReturnType<typeof setup>) => {
  const args = s.containers[0]!.Cmd.slice(4); // sh -c <script> canary <triples...>
  const out: { check: string; host: string; port: number }[] = [];
  for (let i = 0; i < args.length; i += 3) out.push({ check: args[i]!, host: args[i + 1]!, port: Number(args[i + 2]) });
  return out;
};

describe('evaluateCanary', () => {
  it('passes when nothing connected', () => {
    expect(() => evaluateCanary([
      { check: 'gateway', connected: false }, { check: 'private', connected: false }, { check: 'metadata', connected: false },
    ])).not.toThrow();
  });

  it('throws EgressPolicyError naming the first connected check only', () => {
    try {
      evaluateCanary([{ check: 'gateway', connected: false }, { check: 'metadata', connected: true }, { check: 'private', connected: true }]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EgressPolicyError);
      expect((e as Error).message).toContain('metadata');
      expect((e as Error).message).not.toContain('private');
    }
  });
});

describe('runEgressCanary', () => {
  it('resolves when no probe connects', async () => {
    await expect(run(setup())).resolves.toBeUndefined();
  });

  it('rejects with EgressPolicyError naming gateway only when the gateway probe connects', async () => {
    const s = setup({ output: 'gateway=connected\nmetadata=blocked\n' });
    const err = await run(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressPolicyError);
    expect((err as Error).message).toContain('gateway');
    expect((err as Error).message).not.toContain('metadata');
  });

  it('adds the private probe only when a private IP is configured', async () => {
    const without = setup();
    await run(without);
    expect(probes(without).map((p) => p.check)).toEqual(['gateway', 'metadata']);
    expect(without.listens.map((l) => l.host)).toEqual([GATEWAY]);

    const withIp = setup({ output: 'gateway=blocked\nprivate=blocked\nmetadata=blocked\n' });
    await run(withIp, PRIVATE_IP);
    expect(probes(withIp).map((p) => p.check)).toEqual(['gateway', 'private', 'metadata']);
  });

  it('opens a listener on the gateway and on the private IP and probes those exact ports', async () => {
    const s = setup();
    await run(s, PRIVATE_IP);
    expect(s.listens.map((l) => l.host)).toEqual([GATEWAY, PRIVATE_IP]);
    const p = probes(s);
    expect(p.find((x) => x.check === 'gateway')).toEqual({ check: 'gateway', host: GATEWAY, port: s.listens[0]!.port });
    expect(p.find((x) => x.check === 'private')).toEqual({ check: 'private', host: PRIVATE_IP, port: s.listens[1]!.port });
  });

  it('the metadata probe targets 169.254.169.254:80 and never gets a listener', async () => {
    const s = setup();
    await run(s);
    expect(probes(s).find((x) => x.check === 'metadata')).toEqual({ check: 'metadata', host: '169.254.169.254', port: 80 });
    expect(s.listens.some((l) => l.host === '169.254.169.254')).toBe(false);
  });

  it('closes the listeners, removes the container and removes the network when everything passes', async () => {
    const s = setup();
    await run(s, PRIVATE_IP);
    expect(s.listens.every((l) => l.closed)).toBe(true);
    expect(s.calls).toContain('container.remove');
    expect(s.calls).toContain('network.remove');
  });

  it('does the same cleanup when a probe connects', async () => {
    const s = setup({ output: 'gateway=connected\n' });
    await run(s, PRIVATE_IP).catch(() => undefined);
    expect(s.listens.every((l) => l.closed)).toBe(true);
    expect(s.calls).toContain('container.remove');
    expect(s.calls).toContain('network.remove');
  });

  it('does the same cleanup, and rejects with a different error, when the container cannot be created', async () => {
    const s = setup({ createContainerError: new Error('boom: /var/lib/docker/secret') });
    const err = await run(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressCanaryError);
    expect(err).not.toBeInstanceOf(EgressPolicyError);
    expect((err as Error).message).not.toContain('/var/lib');
    expect(s.listens.every((l) => l.closed)).toBe(true);
    expect(s.calls).toContain('network.remove');
  });

  it('does the same cleanup, and rejects with a different error, when the image is missing', async () => {
    const s = setup({ imageMissing: true });
    const err = await run(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressCanaryError);
    expect(err).not.toBeInstanceOf(EgressPolicyError);
    expect(s.calls).not.toContain('container.create');
    expect(s.calls.filter((c) => c === 'network.create')).toHaveLength(s.calls.filter((c) => c === 'network.remove').length);
  });

  it('cleans up and rejects with EgressCanaryError when waiting for the container fails', async () => {
    const s = setup({ waitError: new Error('daemon went away') });
    const err = await run(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressCanaryError);
    expect(s.calls).toContain('container.remove');
    expect(s.calls).toContain('network.remove');
  });

  it('cannot pass silently: a missing result, a script error or a non-zero exit is a canary failure, not a pass', async () => {
    for (const o of [
      { output: 'gateway=blocked\n' },            // metadata result missing
      { output: 'error=nc_missing\n', statusCode: 127 },
      { output: 'gateway=blocked\nmetadata=blocked\n', statusCode: 1 },
      { output: '' },
    ]) {
      const err = await run(setup(o)).catch((e: unknown) => e);
      expect(err, JSON.stringify(o)).toBeInstanceOf(EgressCanaryError);
    }
  });

  it('rejects with EgressCanaryError when the network has no gateway', async () => {
    const s = setup({ noGateway: true });
    expect(await run(s).catch((e: unknown) => e)).toBeInstanceOf(EgressCanaryError);
    expect(s.calls).toContain('network.remove');
  });

  it('uses a network built by buildNetworkConfig with an hn bridge name so the rules match it', async () => {
    const s = setup();
    await run(s);
    expect(s.networks).toHaveLength(1);
    expect(s.networks[0]!.EnableIPv6).toBe(false);
    expect(s.networks[0]!.Options?.[BRIDGE_NAME_OPTION]).toMatch(/^hn[0-9a-f]{12}$/);
  });

  it('runs the canary with CapDrop ALL, a read-only rootfs, no volumes and small memory and pids limits', async () => {
    const s = setup();
    await run(s);
    const hc = s.containers[0]!.HostConfig as Record<string, unknown>;
    expect(s.containers[0]!.Image).toBe(IMAGE);
    expect(hc.CapDrop).toEqual(['ALL']);
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.Binds).toBeUndefined();
    expect(hc.Mounts).toBeUndefined();
    expect(s.containers[0]!.Volumes).toBeUndefined();
    expect(hc.Memory).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(hc.PidsLimit).toBeLessThanOrEqual(64);
    expect(hc.SecurityOpt).toContain('no-new-privileges');
    expect(hc.NetworkMode).toBe(s.networks[0]!.Name);
  });

  it('runs the canary under the configured OCI runtime so it tests the tenants path', async () => {
    const gv = setup();
    await run(gv, undefined, 'runsc');
    expect((gv.containers[0]!.HostConfig as Record<string, unknown>).Runtime).toBe('runsc');
    const rc = setup();
    await run(rc, undefined, 'runc');
    expect((rc.containers[0]!.HostConfig as Record<string, unknown>).Runtime).toBe('runc');
    const none = setup();
    await run(none);
    expect((none.containers[0]!.HostConfig as Record<string, unknown>).Runtime).toBeUndefined();
  });

  it('logs a cleanup failure by reason only (a leaked network must not be silent) and still tries the network', async () => {
    const s = setup({ removeError: new Error(`cannot remove ${GATEWAY}`) });
    await run(s);
    expect(s.logs()).toContain('container_remove_failed');
    expect(s.logs()).not.toContain(GATEWAY);
    expect(s.calls).toContain('network.remove');
  });

  it('error messages and logs never contain the probe addresses', async () => {
    const failing = setup({ output: 'gateway=connected\n' });
    const e1 = (await run(failing, PRIVATE_IP).catch((e: unknown) => e)) as Error;
    const broken = setup({ createContainerError: new Error(`dial ${GATEWAY} ${PRIVATE_IP}`) });
    const e2 = (await run(broken, PRIVATE_IP).catch((e: unknown) => e)) as Error;
    const passing = setup();
    await run(passing, PRIVATE_IP);
    const all = [e1.message, e2.message, failing.logs(), broken.logs(), passing.logs()].join('\n');
    for (const secret of [GATEWAY, PRIVATE_IP, '169.254.169.254']) expect(all).not.toContain(secret);
  });
});

// The canary script itself, run under a real sh with real, stubbed or missing `nc`.
describe('canary script', () => {
  const hasNc = spawnSync('sh', ['-c', 'command -v nc']).status === 0;
  const work = mkdtempSync(join(tmpdir(), 'canary-'));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const sh = (args: string[], path: string) =>
    spawnSync('/bin/sh', ['-c', CANARY_SCRIPT, 'canary', ...args], { encoding: 'utf8', env: { PATH: path }, timeout: 20_000 });

  it('reports "blocked" for a closed port and "connected" for an open one, with a working nc', async () => {
    if (!hasNc) return;
    const server = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const open = (server.address() as net.AddressInfo).port;
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const closedPort = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    try {
      const r = sh(['gateway', '127.0.0.1', String(open), 'private', '127.0.0.1', String(closedPort)], process.env.PATH ?? '/usr/bin:/bin');
      expect(r.stdout).toContain('gateway=connected');
      expect(r.stdout).toContain('private=blocked');
      expect(r.status).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('fails with error=nc_missing and no probe lines when nc is absent', () => {
    const empty = join(work, 'empty');
    mkdirSync(empty);
    const r = sh(['gateway', '127.0.0.1', '1'], empty);
    expect(r.stdout).toContain('error=nc_missing');
    expect(r.stdout).not.toMatch(/=(blocked|connected)/);
    expect(r.status).toBe(127);
  });

  it('fails with error=nc_unusable and never prints "blocked" when nc cannot do a loopback connect (positive control)', () => {
    const bin = join(work, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'nc'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'nc'), 0o755);
    const r = sh(['gateway', '127.0.0.1', '1', 'metadata', '169.254.169.254', '80'], `${bin}:/usr/bin:/bin`);
    expect(r.stdout).toContain('error=nc_unusable');
    expect(r.stdout).not.toMatch(/=(blocked|connected)/);
    expect(r.status).not.toBe(0);
  });
});
