import Docker from 'dockerode';
import { loadConfig } from './config/env.js';
import { createPrisma } from './db/client.js';
import { buildServer } from './http/server.js';
import { InstanceService } from './modules/instances/instance-service.js';
import { DiskMonitor } from './modules/instances/disk-monitor.js';
import { Reconciler } from './modules/instances/reconciler.js';
import { DockerRuntimeManager } from './modules/runtime/docker-runtime-manager.js';
import { assertDiskQuotaSupported } from './modules/runtime/disk-quota-check.js';
import { assertRuntimeAvailable } from './modules/runtime/runtime-availability.js';
import { createLogger } from './shared/logger.js';

const config = loadConfig();
const logger = createLogger();
const prisma = createPrisma(config.databaseUrl);
const docker = new Docker({ socketPath: config.dockerSocketPath });
await assertRuntimeAvailable(docker, config.runtime);
await assertDiskQuotaSupported(docker, config.diskQuota);
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
