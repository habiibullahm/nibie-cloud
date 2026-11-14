import type Docker from 'dockerode';
import type { Logger } from '../../shared/logger.js';
import type { SupportedRuntime } from './types.js';

/**
 * One volume, shared by every tenant on this node: the resolver list is a node-wide setting
 * (`HERMES_DNS_RESOLVERS`), not a per-instance one. Holds a single file, `resolv.conf`, that a
 * `runsc` tenant container bind-mounts over its own `/etc/resolv.conf` (see `hardening.ts`).
 */
export const DNS_RESOLV_VOLUME = 'hermes-dns-resolv-conf';
export const DNS_RESOLV_SUBPATH = 'resolv.conf';

const SEED_TIMEOUT_MS = 15_000;

/**
 * Static script: nothing from outside is interpolated into it, resolvers arrive as argv (same
 * pattern as the egress canary's `CANARY_SCRIPT`).
 */
export const DNS_RESOLV_SEED_SCRIPT = [
  ': > /dns/resolv.conf',
  'while [ "$#" -ge 1 ]; do',
  '  echo "nameserver $1" >> /dns/resolv.conf',
  '  shift',
  'done',
].join('\n');

export class DnsResolvConfError extends Error {
  constructor(readonly reason: string) {
    super('Could not prepare the tenant DNS resolv.conf volume');
    this.name = 'DnsResolvConfError';
  }
}

function statusCode(e: unknown): number | undefined {
  return (e as { statusCode?: number } | undefined)?.statusCode;
}

/** The slice of dockerode this needs, so tests can pass a fake (same shape as the egress canary's). */
export interface DockerLike {
  getVolume(name: string): { inspect(): Promise<unknown> };
  createVolume(o: { Name: string; Labels?: Record<string, string> }): Promise<unknown>;
  createContainer(o: Docker.ContainerCreateOptions): Promise<{
    start(): Promise<unknown>;
    wait(): Promise<{ StatusCode: number }>;
    remove(o: { force: boolean }): Promise<unknown>;
  }>;
}

/**
 * Writes `resolvers` into the single `resolv.conf` file in `DNS_RESOLV_VOLUME`, creating the volume
 * first if it does not exist. A no-op when there are no resolvers (the `runc` default never calls
 * this). Docker's own embedded resolver, which normally owns a tenant's `/etc/resolv.conf` on a
 * user-defined network, is not reachable from inside a gVisor sandbox (verified on a real `runsc`
 * host, 2026-11-14: `HostConfig.Dns` alone only changes what the embedded resolver forwards to, not
 * what the container itself queries). Bind-mounting this file over the container's own
 * `/etc/resolv.conf` bypasses the embedded resolver entirely instead of trying to make it reachable.
 */
export async function ensureDnsResolvConf(deps: {
  docker: DockerLike;
  image: string;
  resolvers: string[];
  runtime?: SupportedRuntime;
  logger: Logger;
}): Promise<void> {
  const { docker, image, resolvers, runtime, logger } = deps;
  if (resolvers.length === 0) return;
  const fail = (reason: string, e?: unknown): never => {
    // Log only the reason class: Docker text can embed host paths.
    logger.error({ reason, status: statusCode(e) }, 'dns resolv.conf volume could not be prepared');
    throw new DnsResolvConfError(reason);
  };

  try {
    await docker.getVolume(DNS_RESOLV_VOLUME).inspect();
  } catch (e) {
    if (statusCode(e) !== 404) fail('docker_error', e);
    try {
      await docker.createVolume({ Name: DNS_RESOLV_VOLUME, Labels: { 'hermes.cloud/managed': 'true' } });
    } catch (e2) {
      fail('volume_create_failed', e2);
    }
  }

  let container: Awaited<ReturnType<DockerLike['createContainer']>> | undefined;
  let exitCode = 1;
  try {
    try {
      container = await docker.createContainer({
        Image: image,
        Cmd: ['sh', '-c', DNS_RESOLV_SEED_SCRIPT, 'seed', ...resolvers],
        HostConfig: {
          NetworkMode: 'none',
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          ReadonlyRootfs: true,
          Memory: 32 * 1024 * 1024,
          MemorySwap: 32 * 1024 * 1024,
          // gVisor's own sandbox threads count against this limit (same fix as the egress canary).
          PidsLimit: runtime === 'runsc' ? 256 : 32,
          Mounts: [{ Target: '/dns', Source: DNS_RESOLV_VOLUME, Type: 'volume' }],
          ...(runtime ? { Runtime: runtime } : {}),
        },
      });
      await container.start();
      const status = await Promise.race([
        container.wait(),
        new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('timeout')), SEED_TIMEOUT_MS).unref(); }),
      ]);
      exitCode = status.StatusCode;
    } catch (e) {
      fail('container_failed', e);
    }
    if (exitCode !== 0) fail('seed_failed');
  } finally {
    // Cleanup never throws and never logs Docker text; the volume itself is left in place, it is shared.
    if (container) await container.remove({ force: true }).catch(() => { logger.warn({ reason: 'container_remove_failed' }, 'dns resolv.conf seed cleanup failed'); });
  }
  logger.info({ resolvers: resolvers.length }, 'tenant dns resolv.conf ready');
}
