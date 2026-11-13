import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { TelegramService, type Fetcher } from '../../src/modules/integrations/telegram-service.js';
import { PrismaSecretStore } from '../../src/modules/secrets/secret-store.js';
import { ConflictError, NotFoundError, OutboundFailedError, ValidationError } from '../../src/shared/errors.js';
import { createLogger } from '../../src/shared/logger.js';
import { resetDb } from '../helpers/db.js';
import { seed } from '../helpers/service-env.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const TOKEN = '123456789:AAHcanaryTOKENvalue0123456789abcdefg';
const TOKEN2 = '123456789:BBHsecondTOKENvalue0123456789abcdefg';
const OTHER_BOT_TOKEN = '987654321:CCHotherBotTOKEN0123456789abcdefghi';

interface Call { url: string; method: string; body: string | undefined }
let calls: Call[];
let lines: string[];
let sendMode: 'ok' | 'forbidden' | 'outage';
let getMeStatus: number | null; // when set, getMe answers this HTTP status with no body (a Telegram-side outage)
let s: Awaited<ReturnType<typeof seed>>;
let svc: TelegramService;
let secrets: PrismaSecretStore;

const BOTS: Record<string, { id: number; username: string }> = {
  [TOKEN]: { id: 123456789, username: 'canary_bot' },
  [TOKEN2]: { id: 123456789, username: 'canary_bot' }, // same bot, rotated token
  [OTHER_BOT_TOKEN]: { id: 987654321, username: 'other_bot' },
};
const json = (status: number, body: unknown) => ({ status, headers: {}, body: JSON.stringify(body) });
const fetcher: Fetcher = async (url, opts) => {
  calls.push({ url, method: opts.method ?? 'GET', body: opts.body });
  const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
  if (!m) throw new Error('unexpected url');
  const bot = BOTS[m[1]!];
  if (!bot) return json(401, { ok: false, error_code: 401, description: 'Unauthorized' });
  if (m[2] === 'getMe' && getMeStatus !== null) return { status: getMeStatus, headers: {}, body: '' };
  if (m[2] === 'getMe') return json(200, { ok: true, result: { id: bot.id, is_bot: true, username: bot.username } });
  if (m[2] === 'sendMessage') {
    if (sendMode === 'outage') throw new OutboundFailedError('unreachable');
    if (sendMode === 'forbidden') return json(403, { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" });
    return json(200, { ok: true, result: { message_id: 1 } });
  }
  throw new Error('unexpected method');
};

const mkInstance = (tenantId: string) =>
  prisma.instance.create({ data: { tenantId, planId: s.plan.id, nodeId: s.node.id, name: 'x', idempotencyKey: crypto.randomUUID(), image: 'hermes-stub:0.2.0', status: 'ACTIVE' } });

describe('TelegramService', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seed(prisma);
    calls = [];
    lines = [];
    sendMode = 'ok';
    getMeStatus = null;
    secrets = new PrismaSecretStore({ prisma, current: { version: 1, key: randomBytes(32) }, previous: null });
    const stream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
    svc = new TelegramService({ prisma, secrets, logger: createLogger({ level: 'trace', stream }), fetcher });
  });
  afterAll(() => prisma.$disconnect());

  it('put validates the token with getMe, stores it encrypted and bumps the config revision', async () => {
    const inst = await mkInstance(s.tenant.id);
    const view = await svc.put(s.tenant.id, inst.id, { token: TOKEN, allowedUserIds: ['111', '222'] });
    expect(view).toMatchObject({ configured: true, botId: '123456789', botUsername: 'canary_bot', allowedUserIds: ['111', '222'], status: 'UNTESTED', keyHint: TOKEN.slice(-4), restartRequired: true });
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(calls.map((c) => c.url)).toEqual([`https://api.telegram.org/bot${TOKEN}/getMe`]);
    const row = await prisma.instance.findUniqueOrThrow({ where: { id: inst.id } });
    expect(row.configRevision).toBe(1);
    expect(JSON.stringify(await prisma.secret.findMany())).not.toContain(TOKEN);
  });

  it('rejects a token Telegram refuses and stores nothing', async () => {
    const inst = await mkInstance(s.tenant.id);
    await expect(svc.put(s.tenant.id, inst.id, { token: '111111111:ZZZnotARealTokenButWellFormed0123456789', allowedUserIds: ['1'] })).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.secret.count()).toBe(0);
    expect(await prisma.telegramConnection.count()).toBe(0);
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: inst.id } })).configRevision).toBe(0);
  });

  it('rejects malformed tokens before anything is sent to Telegram (no path injection)', async () => {
    const inst = await mkInstance(s.tenant.id);
    for (const token of ['', 'abc', '123:../../x', `${TOKEN}/sendMessage?x=`, ' 123456789:AAHcanaryTOKENvalue0123456789abcdefg', 'a'.repeat(300)]) {
      await expect(svc.put(s.tenant.id, inst.id, { token, allowedUserIds: ['1'] })).rejects.toBeInstanceOf(ValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  it('requires a non-empty list of numeric allowed user ids (no open bot)', async () => {
    const inst = await mkInstance(s.tenant.id);
    for (const allowedUserIds of [[], ['abc'], ['1', '-5'], ['1.5'], Array.from({ length: 21 }, (_, i) => String(i + 1))]) {
      await expect(svc.put(s.tenant.id, inst.id, { token: TOKEN, allowedUserIds })).rejects.toBeInstanceOf(ValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses a bot that another instance already uses (one bot, one tenant)', async () => {
    const a = await mkInstance(s.tenant.id);
    const b = await mkInstance(s.other.id);
    await svc.put(s.tenant.id, a.id, { token: TOKEN, allowedUserIds: ['1'] });
    await expect(svc.put(s.other.id, b.id, { token: TOKEN2, allowedUserIds: ['1'] })).rejects.toBeInstanceOf(ConflictError);
    expect(await prisma.telegramConnection.count()).toBe(1);
    expect(await prisma.secret.count({ where: { tenantId: s.other.id } })).toBe(0);
  });

  it('replacing the token revokes the old secret and keeps one connection', async () => {
    const inst = await mkInstance(s.tenant.id);
    await svc.put(s.tenant.id, inst.id, { token: TOKEN, allowedUserIds: ['1'] });
    const first = await prisma.telegramConnection.findUniqueOrThrow({ where: { instanceId: inst.id } });
    await svc.put(s.tenant.id, inst.id, { token: TOKEN2, allowedUserIds: ['1'] });
    const second = await prisma.telegramConnection.findUniqueOrThrow({ where: { instanceId: inst.id } });
    expect(second.secretId).not.toBe(first.secretId);
    expect((await prisma.secret.findUniqueOrThrow({ where: { id: first.secretId } })).revokedAt).not.toBeNull();
    expect(await secrets.get(s.tenant.id, second.secretId)).toBe(TOKEN2);
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: inst.id } })).configRevision).toBe(2);
  });

  it('get returns null before configuration and a redacted view after', async () => {
    const inst = await mkInstance(s.tenant.id);
    expect(await svc.get(s.tenant.id, inst.id)).toEqual({ configured: false });
    await svc.put(s.tenant.id, inst.id, { token: TOKEN, allowedUserIds: ['1'] });
    const view = await svc.get(s.tenant.id, inst.id);
    expect(JSON.stringify(view)).not.toContain(TOKEN);
  });

  it('remove revokes the secret, deletes the connection and bumps the revision', async () => {
    const inst = await mkInstance(s.tenant.id);
    await svc.put(s.tenant.id, inst.id, { token: TOKEN, allowedUserIds: ['1'] });
    const conn = await prisma.telegramConnection.findUniqueOrThrow({ where: { instanceId: inst.id } });
    const out = await svc.remove(s.tenant.id, inst.id);
    expect(out.restartRequired).toBe(true);
    expect(await prisma.telegramConnection.count()).toBe(0);
    expect((await prisma.secret.findUniqueOrThrow({ where: { id: conn.secretId } })).revokedAt).not.toBeNull();
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: inst.id } })).configRevision).toBe(2);
  });

  it('verify sends one fixed test message to the first allowed user and records success', async () => {
    const inst = await mkInstance(s.tenant.id);
    await svc.put(s.tenant.id, inst.id, { token: TOKEN, allowedUserIds: ['555', '666'] });
    calls = [];
    const view = await svc.verify(s.tenant.id, inst.id);
    expect(view).toMatchObject({ status: 'OK', lastErrorCode: null });
    expect(view.configured && view.verifiedAt).toBeTruthy();
    const send = calls.find((c) => c.url.endsWith('/sendMessage'))!;
    expect(JSON.parse(send.body!)).toMatchObject({ chat_id: '555' });
    expect(send.body).not.toContain(TOKEN);
  });

  it('verify reports needs_start when the user has not started the bot, without failing the call', async () => {
    const inst = await mkInstance(s.tenant.id);
    await svc.put(s.tenant.id, inst.id, { token: TOKEN, allowedUserIds: ['555'] });
    sendMode = 'forbidden';
    const view = await svc.verify(s.tenant.id, inst.id);
    expect(view).toMatchObject({ status: 'UNTESTED', lastErrorCode: 'needs_start' });
  });

  it('a Telegram outage on verify throws a coarse error and never touches the instance status', async () => {
    const inst = await mkInstance(s.tenant.id);
    await svc.put(s.tenant.id, inst.id, { token: TOKEN, allowedUserIds: ['555'] });
    sendMode = 'outage';
    await expect(svc.verify(s.tenant.id, inst.id)).rejects.toBeInstanceOf(OutboundFailedError);
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: inst.id } })).status).toBe('ACTIVE');
    expect((await prisma.telegramConnection.findUniqueOrThrow({ where: { instanceId: inst.id } })).status).toBe('UNTESTED');
  });

  it("another tenant's instance is not found for every operation", async () => {
    const inst = await mkInstance(s.tenant.id);
    await svc.put(s.tenant.id, inst.id, { token: TOKEN, allowedUserIds: ['1'] });
    await expect(svc.get(s.other.id, inst.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.put(s.other.id, inst.id, { token: TOKEN2, allowedUserIds: ['1'] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.verify(s.other.id, inst.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.remove(s.other.id, inst.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('the token never appears in logs, events, errors or stored rows', async () => {
    const inst = await mkInstance(s.tenant.id);
    const errors: string[] = [];
    await svc.put(s.tenant.id, inst.id, { token: TOKEN, allowedUserIds: ['1'] });
    await svc.verify(s.tenant.id, inst.id);
    sendMode = 'outage';
    await svc.verify(s.tenant.id, inst.id).catch((e: Error) => errors.push(`${e.message} ${JSON.stringify(e)}`));
    await svc.put(s.tenant.id, inst.id, { token: '111111111:ZZZnotARealTokenButWellFormed0123456789', allowedUserIds: ['1'] }).catch((e: Error) => errors.push(e.message));
    const everything = JSON.stringify({ lines, errors, events: await prisma.instanceEvent.findMany(), secrets: await prisma.secret.findMany(), conn: await prisma.telegramConnection.findMany() });
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('AAHcanaryTOKEN');
    expect(everything).not.toContain('ZZZnotARealToken');
  });

  it('a Telegram 5xx on getMe is an outage, not a rejected token: put stores nothing and verify changes nothing', async () => {
    const inst = await mkInstance(s.tenant.id);
    getMeStatus = 503;
    await expect(svc.put(s.tenant.id, inst.id, { token: TOKEN, allowedUserIds: ['1'] })).rejects.toBeInstanceOf(OutboundFailedError);
    expect(await prisma.telegramConnection.count()).toBe(0);
    getMeStatus = null;
    await svc.put(s.tenant.id, inst.id, { token: TOKEN, allowedUserIds: ['1'] });
    getMeStatus = 502;
    await expect(svc.verify(s.tenant.id, inst.id)).rejects.toBeInstanceOf(OutboundFailedError);
    expect((await prisma.telegramConnection.findUniqueOrThrow({ where: { instanceId: inst.id } })).status).toBe('UNTESTED');
  });

  it('two saves at once leave exactly one live secret and one config', async () => {
    const inst = await mkInstance(s.tenant.id);
    await svc.put(s.tenant.id, inst.id, { token: TOKEN, allowedUserIds: ['1'] });
    // A slow secret write makes both transactions read the existing connection before either one writes.
    const slow = Object.create(secrets) as PrismaSecretStore;
    slow.put = async (...args) => { await new Promise((r) => setTimeout(r, 150)); return secrets.put(...args); };
    const racing = new TelegramService({ prisma, secrets: slow, logger: createLogger({ level: 'silent' }), fetcher });
    const results = await Promise.allSettled([
      racing.put(s.tenant.id, inst.id, { token: TOKEN2, allowedUserIds: ['1'] }),
      racing.put(s.tenant.id, inst.id, { token: TOKEN, allowedUserIds: ['1'] }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await prisma.secret.count({ where: { revokedAt: null } })).toBe(1);
    const conn = await prisma.telegramConnection.findUniqueOrThrow({ where: { instanceId: inst.id } });
    expect((await prisma.secret.findUniqueOrThrow({ where: { id: conn.secretId } })).revokedAt).toBeNull();
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: inst.id } })).configRevision).toBe(3);
  });
});
