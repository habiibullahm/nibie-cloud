import Docker from 'dockerode';
import type { Logger } from '../../shared/logger.js';
import { assertDiskQuotaSupported } from './disk-quota-check.js';
import { ensureDnsResolvConf } from './dns-resolv-conf.js';
import { DockerRuntimeManager } from './docker-runtime-manager.js';
import { runEgressCanary } from './egress-canary.js';
import { assertRuntimeAvailable } from './runtime-availability.js';
import type { DiskQuotaMode, EgressPolicyMode, SupportedRuntime } from './types.js';

export interface HostRuntimeConfig {
  dockerSocketPath: string;
  runtime: SupportedRuntime;
  diskQuota: DiskQuotaMode;
  egressPolicy: EgressPolicyMode;
  canaryImage?: string;
  canaryPrivateIp?: string;
  dnsResolvers: string[];
}

export async function openHostRuntime(config: HostRuntimeConfig, logger: Logger) {
  const docker = new Docker({ socketPath: config.dockerSocketPath });
  await assertRuntimeAvailable(docker, config.runtime);
  await assertDiskQuotaSupported(docker, config.diskQuota);
  if (config.egressPolicy === 'enforce') {
    if (!config.canaryImage) throw new Error('The host egress canary image is required');
    await runEgressCanary({ docker, image: config.canaryImage, privateIp: config.canaryPrivateIp, runtime: config.runtime, logger });
  }
  if (config.runtime === 'runsc') {
    if (!config.canaryImage || config.dnsResolvers.length === 0) throw new Error('The runsc DNS configuration is required');
    await ensureDnsResolvConf({ docker, image: config.canaryImage, resolvers: config.dnsResolvers, runtime: config.runtime, logger });
  }
  return { docker, runtime: new DockerRuntimeManager({ docker, logger }) };
}
