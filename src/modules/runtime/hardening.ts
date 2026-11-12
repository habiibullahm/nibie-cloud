import type Docker from 'dockerode';
import { ValidationError } from '../../shared/errors.js';
import type { RuntimeSpec } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CONTAINER_PORT = 8642;
export const DATA_MOUNT = '/opt/data';
export const LABEL_MANAGED = 'hermes.cloud/managed';
export const LABEL_INSTANCE = 'hermes.cloud/instance-id';
export const LABEL_TENANT = 'hermes.cloud/tenant-id';

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
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'],
    Memory: memoryMb * 1048576,
    MemorySwap: memoryMb * 1048576,
    NanoCpus: cpuMillis * 1_000_000,
    PidsLimit: pids,
    Init: false, // Official image uses internal s6-overlay /init dispatcher
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
