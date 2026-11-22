import { Redis } from 'ioredis';
import 'dotenv/config';
import { loadConfig } from './config/env.js';
import { createPrisma } from './db/client.js';
import { buildServer } from './http/server.js';
import { IdentityService } from './modules/auth/identity-service.js';
import { createTokenVerifier } from './modules/auth/token-verifier.js';
import { AuditService } from './modules/admin/audit-service.js';
import { InstanceService } from './modules/instances/instance-service.js';
import { DiskMonitor } from './modules/instances/disk-monitor.js';
import { InstanceCommands } from './modules/instances/instance-commands.js';
import { LogService } from './modules/integrations/log-service.js';
import { NIBIEROUTER_BASE_URL, ProviderService } from './modules/integrations/provider-service.js';
import { purgeIntegrations } from './modules/integrations/purge.js';
import { createRuntimeConfigLoader, noRuntimeConfig } from './modules/integrations/runtime-env.js';
import { TelegramService } from './modules/integrations/telegram-service.js';
import type { Integrations } from './modules/integrations/types.js';
import { createModelCatalog } from './modules/nibierouter/model-catalog.js';
import { createNibieRouterClient } from './modules/nibierouter/nibierouter-client.js';
import { AiAccountService } from './modules/nibierouter/ai-account.js';
import { RouterProvisioner } from './modules/nibierouter/router-provisioner.js';
import { PrismaSecretStore } from './modules/secrets/secret-store.js';
import { createBullQueue } from './modules/jobs/bullmq-queue.js';
import { startScheduler } from './modules/jobs/scheduler.js';
import { sweepPending } from './modules/jobs/sweeper.js';
import { createInstanceWorker } from './modules/jobs/worker.js';
import { BillingService } from './modules/billing/billing-service.js';
import { BillingTick } from './modules/billing/billing-tick.js';
import { createSumoPodClient } from './modules/billing/sumopod-client.js';
import { createMailer } from './modules/billing/mailer.js';
import { WaitlistInviter } from './modules/waitlist/waitlist-inviter.js';
import { createTurnstileVerifier } from './modules/waitlist/turnstile.js';
import { Reconciler } from './modules/instances/reconciler.js';
import { AlertScanner } from './modules/ops/alert-scanner.js';
import { PrismaAlertStore } from './modules/ops/alert-store.js';
import { Alerter } from './modules/ops/alerter.js';
import { createTelegramSink } from './modules/ops/telegram-sink.js';
import { openHostRuntime } from './modules/runtime/host-runtime.js';
import { RuntimeFleet } from './modules/runtime/fleet.js';
import { NodeScheduler } from './modules/instances/node-scheduler.js';
import { NodeRecovery, retireDeletedCopies } from './modules/instances/node-recovery.js';
import { createLogger } from './shared/logger.js';

const config = loadConfig();
const logger = createLogger();
const prisma = createPrisma(config.databaseUrl);
const { docker, runtime: local } = await openHostRuntime(config, logger);
const fleet = process.env.HERMES_RUNTIME_FLEET_FILE?.trim()
  ? await RuntimeFleet.open({ file: process.env.HERMES_RUNTIME_FLEET_FILE, prisma, local, ping: () => docker.ping() })
  : undefined;
if (!fleet && await prisma.runtimeNode.findFirst({
  where: {
    agentManaged: true,
    OR: [{ schedulable: true }, { instances: { some: { status: { not: 'DELETED' } } } }, { recoveryCopies: { some: {} } }, { retiredCopies: { some: {} } }],
  },
  select: { id: true },
})) {
  throw new Error('Fleet configuration is required while remote nodes are enabled or host instances');
}
const runtime = fleet ?? local;
const placement = fleet ? new NodeScheduler(() => fleet.placementNodes()) : undefined;
// Credential storage exists only when a key-encryption key is configured; otherwise the provider and
// Telegram routes answer 503 and containers are created without customer configuration.
const secretStore = config.secrets
  ? new PrismaSecretStore({ prisma, current: config.secrets.current, previous: config.secrets.previous })
  : null;
const runtimeConfig = secretStore ? createRuntimeConfigLoader({ prisma, secrets: secretStore }) : noRuntimeConfig;
// One copy of the router's public model list, shared by the instance model picker and the customer's AI models page.
const modelCatalog = createModelCatalog({ url: `${NIBIEROUTER_BASE_URL}/models` });
const integrations: Integrations | null = secretStore && config.secrets
  ? {
      secrets: secretStore,
      kekVersion: config.secrets.current.version,
      telegram: new TelegramService({ prisma, secrets: secretStore, logger }),
      providers: new ProviderService({ prisma, secrets: secretStore, logger, catalog: modelCatalog }),
    }
  : null;
