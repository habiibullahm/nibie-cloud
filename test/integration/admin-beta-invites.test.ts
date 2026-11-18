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
const ENV_INVITED = 'env-invited@example.test';
const GUEST = 'guest@example.test';

let auth: Awaited<ReturnType<typeof createTestAuth>>;

function app(cfg: Partial<Config> = {}) {
  const service = new InstanceService({ prisma, runtime: new FakeRuntime(), image: IMAGE, production: false, logger: silentLogger, masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off' });
  return buildServer({
    service, logger: silentLogger,
    config: testConfig(IMAGE, TEST_MASTER_KEY, { adminEmails: [BOSS], betaAllowedEmails: [ENV_INVITED], freeBetaSlots: 0, ...cfg }),
    customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
    admin: { verify: auth.verify, prisma, audit: new AuditService({ prisma }) },
  });
}

const as = async (email: string, aal: string | null = 'aal2') => ({ authorization: `Bearer ${await auth.signToken({ sub: randomUUID(), email, aal })}` });
const invite = (a: ReturnType<typeof app>, headers: Record<string, string>, body: unknown) =>
  a.inject({ method: 'POST', url: '/api/v1/admin/beta-invites', headers, payload: body as object });
const revoke = (a: ReturnType<typeof app>, headers: Record<string, string>, id: string, body: unknown = { reason: 'no longer needed' }) =>
  a.inject({ method: 'POST', url: `/api/v1/admin/beta-invites/${id}/revoke`, headers, payload: body as object });
const list = (a: ReturnType<typeof app>, headers: Record<string, string>) =>
  a.inject({ method: 'GET', url: '/api/v1/admin/beta-invites', headers });

describe('admin beta invites', () => {
  beforeAll(async () => { auth = await createTestAuth(); });
  beforeEach(async () => { await resetDb(prisma); await seed(prisma); });
  afterAll(() => prisma.$disconnect());

  it('refuses everyone but an allowlisted admin with a second factor', async () => {
    const a = app();
    expect((await a.inject({ method: 'GET', url: '/api/v1/admin/beta-invites' })).statusCode).toBe(401);
    expect((await list(a, await as(GUEST))).statusCode).toBe(403);
    const mfa = await list(a, await as(BOSS, 'aal1'));
    expect(mfa.statusCode).toBe(403);
    expect(mfa.json().error.code).toBe('mfa_required');
    expect((await invite(a, await as(GUEST), { email: 'x@example.test', reason: 'test reason' })).statusCode).toBe(403);
    expect((await invite(a, await as(BOSS, 'aal1'), { email: 'x@example.test', reason: 'test reason' })).statusCode).toBe(403);
    expect(await prisma.betaInvite.count()).toBe(0);
  });

  it('lists the database invites with the env list and the slot count, and records the read', async () => {
    await prisma.betaInvite.create({ data: { email: 'a@example.test', note: 'friend' } });
    const res = await list(app(), await as(BOSS));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fromEnv).toEqual([ENV_INVITED]);
    expect(body.freeBetaSlots).toBe(0);
    expect(body.invites).toHaveLength(1);
    expect(body.invites[0]).toMatchObject({ email: 'a@example.test', note: 'friend', revokedAt: null });
    await new Promise((r) => setTimeout(r, 100));
    expect(await prisma.auditLog.count({ where: { action: 'GET /api/v1/admin/beta-invites' } })).toBe(1);
  });

  it('adds an invite with the admin as author, normalizes the email and writes one audit entry with the reason', async () => {
    const res = await invite(app(), await as(BOSS), { email: '  New.Person@Example.TEST ', note: ' met at demo ', reason: 'asked on telegram' });
    expect(res.statusCode).toBe(201);
    expect(res.json().invite).toMatchObject({ email: 'new.person@example.test', note: 'met at demo', addedBy: BOSS, revokedAt: null });
    const rows = await prisma.auditLog.findMany({ where: { targetType: 'beta_invite' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorEmail: BOSS, action: 'POST /beta-invites', reason: 'asked on telegram', targetId: res.json().invite.id });
    expect(rows[0]!.detail).toEqual({ email: 'new.person@example.test' });
  });

  it('rejects a bad email, a missing or short reason and unknown fields, and writes nothing', async () => {
    const a = app();
    const h = await as(BOSS);
    for (const body of [
      { email: 'not-an-email', reason: 'long enough' },
      { email: 'ok@example.test' },
      { email: 'ok@example.test', reason: 'x' },
      { email: 'ok@example.test', reason: 'long enough', extra: 1 },
      { email: 'ok@example.test', reason: 'x'.repeat(501) },
    ]) {
      expect((await invite(a, h, body)).statusCode).toBe(400);
    }
    expect(await prisma.betaInvite.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { targetType: 'beta_invite' } })).toBe(0);
  });

  it('inviting the same address again keeps one row', async () => {
    const a = app();
    const h = await as(BOSS);
    const first = await invite(a, h, { email: GUEST, reason: 'first time' });
    const second = await invite(a, h, { email: GUEST.toUpperCase(), reason: 'second time' });
    expect(second.json().invite.id).toBe(first.json().invite.id);
    expect(await prisma.betaInvite.count()).toBe(1);
  });

  it('revokes an invite, records it once, and a second revoke changes and records nothing', async () => {
    const a = app();
    const h = await as(BOSS);
    const id = (await invite(a, h, { email: GUEST, reason: 'let in' })).json().invite.id as string;
    const res = await revoke(a, h, id, { reason: 'left the beta' });
    expect(res.statusCode).toBe(200);
    expect(res.json().invite.revokedAt).not.toBeNull();
    expect((await revoke(a, h, id)).statusCode).toBe(200);
    const audits = await prisma.auditLog.findMany({ where: { action: 'POST /beta-invites/:inviteId/revoke' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ reason: 'left the beta', targetId: id });
    expect((await revoke(a, h, randomUUID())).statusCode).toBe(404);
    expect((await revoke(a, h, 'not-a-uuid')).statusCode).toBe(400);
    expect((await revoke(a, h, id, {})).statusCode).toBe(400);
  });

  it('takes effect for customers at once: an added email can deploy, a revoked one can not', async () => {
    const a = app();
    const boss = await as(BOSS);
    const guest = await as(GUEST, 'aal1');
    const plans = async () => ((await a.inject({ method: 'GET', url: '/api/v1/plans', headers: guest })).json().plans as unknown[]).length;
    expect(await plans()).toBe(0);
    const id = (await invite(a, boss, { email: GUEST, reason: 'let in' })).json().invite.id as string;
    expect(await plans()).toBe(1);
    await revoke(a, boss, id);
    expect(await plans()).toBe(0);
  });
});
