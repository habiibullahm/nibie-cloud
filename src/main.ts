import Docker from 'dockerode';
import { loadConfig } from './config/env.js';
import { createPrisma } from './db/client.js';
import { buildServer } from './http/server.js';
import { IdentityService } from './modules/auth/identity-service.js';
import { createTokenVerifier } from './modules/auth/token-verifier.js';
import { InstanceService } from './modules/instances/instance-service.js';
import { DiskMonitor } from './modules/instances/disk-monitor.js';
import { InstanceCommands } from './modules/instances/instance-commands.js';
import { LogService } from './modules/integrations/log-service.js';
import { ProviderService } from './modules/integrations/provider-service.js';
import { purgeIntegrations } from './modules/integrations/purge.js';
import { createRuntimeConfigLoader, noRuntimeConfig } from './modules/integrations/runtime-env.js';
import { TelegramService } from './modules/integrations/telegram-service.js';
import type { Integrations } from './modules/integrations/types.js';
import { createNibieRouterClient } from './modules/nibierouter/nibierouter-client.js';
import { RouterProvisioner } from './modules/nibierouter/router-provisioner.js';
import { PrismaSecretStore } from './modules/secrets/secret-store.js';
import { createBullQueue } from './modules/jobs/bullmq-queue.js';
import { startScheduler } from './modules/jobs/scheduler.js';
import { sweepPending } from './modules/jobs/sweeper.js';
import { createInstanceWorker } from './modules/jobs/worker.js';
import { BillingService } from './modules/billing/billing-service.js';
import { BillingTick } from './modules/billing/billing-tick.js';
import { createDuitkuClient } from './modules/billing/duitku-client.js';
import { createMailer } from './modules/billing/mailer.js';
import { Reconciler } from './modules/instances/reconciler.js';
import { DockerRuntimeManager } from './modules/runtime/docker-runtime-manager.js';
import { assertDiskQuotaSupported } from './modules/runtime/disk-quota-check.js';
import { DnsResolvConfError, ensureDnsResolvConf } from './modules/runtime/dns-resolv-conf.js';
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
    await runEgressCanary({ docker, image: config.canaryImage!, privateIp: config.canaryPrivateIp, runtime: config.runtime, logger });
  } catch (e) {
    if (e instanceof EgressPolicyError || e instanceof EgressCanaryError) logger.error(e.message);
    else logger.error('Egress canary failed unexpectedly');
    process.exit(1);
  }
}
if (config.runtime === 'runsc' && config.dnsResolvers.length > 0) {
  // Without this, tenant containers under runsc get no working DNS (see dns-resolv-conf.ts).
  try {
    await ensureDnsResolvConf({ docker, image: config.canaryImage!, resolvers: config.dnsResolvers, runtime: config.runtime, logger });
  } catch (e) {
    if (e instanceof DnsResolvConfError) logger.error(e.message);
    else logger.error('Tenant DNS resolv.conf setup failed unexpectedly');
    process.exit(1);
  }
}
const runtime = new DockerRuntimeManager({ docker, logger });
// Credential storage exists only when a key-encryption key is configured; otherwise the provider and
// Telegram routes answer 503 and containers are created without customer configuration.
const secretStore = config.secrets
  ? new PrismaSecretStore({ prisma, current: config.secrets.current, previous: config.secrets.previous })
  : null;
const runtimeConfig = secretStore ? createRuntimeConfigLoader({ prisma, secrets: secretStore }) : noRuntimeConfig;
const integrations: Integrations | null = secretStore && config.secrets
  ? {
      secrets: secretStore,
      kekVersion: config.secrets.current.version,
      telegram: new TelegramService({ prisma, secrets: secretStore, logger }),
      providers: new ProviderService({ prisma, secrets: secretStore, logger }),
    }
  : null;
