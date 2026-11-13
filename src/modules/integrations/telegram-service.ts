import { Prisma, type PrismaClient } from '@prisma/client';
import { ConflictError, NotFoundError, OutboundFailedError, ValidationError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import type { SecretStore } from '../secrets/secret-store.js';
import { defaultFetcher, type Fetcher } from './fetcher.js';

export type { Fetcher } from './fetcher.js';

const API_HOST = 'api.telegram.org';
/** BotFather format: numeric bot id, colon, 30 to 50 url-safe characters. Checked before the token is put in a URL. */
const TOKEN_FORMAT = /^\d{5,15}:[A-Za-z0-9_-]{30,50}$/;
const USER_ID_FORMAT = /^\d{1,15}$/;
const MAX_ALLOWED_USERS = 20;
const PURPOSE = 'telegram_bot_token';
const TEST_MESSAGE = 'Hermes Cloud: Telegram connection test succeeded. You can ignore this message.';

export type TelegramView =
  | { configured: false }
  | {
      configured: true;
      botId: string;
      botUsername: string;
      allowedUserIds: string[];
      status: 'UNTESTED' | 'OK' | 'FAILED';
      keyHint: string;
      lastErrorCode: string | null;
      verifiedAt: Date | null;
      /** True while the running container has not yet been recreated with the current configuration. */
      restartRequired: boolean;
    };

export interface TelegramInput {
  token: string;
  allowedUserIds: string[];
}

interface Deps {
  prisma: PrismaClient;
  secrets: SecretStore;
  logger: Logger;
  fetcher?: Fetcher;
}

export class TelegramService {
  private readonly fetcher: Fetcher;
  constructor(private readonly d: Deps) {
    this.fetcher = d.fetcher ?? defaultFetcher;
  }

  async get(tenantId: string, instanceId: string): Promise<TelegramView> {
    const inst = await this.instance(tenantId, instanceId);
    return this.view(instanceId, inst.configRevision > inst.appliedRevision);
  }

  async put(tenantId: string, instanceId: string, input: TelegramInput): Promise<TelegramView> {
    const { token } = input;
    const allowed = normalizeUserIds(input.allowedUserIds);
    if (typeof token !== 'string' || !TOKEN_FORMAT.test(token)) throw new ValidationError('The Telegram token has an invalid format');
    await this.instance(tenantId, instanceId);

    const bot = await this.getMe(token);
    if (!bot) throw new ValidationError('Telegram rejected the token');

    try {
      await this.d.prisma.$transaction(async (tx) => {
        // First statement: the row lock serializes concurrent saves, so each one sees the other's result.
        await tx.instance.update({ where: { id: instanceId }, data: { configRevision: { increment: 1 } } });
        const existing = await tx.telegramConnection.findUnique({ where: { instanceId } });
        const taken = await tx.telegramConnection.findUnique({ where: { botId: bot.id } });
        if (taken && taken.instanceId !== instanceId) throw new ConflictError('This bot is already connected to another instance');
        const secret = await this.d.secrets.put({ tenantId, purpose: PURPOSE, plaintext: token }, tx);
        const data = { secretId: secret.id, botId: bot.id, botUsername: bot.username, allowedUserIds: allowed, status: 'UNTESTED' as const, lastErrorCode: null, verifiedAt: null };
        if (existing) {
          await tx.telegramConnection.update({ where: { instanceId }, data });
          await this.d.secrets.revoke(tenantId, existing.secretId, tx);
        } else {
          await tx.telegramConnection.create({ data: { instanceId, ...data } });
        }
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictError('This bot is already connected to another instance');
      throw e;
    }
    this.d.logger.info({ instanceId }, 'telegram connection stored');
    return this.get(tenantId, instanceId);
  }

  async remove(tenantId: string, instanceId: string): Promise<{ restartRequired: boolean }> {
    await this.instance(tenantId, instanceId);
    await this.d.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Instance" WHERE id = ${instanceId}::uuid FOR UPDATE`;
      const existing = await tx.telegramConnection.findUnique({ where: { instanceId } });
      if (!existing) return;
      await tx.telegramConnection.delete({ where: { instanceId } });
      await this.d.secrets.revoke(tenantId, existing.secretId, tx);
      await tx.instance.update({ where: { id: instanceId }, data: { configRevision: { increment: 1 } } });
    });
    const inst = await this.instance(tenantId, instanceId);
    return { restartRequired: inst.configRevision > inst.appliedRevision };
  }

  /**
   * Re-checks the token and, when possible, sends one fixed message to the first allowed user. A Telegram
   * outage throws a coarse error and changes nothing; it is never an instance problem (PRD 8.3 / 9).
   */
  async verify(tenantId: string, instanceId: string): Promise<TelegramView> {
    await this.instance(tenantId, instanceId);
    const conn = await this.d.prisma.telegramConnection.findUnique({ where: { instanceId } });
    if (!conn) throw new NotFoundError('Telegram is not configured');
    const token = await this.d.secrets.get(tenantId, conn.secretId);

    const bot = await this.getMe(token);
    if (!bot) {
      await this.d.prisma.telegramConnection.update({ where: { instanceId }, data: { status: 'FAILED', lastErrorCode: 'token_rejected' } });
      return this.get(tenantId, instanceId);
    }
    const chatId = conn.allowedUserIds[0];
    const res = await this.fetcher(`https://${API_HOST}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: TEST_MESSAGE }),
      allowHosts: [API_HOST],
    });
    if (res.status === 200) {
      await this.d.prisma.telegramConnection.update({ where: { instanceId }, data: { status: 'OK', lastErrorCode: null, verifiedAt: new Date() } });
    } else if (res.status === 403) {
      await this.d.prisma.telegramConnection.update({ where: { instanceId }, data: { status: 'UNTESTED', lastErrorCode: 'needs_start' } });
    } else {
      await this.d.prisma.telegramConnection.update({ where: { instanceId }, data: { status: 'FAILED', lastErrorCode: 'send_failed' } });
    }
    return this.get(tenantId, instanceId);
  }

  private async getMe(token: string): Promise<{ id: string; username: string } | null> {
    const res = await this.fetcher(`https://${API_HOST}/bot${token}/getMe`, { allowHosts: [API_HOST] });
    if (res.status === 401 || res.status === 404) return null; // Telegram's answer for an unknown token
    if (res.status !== 200) throw new OutboundFailedError('unreachable'); // 5xx, 429...: Telegram's problem, not the token's
    const parsed = parseJson(res.body);
    const result = parsed && typeof parsed === 'object' ? (parsed as { ok?: unknown; result?: { id?: unknown; username?: unknown } }) : null;
    if (result?.ok !== true || typeof result.result?.id !== 'number' || typeof result.result.username !== 'string') return null;
    return { id: String(result.result.id), username: result.result.username };
  }

  private async instance(tenantId: string, instanceId: string) {
    const inst = await this.d.prisma.instance.findFirst({ where: { id: instanceId, tenantId, deletedAt: null }, select: { id: true, configRevision: true, appliedRevision: true } });
    if (!inst) throw new NotFoundError('Instance not found');
    return inst;
  }

  private async view(instanceId: string, restartRequired: boolean): Promise<TelegramView> {
    const c = await this.d.prisma.telegramConnection.findUnique({ where: { instanceId }, include: { secret: { select: { keyHint: true } } } });
    if (!c) return { configured: false };
    return {
      configured: true,
      botId: c.botId,
      botUsername: c.botUsername,
      allowedUserIds: c.allowedUserIds,
      status: c.status,
      keyHint: c.secret.keyHint,
      lastErrorCode: c.lastErrorCode,
      verifiedAt: c.verifiedAt,
      restartRequired,
    };
  }
}

function normalizeUserIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_ALLOWED_USERS) throw new ValidationError('allowedUserIds must list 1 to 20 numeric Telegram user ids');
  const out = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || !USER_ID_FORMAT.test(id)) throw new ValidationError('allowedUserIds must contain only numeric Telegram user ids');
    out.add(id);
  }
  return [...out];
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
