import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { AuditService } from '../../src/modules/admin/audit-service.js';
import { IdentityService } from '../../src/modules/auth/identity-service.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { createTestAuth, testConfig } from '../helpers/auth.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { TEST_MASTER_KEY, silentLogger } from '../helpers/service-env.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const IMAGE = 'hermes-stub:0.2.0';
const BOSS = 'boss@nibie.app';

let auth: Awaited<ReturnType<typeof createTestAuth>>;

function app() {
  const service = new InstanceService({ prisma, runtime: new FakeRuntime(), image: IMAGE, production: false, logger: silentLogger, masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off' });
  return buildServer({
    service, logger: silentLogger,
    config: testConfig(IMAGE, TEST_MASTER_KEY, { adminEmails: [BOSS] }),
    customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
    admin: { verify: auth.verify, prisma, audit: new AuditService({ prisma }) },
  });
}

const as = async (email: string, aal: string | null = 'aal2') => ({ authorization: `Bearer ${await auth.signToken({ sub: randomUUID(), email, aal })}` });
const save = (a: ReturnType<typeof app>, headers: Record<string, string>, body: unknown) =>
  a.inject({ method: 'POST', url: '/api/v1/admin/support-contact', headers, payload: body as object });
const publicContact = async (a: ReturnType<typeof app>) => (await a.inject({ method: 'GET', url: '/api/v1/public/support-contact' }));

describe('support contact', () => {
  beforeAll(async () => { auth = await createTestAuth(); });
  beforeEach(async () => { await resetDb(prisma); });
  afterAll(() => prisma.$disconnect());

  it('is empty until an admin sets it, and readable without signing in', async () => {
    const res = await publicContact(app());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ whatsapp: null, email: null });
    expect(res.headers['cache-control']).toBe('public, max-age=60');
  });

  it('refuses everyone but an allowlisted admin with a second factor', async () => {
    const a = app();
    const body = { whatsapp: '6281234567890', email: '', reason: 'test reason' };
    expect((await a.inject({ method: 'POST', url: '/api/v1/admin/support-contact', payload: body })).statusCode).toBe(401);
    expect((await save(a, await as('guest@example.test'), body)).statusCode).toBe(403);
    const mfa = await save(a, await as(BOSS, 'aal1'), body);
    expect(mfa.statusCode).toBe(403);
    expect(mfa.json().error.code).toBe('mfa_required');
    expect(await prisma.supportContact.count()).toBe(0);
  });

  it('normalizes the number, clears with an empty value and audits each real change once', async () => {
    const a = app();
    const boss = await as(BOSS);
    const first = await save(a, boss, { whatsapp: '+62 812-3456-7890', email: ' Support@Nibie.app ', reason: 'launch contacts' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ whatsapp: '6281234567890', email: 'support@nibie.app' });
    expect((await publicContact(a)).json()).toEqual({ whatsapp: '6281234567890', email: 'support@nibie.app' });
    // The same values again change nothing and are not recorded.
    expect((await save(a, boss, { whatsapp: '6281234567890', email: 'support@nibie.app', reason: 'same again' })).statusCode).toBe(200);
    expect((await save(a, boss, { whatsapp: '', email: 'support@nibie.app', reason: 'drop whatsapp' })).json()).toEqual({ whatsapp: null, email: 'support@nibie.app' });
    const rows = await prisma.auditLog.findMany({ where: { targetType: 'support-contact' }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => [r.reason, r.detail])).toEqual([
      ['launch contacts', { from: { whatsapp: null, email: null }, to: { whatsapp: '6281234567890', email: 'support@nibie.app' } }],
      ['drop whatsapp', { from: { whatsapp: '6281234567890', email: 'support@nibie.app' }, to: { whatsapp: null, email: 'support@nibie.app' } }],
    ]);
    expect(rows.every((r) => r.actorEmail === BOSS)).toBe(true);
  });

  it('refuses a number without country code, a bad email, a missing reason and unknown fields', async () => {
    const a = app();
    const boss = await as(BOSS);
    for (const body of [
      { whatsapp: '081234567890', email: '', reason: 'test reason' },
      { whatsapp: '62812', email: '', reason: 'test reason' },
      { whatsapp: '62abc1234567', email: '', reason: 'test reason' },
      { whatsapp: '', email: 'not-an-email', reason: 'test reason' },
      { whatsapp: '6281234567890', email: '' },
      { whatsapp: '6281234567890', email: '', reason: 'test reason', extra: 1 },
    ]) {
      expect((await save(a, boss, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await prisma.supportContact.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { targetType: 'support-contact' } })).toBe(0);
  });
});
