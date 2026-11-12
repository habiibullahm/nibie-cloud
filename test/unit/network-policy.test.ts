import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DockerRuntimeManager } from '../../src/modules/runtime/docker-runtime-manager.js';
import { BRIDGE_NAME_OPTION, bridgeName, buildNetworkConfig, networkName } from '../../src/modules/runtime/hardening.js';
import type { RuntimeSpec } from '../../src/modules/runtime/types.js';
import { NetworkPolicyMissingError } from '../../src/shared/errors.js';

type Net = { Name: string; Options: Record<string, string> | null };
type Created = { Name: string; Options?: Record<string, string>; EnableIPv6?: boolean };

const status = (statusCode: number, message = 'x') => Object.assign(new Error(message), { statusCode });

/** Minimal in-memory dockerode: just enough surface for DockerRuntimeManager.ensure(). */
function fakeDocker(opts: { createError?: Error; raceWith?: Net } = {}) {
  const networks = new Map<string, Net>();
  const created: Created[] = [];
  const docker = {
    getVolume: () => ({ inspect: async () => ({ Name: 'v', Options: { size: '512m' } }) }),
    createVolume: async () => ({}),
    getNetwork: (name: string) => ({
      inspect: async () => {
        const n = networks.get(name);
        if (!n) throw status(404);
        return n;
      },
    }),
    createNetwork: async (o: Created) => {
      if (opts.raceWith) networks.set(o.Name, opts.raceWith); // a concurrent ensure won the race
      if (opts.createError) throw opts.createError;
      created.push(o);
      networks.set(o.Name, { Name: o.Name, Options: o.Options ?? null });
      return {};
    },
    getContainer: () => ({ inspect: async () => { throw status(404); } }),
    getImage: () => ({ inspect: async () => ({}) }),
    createContainer: async () => ({}),
  };
  return { docker, networks, created };
}

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
const spec = (over: Partial<RuntimeSpec> = {}): RuntimeSpec => ({
  instanceId: randomUUID(),
  tenantId: randomUUID(),
  image: `nousresearch/hermes-agent@sha256:${'a'.repeat(64)}`,
  limits: { cpuMillis: 500, memoryMb: 256, pids: 128, storageMb: 512 },
  diskQuota: 'enforce',
  egressPolicy: 'enforce',
  env: {},
  ...over,
});
const manager = (f: ReturnType<typeof fakeDocker>) => new DockerRuntimeManager({ docker: f.docker as never, logger: silent });

