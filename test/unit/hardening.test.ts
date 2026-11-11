import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
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
  image: 'hermes-stub:0.1.0',
  limits: { cpuMillis: 500, memoryMb: 256, pids: 128 },
  env: { FOO: 'bar' },
  ...over,
});

describe('buildContainerConfig', () => {
  it('applies the mandatory hardening baseline and limits', () => {
    const s = spec();
    const c = buildContainerConfig(s);
    const h = c.HostConfig!;
    expect(c.User).toBe('10001:10001');
    expect(c.Image).toBe(s.image);
    expect(c.name).toBe(`hermes-${s.instanceId}`);
    expect(h.Privileged).toBe(false);
    expect(h.ReadonlyRootfs).toBe(true);
    expect(h.CapDrop).toEqual(['ALL']);
    expect(h.CapAdd).toBeUndefined();
    expect(h.SecurityOpt).toEqual(['no-new-privileges:true']);
    expect(h.Memory).toBe(256 * 1048576);
    expect(h.MemorySwap).toBe(256 * 1048576);
    expect(h.NanoCpus).toBe(500 * 1_000_000);
    expect(h.PidsLimit).toBe(128);
    expect(h.Init).toBe(true);
    expect(h.RestartPolicy).toEqual({ Name: 'no' });
    expect(h.Tmpfs).toEqual({ '/tmp': 'rw,noexec,nosuid,size=64m' });
    expect(h.NetworkMode).toBe(`hermes-net-${s.instanceId}`);
    expect(h.PortBindings).toEqual({ '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] });
    expect(c.Labels).toMatchObject({
      'hermes.cloud/managed': 'true',
      'hermes.cloud/instance-id': s.instanceId,
      'hermes.cloud/tenant-id': s.tenantId,
    });
  });

  it('mounts only the tenant data volume and never the Docker socket or host paths', () => {
    const s = spec();
    const h = buildContainerConfig(s).HostConfig!;
    expect(h.Binds).toEqual([`hermes-data-${s.instanceId}:/data`]);
    for (const b of h.Binds!) {
      expect(b).not.toContain('docker.sock');
      expect(b.startsWith('/')).toBe(false);
    }
    expect(h.Mounts).toBeUndefined();
    expect(h.PidMode).toBeUndefined();
    expect(h.IpcMode).toBeUndefined();
    expect(h.Devices).toBeUndefined();
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
