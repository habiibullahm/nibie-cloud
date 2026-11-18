import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/env.js';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { IdentityService } from '../../src/modules/auth/identity-service.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { AuditService } from '../../src/modules/admin/audit-service.js';
import { createLogger } from '../../src/shared/logger.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { DASHBOARD_ORIGIN, createTestAuth, testConfig } from '../helpers/auth.js';
import { resetDb } from '../helpers/db.js';
import { TEST_MASTER_KEY } from '../helpers/service-env.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const IMAGE = 'hermes-stub:0.2.0';
const BOSS = 'boss@nibie.app';
const STRANGER = 'stranger@example.test';
const UNAUTHORIZED = { error: { code: 'unauthorized', message: 'Unauthorized' } };

let auth: Awaited<ReturnType<typeof createTestAuth>>;
let logs = '';
const logStream = new Writable({ write(c, _e, cb) { logs += c.toString(); cb(); } });

function app(cfg: Partial<Config> = {}, opts: { customer?: boolean } = {}) {
  const logger = createLogger({ level: 'debug', stream: logStream });
  const service = new InstanceService({ prisma, runtime: new FakeRuntime(), image: IMAGE, production: false, logger, masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off' });
  const config = testConfig(IMAGE, TEST_MASTER_KEY, { adminEmails: [BOSS], ...cfg });
  return buildServer({
    service, logger, config,
    ...(opts.customer === false ? {} : {
      customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
      admin: { verify: auth.verify, prisma, audit: new AuditService({ prisma }) },
    }),
  });
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const me = (a: ReturnType<typeof app>, headers: Record<string, string>) =>
  a.inject({ method: 'GET', url: '/api/v1/admin/me', headers });

describe('admin API authorization', () => {
  beforeAll(async () => { auth = await createTestAuth(); });
  beforeEach(async () => { logs = ''; await resetDb(prisma); });
  afterAll(() => prisma.$disconnect());

  it('serves /admin/me to an allowlisted email, with the assurance level', async () => {
    const sub = randomUUID();
    const res = await me(app(), bearer(await auth.signToken({ sub, email: BOSS, aal: 'aal2' })));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: sub, email: BOSS, aal: 'aal2' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('matches the allowlist case-insensitively', async () => {
    const res = await me(app(), bearer(await auth.signToken({ email: 'Boss@Nibie.App', aal: 'aal2' })));
    expect(res.statusCode).toBe(200);
  });

  it('asks an allowlisted admin without a second factor for one, on /me and on data routes alike', async () => {
    const a = app();
    // aal1, and a token with no aal claim at all (Supabase leaves it out until a factor exists).
    for (const aal of ['aal1', null] as const) {
      const token = await auth.signToken({ email: BOSS, aal });
      for (const url of ['/api/v1/admin/me', '/api/v1/admin/customers', '/api/v1/admin/waitlist']) {
        const res = await a.inject({ method: 'GET', url, headers: bearer(token) });
        expect(res.statusCode, `${url} ${aal}`).toBe(403);
        expect(res.json().error.code).toBe('mfa_required');
      }
    }
  });

  it('refuses a signed-in user who is not on the allowlist, without saying whether they exist', async () => {
    const res = await me(app(), bearer(await auth.signToken({ email: STRANGER })));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: { code: 'forbidden', message: 'Forbidden' } });
  });

  it('refuses everybody when ADMIN_EMAILS is empty (fail closed)', async () => {
    const a = app({ adminEmails: [] });
    const res = await me(a, bearer(await auth.signToken({ email: BOSS })));
    expect(res.statusCode).toBe(403);
  });

  it('returns the opaque 401 for missing, malformed, oversized and expired credentials', async () => {
    const a = app();
    const expired = await auth.signToken({ email: BOSS, exp: Math.floor(Date.now() / 1000) - 3600 });
    const cases: Record<string, string>[] = [
      {},
      { authorization: 'Basic abc' },
      { authorization: 'Bearer' },
      { authorization: `Bearer ${'x'.repeat(5000)}` },
      bearer(expired),
      // The operator token is not an admin credential: only Supabase tokens are accepted here.
      bearer('test-admin-token-0123456789abcdef'),
    ];
    for (const headers of cases) {
      const res = await me(a, headers);
      expect(res.statusCode, JSON.stringify(headers)).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED);
    }
  });

  it('does not serve the admin API when the customer API is not configured', async () => {
    const res = await me(app({}, { customer: false }), bearer(await auth.signToken({ email: BOSS })));
    expect(res.statusCode).toBe(404);
  });

  it('grants CORS only to the dashboard origin', async () => {
    const a = app();
    const evil = await a.inject({ method: 'GET', url: '/api/v1/admin/me', headers: { origin: 'https://evil.example' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const ok = await a.inject({ method: 'GET', url: '/api/v1/admin/me', headers: { origin: DASHBOARD_ORIGIN } });
    expect(ok.headers['access-control-allow-allow-origin'] ?? ok.headers['access-control-allow-origin']).toBe(DASHBOARD_ORIGIN);
  });

  it('never writes an admin token to the logs', async () => {
    const good = await auth.signToken({ email: BOSS });
    await me(app(), bearer(good));
    await me(app(), bearer(await auth.signToken({ email: STRANGER })));
    expect(logs).not.toContain(good);
  });
});