describe('tenant network identity', () => {
  it('creates the network with the hn bridge name and IPv6 off', async () => {
    const f = fakeDocker();
    const s = spec();
    await manager(f).ensure(s);
    expect(f.created).toHaveLength(1);
    expect(f.created[0]).toMatchObject({
      Name: networkName(s.instanceId), EnableIPv6: false,
      Options: { [BRIDGE_NAME_OPTION]: bridgeName(s.instanceId) },
    });
    expect(f.created[0]).toMatchObject({ Options: buildNetworkConfig(s.instanceId).Options });
  });

  it('reuses an existing network that has the bridge name', async () => {
    const f = fakeDocker();
    const s = spec();
    f.networks.set(networkName(s.instanceId), { Name: 'n', Options: { [BRIDGE_NAME_OPTION]: bridgeName(s.instanceId) } });
    await manager(f).ensure(s);
    expect(f.created).toHaveLength(0);
  });

  it('refuses an existing network without the bridge name when enforce', async () => {
    const f = fakeDocker();
    const s = spec();
    f.networks.set(networkName(s.instanceId), { Name: 'n', Options: { 'com.docker.network.bridge.enable_icc': 'false' } });
    await expect(manager(f).ensure(s)).rejects.toBeInstanceOf(NetworkPolicyMissingError);
    expect(f.created).toHaveLength(0);
  });

  it('refuses an existing network with a different bridge name or no options when enforce', async () => {
    for (const Options of [null, { [BRIDGE_NAME_OPTION]: 'hnffffffffffff' }]) {
      const f = fakeDocker();
      const s = spec();
      f.networks.set(networkName(s.instanceId), { Name: 'n', Options });
      await expect(manager(f).ensure(s)).rejects.toBeInstanceOf(NetworkPolicyMissingError);
    }
  });

  it('accepts an unnamed network when off', async () => {
    const f = fakeDocker();
    const s = spec({ egressPolicy: 'off' });
    f.networks.set(networkName(s.instanceId), { Name: 'n', Options: null });
    await expect(manager(f).ensure(s)).resolves.toBeDefined();
  });

  it('after a create conflict (409) it re-checks the winner: right name is fine', async () => {
    const s = spec();
    const f = fakeDocker({
      createError: status(409),
      raceWith: { Name: 'n', Options: { [BRIDGE_NAME_OPTION]: bridgeName(s.instanceId) } },
    });
    await expect(manager(f).ensure(s)).resolves.toBeDefined();
  });

  it('after a create conflict (409) it re-checks the winner: wrong name is refused, not retried', async () => {
    const s = spec();
    const f = fakeDocker({ createError: status(409), raceWith: { Name: 'n', Options: null } });
    await expect(manager(f).ensure(s)).rejects.toBeInstanceOf(NetworkPolicyMissingError);
  });

  it('a bridge-name collision with another network (403) is reported as NetworkPolicyMissingError', async () => {
    const f = fakeDocker({ createError: status(403, 'cannot create network x (hnaaaaaaaaaaaa): conflicts with network y (hnaaaaaaaaaaaa): networks have same bridge name') });
    await expect(manager(f).ensure(spec())).rejects.toBeInstanceOf(NetworkPolicyMissingError);
  });

  it('other create failures are not mistaken for a policy problem', async () => {
    const f = fakeDocker({ createError: status(500, 'boom') });
    const err = await manager(f).ensure(spec()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NetworkPolicyMissingError);
  });

  it('a bridge-name collision when off is not a policy error', async () => {
    const f = fakeDocker({ createError: status(403, 'networks have same bridge name') });
    const err = await manager(f).ensure(spec({ egressPolicy: 'off' })).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(NetworkPolicyMissingError);
  });
});

describe('assertNetworkPolicy', () => {
  it('refuses an existing network without the bridge name when enforce', async () => {
    const f = fakeDocker();
    const s = spec();
    f.networks.set(networkName(s.instanceId), { Name: 'n', Options: null });
    await expect(manager(f).assertNetworkPolicy(s.instanceId, 'enforce')).rejects.toBeInstanceOf(NetworkPolicyMissingError);
  });

  it('refuses a network with a different bridge name when enforce', async () => {
    const f = fakeDocker();
    const s = spec();
    f.networks.set(networkName(s.instanceId), { Name: 'n', Options: { [BRIDGE_NAME_OPTION]: 'hnffffffffffff' } });
    await expect(manager(f).assertNetworkPolicy(s.instanceId, 'enforce')).rejects.toBeInstanceOf(NetworkPolicyMissingError);
  });

  it('refuses an absent network when enforce (cannot confirm the policy)', async () => {
    await expect(manager(fakeDocker()).assertNetworkPolicy(randomUUID(), 'enforce')).rejects.toBeInstanceOf(NetworkPolicyMissingError);
  });

  it('accepts a network that has the bridge name when enforce', async () => {
    const f = fakeDocker();
    const s = spec();
    f.networks.set(networkName(s.instanceId), { Name: 'n', Options: { [BRIDGE_NAME_OPTION]: bridgeName(s.instanceId) } });
    await expect(manager(f).assertNetworkPolicy(s.instanceId, 'enforce')).resolves.toBeUndefined();
  });

  it('does nothing when off, whatever the network looks like', async () => {
    await expect(manager(fakeDocker()).assertNetworkPolicy(randomUUID(), 'off')).resolves.toBeUndefined();
  });
});
