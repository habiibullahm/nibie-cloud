import type Docker from 'dockerode';
import { ValidationError } from '../../shared/errors.js';
import type { RuntimeSpec } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CONTAINER_PORT = 8642;
export const DATA_MOUNT = '/opt/data';
export const LABEL_MANAGED = 'hermes.cloud/managed';
export const LABEL_INSTANCE = 'hermes.cloud/instance-id';
export const LABEL_TENANT = 'hermes.cloud/tenant-id';

/**
 * Capabilities the official `nousresearch/hermes-agent` image needs from its s6-overlay init.
 * Empirically determined on nibie-cloud (Milestone 2.2 canary matrix): with `CapDrop: ['ALL']`
 * and nothing re-added, cont-init dies with
 *   s6-applyuidgid: fatal: unable to set supplementary group list: Operation not permitted
 *   chown: changing ownership of '/run/hermes-service': Operation not permitted
 * and the container exit-loops. Adding exactly these eight makes the gateway reach ACTIVE with
 * authenticated HTTP 200. Removing any of SETUID/SETGID/CHOWN/DAC_OVERRIDE/FOWNER breaks boot.
 */
export const S6_REQUIRED_CAPS = [
  'SETUID',
  'SETGID',
  'CHOWN',
  'DAC_OVERRIDE',
  'FOWNER',
  'KILL',
  'AUDIT_WRITE',
  'SETFCAP',
] as const;

/**
 * tmpfs mounts required for a read-only root filesystem. s6-overlay writes its supervision tree
 * to /run and its service definitions under /var/run; without these a `--read-only` container
 * dies with `s6-rmrf: fatal: unable to remove /run/s6: Read-only file system` (verified).
 */
export const S6_TMPFS: Record<string, string> = {
  '/run': 'rw,exec,nosuid,size=64m',
  '/tmp': 'rw,noexec,nosuid,size=64m',
  '/var/run': 'rw,exec,nosuid,size=16m',
};

function uuid(id: string): string {
  if (!UUID.test(id)) throw new ValidationError('Invalid instance id');
  return id.toLowerCase();
}

/** Docker resource names derive only from instance UUIDs, never customer text. */
export const containerName = (id: string): string => `hermes-${uuid(id)}`;
export const volumeName = (id: string): string => `hermes-data-${uuid(id)}`;
export const networkName = (id: string): string => `hermes-net-${uuid(id)}`;

export function buildContainerConfig(spec: RuntimeSpec): Docker.ContainerCreateOptions {
  const id = uuid(spec.instanceId);
  uuid(spec.tenantId);
  const { cpuMillis, memoryMb, pids } = spec.limits;
  if (!Number.isInteger(cpuMillis) || cpuMillis < 50) throw new ValidationError('cpuMillis must be an integer >= 50');
  if (!Number.isInteger(memoryMb) || memoryMb < 32) throw new ValidationError('memoryMb must be an integer >= 32');
  if (!Number.isInteger(pids) || pids < 8) throw new ValidationError('pids must be an integer >= 8');

  for (const key of Object.keys(spec.env)) {
    if (/^DOCKER_/i.test(key)) throw new ValidationError('Environment key not allowed');
  }

  const envMap: Record<string, string> = { ...spec.env };
  if (!envMap.API_SERVER_HOST) {
    envMap.API_SERVER_HOST = '0.0.0.0';
  }
  if (!envMap.API_SERVER_PORT) {
    envMap.API_SERVER_PORT = String(CONTAINER_PORT);
  }
  if (spec.apiServerKey && !envMap.API_SERVER_KEY) {
    envMap.API_SERVER_KEY = spec.apiServerKey;
  }

  const hostConfig: Docker.HostConfig = {
      Privileged: false,
      // The official image's s6-overlay init must create /run/hermes-service, drop privileges to
      // hermes (10000:10000) and chown the data volume. Those are exactly these capabilities,
      // verified by canary matrix on nibie-cloud (drop-all alone exit-loops with
      // "s6-applyuidgid: unable to set supplementary group list").
      CapDrop: ['ALL'],
      CapAdd: [...S6_REQUIRED_CAPS],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      Tmpfs: { ...S6_TMPFS },
      Memory: memoryMb * 1048576,
      MemorySwap: memoryMb * 1048576,
      NanoCpus: cpuMillis * 1_000_000,
      PidsLimit: pids,
      // Never `true`: the image is PID 1 with its own s6-overlay dispatcher.
      Init: false,
      RestartPolicy: { Name: 'no' },
      Binds: [`${volumeName(id)}:${DATA_MOUNT}`],
      NetworkMode: networkName(id),
      PortBindings: { [`${CONTAINER_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '0' }] },
    };

  if (spec.runtime) {
    hostConfig.Runtime = spec.runtime;
  }

  return {
    name: containerName(id),
    Image: spec.image,
    Cmd: ['gateway', 'run'],
    Env: Object.entries(envMap).map(([k, v]) => `${k}=${v}`),
    ExposedPorts: { [`${CONTAINER_PORT}/tcp`]: {} },
    Labels: {
      [LABEL_MANAGED]: 'true',
      [LABEL_INSTANCE]: id,
      [LABEL_TENANT]: spec.tenantId.toLowerCase(),
    },
    HostConfig: hostConfig,
  };
}