logger.info({ secretStore: secretStore !== null }, 'secret storage');
const purge = secretStore ? (tenantId: string, instanceId: string) => purgeIntegrations({ prisma, secrets: secretStore }, tenantId, instanceId) : undefined;
const logService = new LogService({ prisma, runtime, loader: runtimeConfig, masterKey: config.masterKey });
const service = new InstanceService({
  prisma, runtime, image: config.hermesImage, production: config.nodeEnv === 'production', logger,
  masterKey: config.masterKey, containerRuntime: config.runtime, dnsResolvers: config.dnsResolvers, diskQuota: config.diskQuota, egressPolicy: config.egressPolicy, runtimeConfig, ...(purge ? { purgeIntegrations: purge } : {}),
});
// With a job queue the sweeper owns PENDING rows; the reaper must not fail them first.
const reconciler = new Reconciler({ prisma, runtime, logger, masterKey: config.masterKey, containerRuntime: config.runtime, dnsResolvers: config.dnsResolvers, diskQuota: config.diskQuota, egressPolicy: config.egressPolicy, reapPending: config.redisUrl === null, runtimeConfig, ...(purge ? { purgeIntegrations: purge } : {}) });
// The customer API exists only when a Supabase project is configured.
const customer = config.supabaseUrl
  ? { verify: createTokenVerifier({ supabaseUrl: config.supabaseUrl }), identity: new IdentityService({ prisma }), prisma }
  : undefined;
logger.info({ customerApi: customer !== undefined }, 'customer API');
// With REDIS_URL, operations are jobs and the reconciler is a scheduled job; without it, everything runs inline.
const queue = config.redisUrl ? createBullQueue({ redisUrl: config.redisUrl, logger }) : null;
const commands = new InstanceCommands({ service, queue, logger });
logger.info({ jobQueue: queue !== null }, 'job queue');
// Duitku billing exists only when its credentials are configured; otherwise checkout and the callback are 404.
const mailer = createMailer(config.mail, logger);
// NibieRouter key and credit need the admin key and a place to keep the encrypted instance key (SECRETS_KEK).
const router = config.router && integrations
  ? new RouterProvisioner({ prisma, client: createNibieRouterClient(config.router), providers: integrations.providers, cfg: config.router, logger, applyConfig: (t, i) => commands.restart(t, i) })
  : null;
if (config.router && !integrations) logger.warn('NibieRouter is configured but SECRETS_KEK is not: instance keys cannot be stored, provisioning is off');
logger.info({ router: router !== null }, 'nibierouter');
const billing = config.billing && config.dashboardOrigin
  ? new BillingService({
      prisma, duitku: createDuitkuClient(config.billing), billing: config.billing, commands, mailer,
      dashboardOrigin: config.dashboardOrigin, maxInstancesPerTenant: config.maxInstancesPerTenant, logger,
      ...(router ? { router } : {}),
    })
  : null;
const billingTick = billing ? new BillingTick({ prisma, billing, commands, mailer, logger, ...(router ? { router } : {}) }) : null;
logger.info({ billing: billing !== null, billingEnv: config.billing?.env ?? null, mail: mailer.enabled }, 'billing');
const app = buildServer({ service, commands, queue, config, logger, integrations, logs: logService, billing, ...(customer ? { customer } : {}) });

let stopReconciler: () => void | Promise<void> = () => undefined;
let stopWorker: (() => Promise<void>) | undefined;
if (config.redisUrl && queue) {
  const redisUrl = config.redisUrl;
  stopWorker = createInstanceWorker({ redisUrl, service, logger }).close;
  // Returns at once: if Redis is down at boot the API still starts, the schedule registers when Redis
  // returns, and until then this process reconciles on its own timer.
  // The billing tick rides on the same locked maintenance run (it throttles itself to once per 5 minutes).
  const maintenance = {
    reconcileAll: async () => {
      await reconciler.reconcileAll();
      await billingTick?.run();
    },
  };
  const scheduler = startScheduler({
    redisUrl, reconciler: maintenance, intervalMs: 15_000, logger,
    sweep: () => sweepPending({ prisma, queue, olderThanMs: 30_000 }),
  });
  stopReconciler = () => scheduler.stop();
} else {
  const stopRec = reconciler.start(15_000);
  const billingTimer = billingTick ? setInterval(() => void billingTick.run(), 60_000) : null;
  billingTimer?.unref();
  stopReconciler = () => {
    if (billingTimer) clearInterval(billingTimer);
    return stopRec();
  };
}
const stopDiskMonitor = new DiskMonitor({ prisma, runtime, logger }).start(config.diskCheckIntervalMs);
// Loopback only: this operator API must not be reachable from the network.
await app.listen({ host: '127.0.0.1', port: config.port });

async function shutdown() {
  // Whatever hangs (a dead Redis, a stuck Docker call), the process still exits.
  setTimeout(() => process.exit(1), 30_000).unref();
  await app.close().catch(() => undefined); // stop taking requests first
  await Promise.allSettled([Promise.resolve(stopReconciler()), stopWorker?.(), queue?.close()]);
  stopDiskMonitor();
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
