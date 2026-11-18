import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/env.js';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { AuditService } from '../../src/modules/admin/audit-service.js';
import { IdentityService } from '../../src/modules/auth/identity-service.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { createTestAuth, testConfig } from '../helpers/auth.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { TEST_MASTER_KEY, seed, silentLogger } from '../helpers/service-env.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const IMAGE = 'hermes-stub:0.2.0';
const BOSS = 'boss@nibie.app';
const BOSS_ID = randomUUID();

let auth: Awaited<ReturnType<typeof createTestAuth>>;

function app(cfg: Partial<Config> = {}) {
  const service = new InstanceService({ prisma, runtime: new FakeRuntime(), image: IMAGE, production: false, logger: silentLogger, masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off' });
  return buildServer({
    service, logger: silentLogger,
    config: testConfig(IMAGE, TEST_MASTER_KEY, { adminEmails: [BOSS], ...cfg }),
    customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
    admin: { verify: auth.verify, prisma, audit: new AuditService({ prisma }) },
  });
}
type App = ReturnType<typeof app>;

const session = async (aal = 'aal2') => ({ authorization: `Bearer ${await auth.signToken({ sub: BOSS_ID, email: BOSS, aal })}` });
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const createKey = (a: App, headers: Record<string, string>, body: unknown = { name: 'laptop', expiresInDays: 30, reason: 'claude code mcp' }) =>
  a.inject({ method: 'POST', url: '/api/v1/admin/api-keys', headers, payload: body as object });
const settle = () => new Promise((r) => setTimeout(r, 100));

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const rpc = (a: App, headers: Record<string, string>, method: string, params: object = {}) =>
  a.inject({ method: 'POST', url: '/api/v1/admin/mcp', headers: { ...MCP_HEADERS, ...headers }, payload: { jsonrpc: '2.0', id: 1, method, params } });

describe('admin api keys', () => {
  beforeAll(async () => { auth = await createTestAuth(); });
  beforeEach(async () => { await resetDb(prisma); await seed(prisma); });
  afterAll(() => prisma.$disconnect());

  it('creates a key once from an aal2 session, stores only its hash and audits without the key', async () => {
    const a = app();
    expect((await createKey(a, await session('aal1'))).statusCode).toBe(403);
    expect((await createKey(a, await session(), { name: 'x', expiresInDays: 7, reason: 'bad expiry' })).statusCode).toBe(400);

    const res = await createKey(a, await session());
    expect(res.statusCode).toBe(201);
    const { key, plaintext } = res.json();
    expect(plaintext).toMatch(/^nca_/);
    expect(key).toMatchObject({ name: 'laptop', createdByEmail: BOSS, revokedAt: null });
    expect(key.hash).toBeUndefined();
    expect(new Date(key.expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    const row = await prisma.adminApiKey.findUniqueOrThrow({ where: { id: key.id } });
    expect(row.hash).not.toContain(plaintext);
    const audits = await prisma.auditLog.findMany({ where: { action: 'POST /api-keys' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.reason).toBe('claude code mcp');
    expect(JSON.stringify(audits)).not.toContain(plaintext);

    const listed = await a.inject({ method: 'GET', url: '/api/v1/admin/api-keys', headers: await session() });
    expect(listed.json().keys).toHaveLength(1);
    expect(listed.body).not.toContain(plaintext);
    expect(listed.body).not.toContain(row.hash);
  });

  it('a key reads and invites with audit marked as key use, but can never manage keys', async () => {
    const a = app();
    const { key, plaintext } = (await createKey(a, await session())).json();
    expect((await a.inject({ method: 'GET', url: '/api/v1/admin/overview', headers: bearer(plaintext) })).statusCode).toBe(200);
    const inv = await a.inject({ method: 'POST', url: '/api/v1/admin/beta-invites', headers: bearer(plaintext), payload: { email: 'friend@example.test', reason: 'via key' } });
    expect(inv.statusCode).toBe(201);

    for (const res of [
      await createKey(a, bearer(plaintext)),
      await a.inject({ method: 'GET', url: '/api/v1/admin/api-keys', headers: bearer(plaintext) }),
      await a.inject({ method: 'POST', url: `/api/v1/admin/api-keys/${key.id}/revoke`, headers: bearer(plaintext), payload: { reason: 'self revoke' } }),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('session_required');
    }
    await settle();
    const read = await prisma.auditLog.findFirstOrThrow({ where: { action: 'GET /api/v1/admin/overview' } });
    expect(read).toMatchObject({ actorEmail: BOSS, detail: { via: 'key', keyPrefix: key.prefix } });
    const write = await prisma.auditLog.findFirstOrThrow({ where: { action: 'POST /beta-invites' } });
    expect(write.detail).toMatchObject({ via: 'key', keyPrefix: key.prefix });
    expect(await prisma.adminApiKey.count({ where: { revokedAt: null } })).toBe(1);
  });

  it('refuses a wrong, revoked or expired key, and a key whose creator left ADMIN_EMAILS', async () => {
    const a = app();
    const get = (h: Record<string, string>, x: App = a) => x.inject({ method: 'GET', url: '/api/v1/admin/overview', headers: h });
    expect((await get(bearer('nca_wrong'))).statusCode).toBe(401);
    expect((await get(bearer(`nca_${'A'.repeat(43)}`))).statusCode).toBe(401);

    const { key, plaintext } = (await createKey(a, await session())).json();
    expect((await get(bearer(plaintext), app({ adminEmails: ['other@nibie.app'] }))).statusCode).toBe(403);

    await prisma.adminApiKey.update({ where: { id: key.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await get(bearer(plaintext))).statusCode).toBe(401);
    await prisma.adminApiKey.update({ where: { id: key.id }, data: { expiresAt: null } });
    expect((await get(bearer(plaintext))).statusCode).toBe(200);

    const rev = await a.inject({ method: 'POST', url: `/api/v1/admin/api-keys/${key.id}/revoke`, headers: await session(), payload: { reason: 'lost laptop' } });
    expect(rev.statusCode).toBe(200);
    expect(rev.json().key.revokedAt).not.toBeNull();
    expect((await get(bearer(plaintext))).statusCode).toBe(401);
    expect(await prisma.auditLog.count({ where: { action: 'POST /api-keys/:keyId/revoke' } })).toBe(1);
  });

  it('settings show modes and counts but never a secret, URL or email list', async () => {
    const secrets = ['sk-sumopod-SECRET', 'whtoken-SECRET', 'whsec_SECRET', 'duitku-SECRET', 'smtp-pass-SECRET', 'router-admin-SECRET', 'turnstile-SECRET', 'https://callback.example.test', 'https://router.example.test', 'invited@example.test'];
    const a = app({
      betaAllowedEmails: ['invited@example.test'],
      turnstileSecret: 'turnstile-SECRET',
      mail: { host: 'smtp.example.test', port: 465, user: 'smtp-user', pass: 'smtp-pass-SECRET', from: 'noreply@nibie.app' },
      billing: {
        gateway: 'both',
        sumopod: { apiKey: 'sk-sumopod-SECRET', webhookToken: 'whtoken-SECRET', webhookSecret: 'whsec_SECRET', env: 'sandbox', callbackUrl: 'https://callback.example.test' },
        duitku: { merchantCode: 'D1', apiKey: 'duitku-SECRET', env: 'sandbox', callbackUrl: 'https://callback.example.test' },
      },
      router: { apiUrl: 'https://router.example.test', adminKey: 'router-admin-SECRET', defaultModel: 'nibie/default', emailDomain: 'users.nibie.app' },
    });
    const res = await a.inject({ method: 'GET', url: '/api/v1/admin/system', headers: await session() });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toEqual({
      billing: { gateway: 'both', paidCheckoutOpen: true, sumopod: { env: 'sandbox', webhookSigned: true }, duitku: { env: 'sandbox' } },
      email: { configured: true, from: 'noreply@nibie.app' },
      signIn: { supabase: true, adminEmails: 1, betaAllowedEmails: 1, freeBetaSlots: 0, turnstile: true, maxInstancesPerTenant: 1, maxTotalInstances: null },
      ai: { configured: true, defaultModel: 'nibie/default', userEmailDomain: 'users.nibie.app' },
      mcpPath: '/api/v1/admin/mcp',
    });
    for (const s of secrets) expect(res.body, s).not.toContain(s);
  });
});

describe('admin mcp', () => {
  beforeAll(async () => { auth = await createTestAuth(); });
  beforeEach(async () => { await resetDb(prisma); await seed(prisma); });

  it('needs a valid admin credential', async () => {
    const a = app();
    expect((await a.inject({ method: 'POST', url: '/api/v1/admin/mcp', headers: MCP_HEADERS, payload: {} })).statusCode).toBe(401);
    expect((await rpc(a, bearer('nca_wrong'), 'tools/list')).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: '/api/v1/admin/mcp', headers: await session() })).statusCode).toBe(405);
  });

  it('initializes, lists the tools and runs reads and an invite through the admin routes with a key', async () => {
    const a = app();
    const { plaintext, key } = (await createKey(a, await session())).json();
    const h = bearer(plaintext);

    const init = await rpc(a, h, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    expect(init.statusCode).toBe(200);
    expect(init.headers['cache-control']).toBe('no-store');
    expect(init.json().result.serverInfo.name).toBe('nibie-cloud-admin');

    const tools = await rpc(a, h, 'tools/list');
    const names = (tools.json().result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['get_overview', 'get_settings', 'list_customers', 'add_beta_invite', 'revoke_beta_invite', 'list_audit_log']));
    expect(names.some((n) => n.includes('key'))).toBe(false);

    const overview = await rpc(a, h, 'tools/call', { name: 'get_overview', arguments: {} });
    const result = overview.json().result;
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).counts).toBeDefined();

    const customers = async (args: object) =>
      JSON.parse((await rpc(a, h, 'tools/call', { name: 'list_customers', arguments: args })).json().result.content[0].text).customers as unknown[];
    expect((await customers({})).length).toBeGreaterThan(0);
    expect(await customers({ q: 'nobody-matches-this@example.test' })).toEqual([]);

    const add = await rpc(a, h, 'tools/call', { name: 'add_beta_invite', arguments: { email: 'mcp@example.test', reason: 'from claude' } });
    expect(add.json().result.isError).toBeUndefined();
    expect(await prisma.betaInvite.count({ where: { email: 'mcp@example.test' } })).toBe(1);

    const bad = await rpc(a, h, 'tools/call', { name: 'get_instance', arguments: { instanceId: randomUUID() } });
    expect(bad.json().result.isError).toBe(true);

    await settle();
    expect(await prisma.auditLog.count({ where: { action: 'POST /beta-invites', detail: { path: ['keyPrefix'], equals: key.prefix } } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: { contains: '/mcp' } } })).toBe(0);
  });
});
