/**
 * Operator one-off: sets an instance's AI provider and Telegram bot through the same services the customer API
 * uses, for the time before the dashboard Configuration page is wired to them. Run inside the backend image so it
 * has the same KEK and database as production (see docs/setup.md, "Operator setup of one instance").
 *
 * Secrets are read from environment variables, never from arguments, and are never printed:
 *   SETUP_INSTANCE_NAME        instance name (must match exactly one live instance)
 *   SETUP_PROVIDER_BASE_URL    e.g. https://openrouter.ai/api/v1      (provider section skipped if empty)
 *   SETUP_PROVIDER_MODEL
 *   SETUP_PROVIDER_API_KEY
 *   SETUP_TELEGRAM_TOKEN       from @BotFather                        (Telegram section skipped if empty)
 *   SETUP_TELEGRAM_USER_IDS    comma-separated numeric Telegram user ids allowed to talk to the bot
 *   SETUP_NO_RESTART=1         do not restart the instance afterwards
 * Also needs the backend's own DATABASE_URL, SECRETS_KEK and ADMIN_TOKEN (already in its env file).
 */
import { loadConfig } from '../src/config/env.js';
import { createPrisma } from '../src/db/client.js';
import { ProviderService } from '../src/modules/integrations/provider-service.js';
import { TelegramService } from '../src/modules/integrations/telegram-service.js';
import { PrismaSecretStore } from '../src/modules/secrets/secret-store.js';
import { createLogger } from '../src/shared/logger.js';

const env = (k: string) => (process.env[k] ?? '').trim();
const name = env('SETUP_INSTANCE_NAME');
if (!name) { console.error('SETUP_INSTANCE_NAME is required'); process.exit(1); }

const config = loadConfig();
if (!config.secrets) { console.error('SECRETS_KEK is not set: secrets cannot be stored'); process.exit(1); }
const prisma = createPrisma(config.databaseUrl);
const logger = createLogger({ level: 'warn' });
const secrets = new PrismaSecretStore({ prisma, current: config.secrets.current, previous: config.secrets.previous });
const providers = new ProviderService({ prisma, secrets, logger });
const telegram = new TelegramService({ prisma, secrets, logger });

try {
  const found = await prisma.instance.findMany({ where: { name, status: { notIn: ['DELETED', 'DELETING'] } } });
  if (found.length !== 1) { console.error(`expected exactly one live instance named "${name}", found ${found.length}`); process.exit(1); }
  const inst = found[0]!;
  console.log(`instance ${inst.id} (${inst.status})`);

  if (env('SETUP_PROVIDER_API_KEY')) {
    const view = await providers.put(inst.tenantId, inst.id, {
      baseUrl: env('SETUP_PROVIDER_BASE_URL'), model: env('SETUP_PROVIDER_MODEL'), apiKey: env('SETUP_PROVIDER_API_KEY'),
    });
    console.log(`provider saved: ${view.baseUrl} model ${view.model} key ...${view.keyHint ?? ''}`);
    const tested = await providers.test(inst.tenantId, inst.id);
    console.log(`provider test: ${tested.status}${tested.lastErrorCode ? ` (${tested.lastErrorCode})` : ''}`);
  }
  if (env('SETUP_TELEGRAM_TOKEN')) {
    const ids = env('SETUP_TELEGRAM_USER_IDS').split(',').map((s) => s.trim()).filter(Boolean);
    const view = await telegram.put(inst.tenantId, inst.id, { token: env('SETUP_TELEGRAM_TOKEN'), allowedUserIds: ids });
    if (view.configured) console.log(`telegram saved: @${view.botUsername}, ${view.allowedUserIds.length} allowed user(s)`);
    const verified = await telegram.verify(inst.tenantId, inst.id);
    console.log(`telegram verify: ${verified.configured ? verified.status + (verified.lastErrorCode ? ` (${verified.lastErrorCode})` : '') : 'not configured'}`);
  }
  if (env('SETUP_NO_RESTART') !== '1') {
    const res = await fetch(`http://127.0.0.1:${config.port}/api/v1/tenants/${inst.tenantId}/instances/${inst.id}/restart`, {
      method: 'POST', headers: { authorization: `Bearer ${config.adminToken}` },
    });
    console.log(`restart requested: HTTP ${res.status}`);
  }
} finally {
  await prisma.$disconnect();
}
