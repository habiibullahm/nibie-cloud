import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CONTAINER_PORT,
  DATA_MOUNT,
  S6_REQUIRED_CAPS,
  S6_TMPFS,
  buildContainerConfig,
  containerName,
  networkName,
  volumeName,
} from '../../src/modules/runtime/hardening.js';
import type { RuntimeSpec } from '../../src/modules/runtime/types.js';
import { ValidationError } from '../../src/shared/errors.js';

const spec = (over: Partial<RuntimeSpec> = {}): RuntimeSpec => ({
  instanceId: randomUUID(),
  tenantId: randomUUID(),
  image: `nousresearch/hermes-agent@sha256:${'a'.repeat(64)}`,
  limits: { cpuMillis: 500, memoryMb: 256, pids: 128 },
  env: { FOO: 'bar' },
  ...over,
});

const envOf = (c: { Env?: string[] }): Record<string, string> =>
  Object.fromEntries((c.Env ?? []).map((e) => [e.split('=')[0], e.split('=').slice(1).join('=')]));

describe('buildContainerConfig', () => {
  it('targets the official image contract: port 8642 and /opt/data', () => {
    expect(CONTAINER_PORT).toBe(8642);
    expect(DATA_MOUNT).toBe('/opt/data');
    const c = buildContainerConfig(spec());
    expect(c.ExposedPorts).toEqual({ '8642/tcp': {} });
    expect(c.HostConfig!.PortBindings).toEqual({
      '8642/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }],
    });
  });

  it('never pins the container user (the s6 entrypoint drops to hermes 10000 itself)', () => {
    // Any --user other than root/hermes makes the official entrypoint fail fast.
    expect(buildContainerConfig(spec()).User).toBeUndefined();
  });

  it('leaves Init off because the image is PID 1 with its own s6 dispatcher', () => {
    expect(buildContainerConfig(spec()).HostConfig!.Init).toBe(false);
  });

  it('runs the gateway subcommand and preserves the image entrypoint', () => {
    const c = buildContainerConfig(spec());
    expect(c.Cmd).toEqual(['gateway', 'run']);
    expect(c.Entrypoint).toBeUndefined();
  });

  it('drops all capabilities and re-adds exactly the s6-overlay required set', () => {
    const h = buildContainerConfig(spec()).HostConfig!;
    expect(h.CapDrop).toEqual(['ALL']);
    expect(h.CapAdd).toEqual([...S6_REQUIRED_CAPS]);
    // Regression guard: dropping every capability makes cont-init exit-loop with
    // "s6-applyuidgid: fatal: unable to set supplementary group list".
    expect(h.CapAdd!.length).toBeGreaterThan(0);
  });

  it('keeps the read-only root filesystem with the s6 tmpfs set', () => {
    const h = buildContainerConfig(spec()).HostConfig!;
    expect(h.ReadonlyRootfs).toBe(true);
    expect(h.Tmpfs).toEqual(S6_TMPFS);
    expect(h.Tmpfs!['/run']).toContain('rw');
    expect(h.Tmpfs!['/var/run']).toContain('rw');
    expect(h.Tmpfs!['/tmp']).toContain('noexec');
  });

  it('applies the mandatory limits and privilege baseline', () => {
    const s = spec();
    const c = buildContainerConfig(s);
    const h = c.HostConfig!;
    expect(c.Image).toBe(s.image);
    expect(c.name).toBe(`hermes-${s.instanceId}`);
    expect(h.Privileged).toBe(false);
    expect(h.SecurityOpt).toEqual(['no-new-privileges:true']);
    expect(h.Memory).toBe(256 * 1048576);
    expect(h.MemorySwap).toBe(256 * 1048576);
    expect(h.NanoCpus).toBe(500 * 1_000_000);
    expect(h.PidsLimit).toBe(128);
    expect(h.RestartPolicy).toEqual({ Name: 'no' });
    expect(h.NetworkMode).toBe(`hermes-net-${s.instanceId}`);
    expect(c.Labels).toMatchObject({
      'hermes.cloud/managed': 'true',
      'hermes.cloud/instance-id': s.instanceId,
      'hermes.cloud/tenant-id': s.tenantId,
    });
  });

  it('mounts only the tenant data volume and never the Docker socket or host paths', () => {
    const s = spec();
    const h = buildContainerConfig(s).HostConfig!;
    expect(h.Binds).toEqual([`hermes-data-${s.instanceId}:/opt/data`]);
        for (const b of h.Binds!) {
          expect(b).not.toContain('docker.sock');
          // bind source is a named volume, never an absolute host path
          expect(b.split(':')[0]?.startsWith('/')).toBe(false);
        }
    expect(h.Mounts).toBeUndefined();
    expect(h.PidMode).toBeUndefined();
    expect(h.IpcMode).toBeUndefined();
    expect(h.Devices).toBeUndefined();
  });

  it('injects the loopback-reachable API server bind plus the per-instance key', () => {
    const key = 'k'.repeat(48);
    const env = envOf(buildContainerConfig(spec({ apiServerKey: key })));
    expect(env.API_SERVER_HOST).toBe('0.0.0.0');
    expect(env.API_SERVER_PORT).toBe('8642');
    expect(env.API_SERVER_KEY).toBe(key);
    expect(env.FOO).toBe('bar');
  });

  it('does not overwrite an explicitly supplied key or bind', () => {
    const env = envOf(
      buildContainerConfig(spec({ apiServerKey: 'ignored', env: { API_SERVER_KEY: 'explicit', API_SERVER_HOST: '127.0.0.1' } })),
    );
    expect(env.API_SERVER_KEY).toBe('explicit');
    expect(env.API_SERVER_HOST).toBe('127.0.0.1');
  });

  it('supports runtime selection and stays on the daemon default when unset', () => {
    expect(buildContainerConfig(spec()).HostConfig!.Runtime).toBeUndefined();
    expect(buildContainerConfig(spec({ runtime: 'runsc' })).HostConfig!.Runtime).toBe('runsc');
    expect(buildContainerConfig(spec({ runtime: 'runc' })).HostConfig!.Runtime).toBe('runc');
  });

  it('never weakens seccomp/apparmor and never uses host networking', () => {
    const h = buildContainerConfig(spec()).HostConfig!;
    expect(h.SecurityOpt!.join(' ')).not.toContain('unconfined');
    expect(h.NetworkMode).not.toBe('host');
  });

  it('refuses env that targets Docker or the control plane', () => {
    expect(() => buildContainerConfig(spec({ env: { DOCKER_HOST: 'tcp://x' } }))).toThrow(ValidationError);
    expect(() => buildContainerConfig(spec({ env: { DOCKER_CONFIG: '/x' } }))).toThrow(ValidationError);
  });

  it('refuses non-UUID instance ids (names derive only from UUIDs)', () => {
    expect(() => buildContainerConfig(spec({ instanceId: '../x; rm -rf /' }))).toThrow(ValidationError);
    expect(() => containerName('abc')).toThrow(ValidationError);
    expect(() => volumeName('abc')).toThrow(ValidationError);
    expect(() => networkName('abc')).toThrow(ValidationError);
  });

  it('refuses invalid limits', () => {
    expect(() => buildContainerConfig(spec({ limits: { cpuMillis: 0, memoryMb: 256, pids: 128 } }))).toThrow(ValidationError);
    expect(() => buildContainerConfig(spec({ limits: { cpuMillis: 500, memoryMb: 4, pids: 128 } }))).toThrow(ValidationError);
    expect(() => buildContainerConfig(spec({ limits: { cpuMillis: 500, memoryMb: 256, pids: 0 } }))).toThrow(ValidationError);
  });
});
