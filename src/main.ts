import Docker from 'dockerode';
import { loadConfig } from './config/env.js';
import { createPrisma } from './db/client.js';
import { buildServer } from './http/server.js';
import { InstanceService } from './modules/instances/instance-service.js';
import { DiskMonitor } from './modules/instances/disk-monitor.js';
import { Reconciler } from './modules/instances/reconciler.js';
import { DockerRuntimeManager } from './modules/runtime/docker-runtime-manager.js';
import { assertDiskQuotaSupported } from './modules/runtime/disk-quota-check.js';
import { EgressCanaryError, EgressPolicyError, runEgressCanary } from './modules/runtime/egress-canary.js';
import { assertRuntimeAvailable } from './modules/runtime/runtime-availability.js';
import { createLogger } from './shared/logger.js';

const config = loadConfig();
const logger = createLogger();
const prisma = createPrisma(config.databaseUrl);
const docker = new Docker({ socketPath: config.dockerSocketPath });
await assertRuntimeAvailable(docker, config.runtime);
await assertDiskQuotaSupported(docker, config.diskQuota);
if (config.egressPolicy === 'enforce') {
  // Refuse to serve tenants when the host ruleset is missing: the error names the failed check only.
  try {
    await runEgressCanary({ docker, image: config.canaryImage!, privateIp: config.canaryPrivateIp, logger });
  } catch (e) {
    if (e instanceof EgressPolicyError || e instanceof EgressCanaryError) logger.error(e.message);
    else logger.error('Egress canary failed unexpectedly');
    process.exit(1);
  }
}
const runtime = new DockerRuntimeManager({ docker, logger });
const service = new InstanceService({
  prisma, runtime, image: config.hermesImage, production: config.nodeEnv === 'production', logger,
  masterKey: config.masterKey, containerRuntime: config.runtime, diskQuota: config.diskQuota, egressPolicy: config.egressPolicy,
});
const reconciler = new Reconciler({ prisma, runtime, logger, masterKey: config.masterKey, containerRuntime: config.runtime, diskQuota: config.diskQuota, egressPolicy: config.egressPolicy });
const app = buildServer({ service, config, logger });

const stopReconciler = reconciler.start(15_000);
const stopDiskMonitor = new DiskMonitor({ prisma, runtime, logger }).start(config.diskCheckIntervalMs);
// Loopback only: this operator API must not be reachable from the network.
await app.listen({ host: '127.0.0.1', port: config.port });

async function shutdown() {
  stopReconciler();
  stopDiskMonitor();
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