logger.info({ secretStore: secretStore !== null }, 'secret storage');
const purge = secretStore ? (tenantId: string, instanceId: string) => purgeIntegrations({ prisma, secrets: secretStore }, tenantId, instanceId) : undefined;
const retireCopies = fleet ? (instanceId: string) => retireDeletedCopies({ prisma, fleet, logger }, instanceId) : undefined;
const logService = new LogService({ prisma, runtime, loader: runtimeConfig, masterKey: config.masterKey });
const service = new InstanceService({
  prisma, runtime, image: config.hermesImage, production: config.nodeEnv === 'production', logger,
  masterKey: config.masterKey, containerRuntime: config.runtime, dnsResolvers: config.dnsResolvers, diskQuota: config.diskQuota, egressPolicy: config.egressPolicy, runtimeConfig, placement, localNodeId: fleet?.localNodeId(), ...(purge ? { purgeIntegrations: purge } : {}), ...(retireCopies ? { retireCopies } : {}),
});
// With a job queue the sweeper owns PENDING rows; the reaper must not fail them first.
const reconciler = new Reconciler({ prisma, runtime, logger, masterKey: config.masterKey, containerRuntime: config.runtime, dnsResolvers: config.dnsResolvers, diskQuota: config.diskQuota, egressPolicy: config.egressPolicy, reapPending: config.redisUrl === null, runtimeConfig, ...(purge ? { purgeIntegrations: purge } : {}), ...(retireCopies ? { retireCopies } : {}) });
// The customer API exists only when a Supabase project is configured.
const customer = config.supabaseUrl
  ? { verify: createTokenVerifier({ supabaseUrl: config.supabaseUrl }), identity: new IdentityService({ prisma }), prisma, fleet }
  : undefined;
logger.info({ customerApi: customer !== undefined }, 'customer API');
// With REDIS_URL, operations are jobs and the reconciler is a scheduled job; without it, everything runs inline.
const queue = config.redisUrl ? createBullQueue({ redisUrl: config.redisUrl, logger }) : null;
const commands = new InstanceCommands({ service, queue, logger });
logger.info({ jobQueue: queue !== null }, 'job queue');
const mailer = createMailer(config.mail, logger);
const routerClient = config.router ? createNibieRouterClient(config.router) : null;
// Balance, usage and the AI credit rate need only the admin key (no stored instance key).
// Buying AI credit takes Rupiah from the wallet, so it exists only with the wallet on.
const ai = routerClient ? new AiAccountService({ prisma, client: routerClient, logger, buy: config.walletEnabled === true, catalog: modelCatalog }) : null;
// NibieRouter key and credit need the admin key and a place to keep the encrypted instance key (SECRETS_KEK).
const router = config.router && integrations
  ? new RouterProvisioner({ prisma, client: routerClient!, providers: integrations.providers, cfg: config.router, logger, applyConfig: (t, i) => commands.restart(t, i) })
  : null;
if (config.router && !integrations) logger.warn('NibieRouter is configured but SECRETS_KEK is not: instance keys cannot be stored, provisioning is off');
logger.info({ router: router !== null }, 'nibierouter');
// Billing (SumoPod) exists only when it is configured; otherwise checkout and the webhook are 404.
const billing = config.billing && config.dashboardOrigin
  ? new BillingService({
      prisma,
      paymentClient: createSumoPodClient(config.billing.sumopod),
      sumopodAuth: { webhookToken: config.billing.sumopod.webhookToken, webhookSecret: config.billing.sumopod.webhookSecret ?? null },
      commands, mailer, placement,
      dashboardOrigin: config.dashboardOrigin, maxInstancesPerTenant: config.maxInstancesPerTenant, maxTotalInstances: config.maxTotalInstances, logger,
      ...(router ? { router } : {}),
      walletEnabled: config.walletEnabled === true,
      walletAutoRenew: config.walletEnabled === true && config.walletAutoRenew === true,
    })
  : null;
const billingTick = billing
  ? new BillingTick({
      prisma, billing, commands, mailer, logger, ...(router ? { router } : {}), ...(ai ? { ai } : {}),
      autoRenew: config.walletEnabled === true && config.walletAutoRenew === true,
    })
  : null;
