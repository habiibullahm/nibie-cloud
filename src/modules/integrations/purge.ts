import type { PrismaClient } from '@prisma/client';
import type { SecretStore } from '../secrets/secret-store.js';

/**
 * Deletes an instance's provider and Telegram configuration and the ciphertext behind them (PRD 10: delete
 * associated secrets). Called only after the runtime removal succeeded, so a failed deletion never strips a
 * live instance of its credentials. Idempotent. The audit event carries no values.
 */
export async function purgeIntegrations(d: { prisma: PrismaClient; secrets: Pick<SecretStore, 'deleteMany'> }, tenantId: string, instanceId: string): Promise<void> {
  await d.prisma.$transaction(async (tx) => {
    const tg = await tx.telegramConnection.findUnique({ where: { instanceId } });
    const provider = await tx.providerConfig.findUnique({ where: { instanceId } });
    const secretIds = [tg?.secretId, provider?.secretId].filter((x): x is string => typeof x === 'string');
    if (secretIds.length === 0) return;
    if (tg) await tx.telegramConnection.delete({ where: { instanceId } });
    if (provider) await tx.providerConfig.delete({ where: { instanceId } });
    await d.secrets.deleteMany(tenantId, secretIds, tx);
    await tx.instanceEvent.create({ data: { instanceId, type: 'secrets.purged', message: 'Credentials removed' } });
  });
}
