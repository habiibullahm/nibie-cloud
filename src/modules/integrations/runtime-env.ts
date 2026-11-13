import type { PrismaClient } from '@prisma/client';
import { PROVIDER_KEY_ENV, type ModelConfig } from '../runtime/hermes-config.js';
import type { SecretStore } from '../secrets/secret-store.js';

/** What a container is created with besides the platform defaults. Held in memory only, never logged. */
export interface RuntimeConfig {
  env: Record<string, string>;
  /** `ModelConfig`: write the block. `null`: remove a block the platform wrote. `undefined`: leave the file alone. */
  model: ModelConfig | null | undefined;
  /** The `configRevision` this snapshot corresponds to; stored as `appliedRevision` once applied. */
  revision: number;
}

export type RuntimeConfigLoader = (tenantId: string, instanceId: string) => Promise<RuntimeConfig>;

/** Used when secret storage is not configured: nothing to inject, nothing to touch. */
export const noRuntimeConfig: RuntimeConfigLoader = async () => ({ env: {}, model: undefined, revision: 0 });

/**
 * Reads the instance's Telegram and provider configuration and decrypts their secrets. Worker and
 * reconciler side only. The revision is read before the secrets: if a change lands in between, the
 * container gets the newer secrets with the older revision number, and the next restart simply recreates it
 * once more, which is harmless; the reverse order could mark a stale container as current.
 */
export function createRuntimeConfigLoader(d: { prisma: PrismaClient; secrets: Pick<SecretStore, 'get'> }): RuntimeConfigLoader {
  return async (tenantId, instanceId) => {
    const inst = await d.prisma.instance.findUniqueOrThrow({ where: { id: instanceId }, select: { configRevision: true } });
    const env: Record<string, string> = {};

    const tg = await d.prisma.telegramConnection.findUnique({ where: { instanceId } });
    if (tg) {
      env.TELEGRAM_BOT_TOKEN = await d.secrets.get(tenantId, tg.secretId);
      env.TELEGRAM_ALLOWED_USERS = tg.allowedUserIds.join(',');
    }

    let model: ModelConfig | null = null;
    const provider = await d.prisma.providerConfig.findUnique({ where: { instanceId } });
    if (provider) {
      env[PROVIDER_KEY_ENV] = await d.secrets.get(tenantId, provider.secretId);
      model = { default: provider.model, baseUrl: provider.baseUrl, keyEnv: PROVIDER_KEY_ENV };
    }
    return { env, model, revision: inst.configRevision };
  };
}
