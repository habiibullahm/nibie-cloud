import { randomUUID } from 'node:crypto';
import Docker from 'dockerode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerRuntimeManager } from '../../src/modules/runtime/docker-runtime-manager.js';
import { S6_REQUIRED_CAPS } from '../../src/modules/runtime/hardening.js';
import type { RuntimeSpec } from '../../src/modules/runtime/types.js';
import { createLogger } from '../../src/shared/logger.js';
import { execIn } from '../helpers/exec.js';
import { ensureStubImage } from '../helpers/stub-image.js';

const docker = new Docker();
const manager = new DockerRuntimeManager({ docker, logger: createLogger({ level: 'silent' }) });
const sh = (id: string, script: string) => execIn(docker, id, ['sh', '-c', script]);

let a: RuntimeSpec;
let b: RuntimeSpec;

const spec = (image: string): RuntimeSpec => ({
  instanceId: randomUUID(),
  tenantId: randomUUID(),
  image,
  limits: { cpuMillis: 500, memoryMb: 256, pids: 128, storageMb: 1024 },
    diskQuota: 'off',
  env: {},
  apiServerKey: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
});

describe('tenant isolation', () => {
  beforeAll(async () => {
    const image = await ensureStubImage();
    a = spec(image);
    b = spec(image);
    for (const s of [a, b]) {
      await manager.ensure(s);
      await manager.start(s.instanceId);
    }
  });
  afterAll(async () => {
    for (const s of [a, b]) if (s) await manager.remove(s.instanceId, { deleteVolume: true });
  });

  it('enforces the hardening baseline on the live container', async () => {
    const info = await docker.getContainer(`hermes-${a.instanceId}`).inspect();
    const h = info.HostConfig;
    expect(h.Privileged).toBe(false);
    expect(h.ReadonlyRootfs).toBe(true);
    expect(h.CapDrop).toEqual(['ALL']);
    expect([...(h.CapAdd ?? [])].sort()).toEqual([...S6_REQUIRED_CAPS].sort());
    expect(h.SecurityOpt).toContain('no-new-privileges:true');
    expect(h.SecurityOpt!.join()).not.toContain('unconfined');
    expect(h.PidsLimit).toBe(128);
    expect(h.Memory).toBe(268435456);
    expect(h.MemorySwap).toBe(268435456);
    expect(h.NanoCpus).toBe(500000000);
    expect(h.NetworkMode).toBe(`hermes-net-${a.instanceId}`);
    expect(h.PidMode).toBe('');
    expect(h.IpcMode).not.toBe('host');
    expect(info.Config.User).toBe(''); // never pinned: the s6-style entrypoint drops to hermes itself
  });

  it('mounts exactly one tenant volume and never the Docker socket', async () => {
    const info = await docker.getContainer(`hermes-${a.instanceId}`).inspect();
    expect(info.Mounts).toHaveLength(1);
    expect(info.Mounts[0]).toMatchObject({ Type: 'volume', Destination: '/opt/data', Name: `hermes-data-${a.instanceId}` });
    const r = await sh(a.instanceId, 'ls /var/run/docker.sock /run/docker.sock 2>&1');
    expect(r.code).not.toBe(0);
    expect(r.out).not.toMatch(/^\/var\/run\/docker\.sock$/m);
  });

  it('drops the gateway to hermes (10000) with a read-only root filesystem and writable data', async () => {
    const ps = await sh(a.instanceId, 'ps -o user,args');
    expect(ps.out).toMatch(/^hermes\s+nc -lk/m);
    expect((await sh(a.instanceId, 'stat -c %u /opt/data')).out.trim()).toBe('10000');
    expect((await sh(a.instanceId, 'touch /etc/hermes-x')).code).not.toBe(0);
    expect((await sh(a.instanceId, 'touch /opt/data/x')).code).toBe(0);
    expect((await sh(a.instanceId, 'touch /tmp/x')).code).toBe(0);
  });

  it('leaves the gateway process with no effective capabilities after the privilege drop', async () => {
    const r = await sh(a.instanceId, "grep CapEff /proc/$(ps -o pid,args | awk '/nc -lk/ && !/awk/ {print $1; exit}')/status");
    expect(r.out).toMatch(/CapEff:\s+0+$/m);
  });

  it("cannot see another tenant's data", async () => {
    await sh(b.instanceId, 'echo secret-b > /opt/data/b-only');
    const ls = await sh(a.instanceId, 'ls /opt/data');
    expect(ls.out).not.toContain('b-only');
    const cat = await sh(a.instanceId, 'cat /opt/data/b-only');
    expect(cat.code).not.toBe(0);
    expect(cat.out).not.toContain('secret-b');
  });

  it('cannot reach another tenant container over the network', async () => {
    const binfo = await docker.getContainer(`hermes-${b.instanceId}`).inspect();
    const bIp = Object.values(binfo.NetworkSettings.Networks)[0]!.IPAddress;
    expect(bIp).toBeTruthy();
    // Authenticate with B's own key: a 401 would also fail wget, so only a blocked path may fail.
    const get = (host: string, key: string) =>
      sh(a.instanceId, `wget -T 3 -qO- --header 'Authorization: Bearer ${key}' http://${host}:8642/api/sessions`);
    const control = await get('127.0.0.1', a.apiServerKey!);
    expect(control.code).toBe(0); // the probe works when the path is open
    const byIp = await get(bIp, b.apiServerKey!);
    expect(byIp.code).not.toBe(0);
    const byName = await get(`hermes-${b.instanceId}`, b.apiServerKey!);
    expect(byName.code).not.toBe(0);
  });

  it('enforces the memory limit: an over-allocating process is killed, the container survives', async () => {
    const r = await sh(a.instanceId, 'x=$(head -c 400000000 /dev/zero | tr "\\0" a); echo ${#x}');
    expect(r.out.trim()).not.toBe('400000000');
    expect((await manager.inspect(a.instanceId)).state).toBe('running');
  });

  it('caps the number of processes at the PID limit', async () => {
    const r = await sh(a.instanceId, 'for i in $(seq 1 400); do sleep 60 & done');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("can't fork");
    const top = await docker.getContainer(`hermes-${a.instanceId}`).top();
    expect(top.Processes.length).toBeGreaterThan(50);
    expect(top.Processes.length).toBeLessThanOrEqual(128);
    expect((await manager.inspect(a.instanceId)).state).toBe('running');
  });
});
