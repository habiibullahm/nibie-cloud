import type { PrismaClient } from '@prisma/client';
import { NotFoundError } from '../../shared/errors.js';
import { deriveApiKey } from '../runtime/api-key.js';
import type { RuntimeManager } from '../runtime/types.js';
import { redactLines } from './redact.js';
import type { RuntimeConfigLoader } from './runtime-env.js';

export const MAX_LOG_LINES = 500;

/**
 * Read-only container logs for the customer (PRD 15.3), with this instance's own credentials and common
 * token shapes scrubbed. The secrets are decrypted only to know what to remove, held in memory for the call,
 * and never returned.
 */
export class LogService {
  constructor(private readonly d: { prisma: PrismaClient; runtime: Pick<RuntimeManager, 'logs'>; loader: RuntimeConfigLoader; masterKey: string }) {}

  async tail(tenantId: string, instanceId: string, requested: number): Promise<string[]> {
    const inst = await this.d.prisma.instance.findFirst({ where: { id: instanceId, tenantId, deletedAt: null }, select: { id: true } });
    if (!inst) throw new NotFoundError('Instance not found');
    const tail = Math.max(1, Math.min(Math.floor(requested) || 100, MAX_LOG_LINES));
    const raw = await this.d.runtime.logs(instanceId, { tail });
    const cfg = await this.d.loader(tenantId, instanceId);
    const known = [...Object.values(cfg.env), deriveApiKey(this.d.masterKey, instanceId)];
    return redactLines(raw.slice(-tail), known);
  }
}
