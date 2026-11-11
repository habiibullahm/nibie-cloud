import Docker from 'dockerode';
import { loadConfig } from './config/env.js';
import { createPrisma } from './db/client.js';
import { buildServer } from './http/server.js';
import { InstanceService } from './modules/instances/instance-service.js';
import { Reconciler } from './modules/instances/reconciler.js';
import { DockerRuntimeManager } from './modules/runtime/docker-runtime-manager.js';
import { createLogger } from './shared/logger.js';

const config = loadConfig();
const logger = createLogger();
const prisma = createPrisma(config.databaseUrl);
const runtime = new DockerRuntimeManager({ docker: new Docker({ socketPath: config.dockerSocketPath }), logger });
const service = new InstanceService({
  prisma, runtime, image: config.hermesImage, production: config.nodeEnv === 'production', logger,
});
const reconciler = new Reconciler({ prisma, runtime, logger });
const app = buildServer({ service, config, logger });

const stopReconciler = reconciler.start(15_000);
// Loopback only: this operator API must not be reachable from the network.
await app.listen({ host: '127.0.0.1', port: config.port });

async function shutdown() {
  stopReconciler();
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