// Automatic waiting list: invites the oldest waiting entry whenever a free beta slot opens. Needs the free slots and email.
const waitlistInviter = customer && config.freeBetaSlots > 0
  ? new WaitlistInviter({ prisma, mailer, logger, slots: config.freeBetaSlots, placement, registerUrl: `${config.dashboardOrigin ?? 'https://cloud.nibie.app'}/dashboard/register` })
  : null;
// Captcha on the public waiting-list form (the same Turnstile widget as the dashboard sign-up).
const captcha = config.turnstileSecret ? createTurnstileVerifier({ secret: config.turnstileSecret }) : null;
logger.info({ waitlist: waitlistInviter !== null, mail: mailer.enabled, captcha: captcha !== null }, 'waiting list');
logger.info({ billing: billing !== null, mail: mailer.enabled }, 'billing');
// The admin API exists only when a Supabase project is configured: it authenticates the same tokens
// the customer API does. An empty ADMIN_EMAILS opens it to nobody (fail closed).
const admin = customer
  ? { verify: customer.verify, prisma, audit: new AuditService({ prisma }), queue, fleet }
  : undefined;
logger.info({ adminApi: admin !== undefined, adminEmails: config.adminEmails.length }, 'admin API');
// Operator alerts: derived from state the platform already records, delivered to the owner's Telegram.
const alertStore = new PrismaAlertStore(prisma);
const alerter = new Alerter({ store: alertStore, logger, sink: config.ops?.telegram ? createTelegramSink(config.ops.telegram) : null });
const alertScanner = new AlertScanner({ prisma, alerter, store: alertStore, logger, ...(queue ? { failedJobs: () => queue.listFailed() } : {}) });
logger.info({ alertChannel: alerter.enabled }, 'operator alerts');
// Dependency checks behind the loopback-only /readyz that the host watchdog polls.
const readyRedis = config.redisUrl ? new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false }) : null;
const readiness = {
  database: async () => { await prisma.$queryRaw`select 1`; },
  docker: async () => { await docker.ping(); },
  ...(readyRedis ? { redis: async () => { if (readyRedis.status === 'wait') await readyRedis.connect(); await readyRedis.ping(); } } : {}),
};
const nodes = fleet && placement ? {
  prisma, fleet, placement, recovery: new NodeRecovery({
    prisma, fleet, placement, loadConfig: runtimeConfig,
    config: { masterKey: config.masterKey, diskQuota: config.diskQuota, egressPolicy: config.egressPolicy, containerRuntime: config.runtime, dnsResolvers: config.dnsResolvers },
  }),
} : undefined;
const app = buildServer({ service, commands, queue, config, logger, integrations, logs: logService, billing, readiness, mailer, captcha, ai, router, nodes, ...(customer ? { customer } : {}), ...(admin ? { admin } : {}) });

let stopReconciler: () => void | Promise<void> = () => undefined;
let stopWorker: (() => Promise<void>) | undefined;
if (config.redisUrl && queue) {
  const redisUrl = config.redisUrl;
  stopWorker = createInstanceWorker({ redisUrl, service, logger }).close;
  // Returns at once: if Redis is down at boot the API still starts, the schedule registers when Redis
  // returns, and until then this process reconciles on its own timer.
  // The billing tick rides on the same locked maintenance run (it throttles itself to once per 5 minutes).
  // New free instances get their NibieRouter key on every run, so they do not wait for the billing tick.
  const maintenance = {
    reconcileAll: async () => {
      await reconciler.reconcileAll();
      await router?.runNewFree();
      await billingTick?.run();
      await waitlistInviter?.run();
      await alertScanner.run();
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
  const waitlistTimer = waitlistInviter ? setInterval(() => void waitlistInviter.run(), 60_000) : null;
  waitlistTimer?.unref();
  const alertTimer = setInterval(() => void alertScanner.run(), 60_000);
  alertTimer.unref();
  const routerTimer = router ? setInterval(() => void router.runNewFree(), 15_000) : null;
  routerTimer?.unref();
  stopReconciler = () => {
    if (routerTimer) clearInterval(routerTimer);
    if (billingTimer) clearInterval(billingTimer);
    if (waitlistTimer) clearInterval(waitlistTimer);
    clearInterval(alertTimer);
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
  await Promise.allSettled([Promise.resolve(stopReconciler()), stopWorker?.(), queue?.close(), readyRedis?.quit()]);
  stopDiskMonitor();
  fleet?.close();
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
