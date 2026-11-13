import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { IdentityService } from '../../src/modules/auth/identity-service.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { AuthUnavailableError } from '../../src/shared/errors.js';
import { createLogger } from '../../src/shared/logger.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { DASHBOARD_ORIGIN, TEST_ADMIN_TOKEN, createTestAuth, testConfig } from '../helpers/auth.js';
import { resetDb } from '../helpers/db.js';
import { TEST_MASTER_KEY } from '../helpers/service-env.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const IMAGE = 'hermes-stub:0.2.0';
const UNAUTHORIZED = { error: { code: 'unauthorized', message: 'Unauthorized' } };

let auth: Awaited<ReturnType<typeof createTestAuth>>;
let logs = '';
const logStream = new Writable({ write(c, _e, cb) { logs += c.toString(); cb(); } });

function app(opts: { customer?: boolean; verify?: typeof auth.verify } = {}) {
  const logger = createLogger({ level: 'debug', stream: logStream });
  const service = new InstanceService({ prisma, runtime: new FakeRuntime(), image: IMAGE, production: false, logger, masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off' });
  return buildServer({
    service, logger, config: testConfig(IMAGE, TEST_MASTER_KEY),
    ...(opts.customer === false ? {} : { customer: { verify: opts.verify ?? auth.verify, identity: new IdentityService({ prisma }), prisma } }),
  });
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe('customer authentication surface', () => {
  beforeAll(async () => { auth = await createTestAuth(); });
  beforeEach(async () => { logs = ''; await resetDb(prisma); });
  afterAll(() => prisma.$disconnect());

  it('returns the opaque 401 for missing, malformed, oversized and expired credentials', async () => {
    const a = app();
    const expired = await auth.signToken({ exp: Math.floor(Date.now() / 1000) - 3600 });
    const cases: Record<string, string>[] = [
      {},
      { authorization: 'Basic abc' },
      { authorization: 'Bearer' },
      { authorization: `Bearer ${'x'.repeat(5000)}` },
      { authorization: `Bearer ${'x'.repeat(20_000)}` },
      bearer(expired),
    ];
    for (const headers of cases) {
      const res = await a.inject({ method: 'GET', url: '/api/v1/me', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED);
    }
  });

  it('serves /api/v1/me to a valid user and creates their tenant on first use', async () => {
    const sub = randomUUID();
    const res = await app().inject({ method: 'GET', url: '/api/v1/me', headers: bearer(await auth.signToken({ sub, email: 'a@example.test' })) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; email: string; tenantId: string };
    expect(body).toMatchObject({ id: sub, email: 'a@example.test' });
    expect(await prisma.tenant.count({ where: { id: body.tenantId } })).toBe(1);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('keeps the two surfaces apart: admin token on a customer route and user token on an operator route are 401', async () => {
    const a = app();
    const adminOnCustomer = await a.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(TEST_ADMIN_TOKEN) });
    expect(adminOnCustomer.statusCode).toBe(401);
    const userToken = await auth.signToken();
    const userOnOperator = await a.inject({ method: 'GET', url: `/api/v1/tenants/${randomUUID()}/instances`, headers: bearer(userToken) });
    expect(userOnOperator.statusCode).toBe(401);
  });

  it.each(['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip'])(
    'hides the operator API from proxied requests (%s present), even with the admin token',
    async (header) => {
      const a = app();
      const url = `/api/v1/tenants/${randomUUID()}/instances`;
      const proxied = await a.inject({ method: 'GET', url, headers: { ...bearer(TEST_ADMIN_TOKEN), [header]: '203.0.113.9' } });
      expect(proxied.statusCode).toBe(404);
      expect(proxied.json().error.code).toBe('not_found');
      const direct = await a.inject({ method: 'GET', url, headers: bearer(TEST_ADMIN_TOKEN) });
      expect(JSON.stringify(direct.json())).not.toContain('Route not found'); // served by the operator API
    },
  );

  it('answers 503 auth_unavailable and logs when the key set cannot be fetched', async () => {
    const a = app({ verify: async () => { throw new AuthUnavailableError(); } });
    const res = await a.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(await auth.signToken()) });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: { code: 'auth_unavailable', message: 'Authentication is temporarily unavailable' } });
    expect(logs).toContain('token verification unavailable');
  });

  it('does not serve customer routes when the customer API is not configured', async () => {
    const res = await app({ customer: false }).inject({ method: 'GET', url: '/api/v1/me', headers: bearer(await auth.signToken()) });
    expect(res.statusCode).toBe(404);
  });

  it('grants CORS only to the dashboard origin, including preflight', async () => {
    const a = app();
    const evil = await a.inject({ method: 'GET', url: '/api/v1/me', headers: { origin: 'https://evil.example' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const ok = await a.inject({ method: 'GET', url: '/api/v1/me', headers: { origin: DASHBOARD_ORIGIN } });
    expect(ok.headers['access-control-allow-origin']).toBe(DASHBOARD_ORIGIN);
    const pre = await a.inject({
      method: 'OPTIONS', url: '/api/v1/instances',
      headers: { origin: DASHBOARD_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type, idempotency-key' },
    });
    expect(pre.statusCode).toBeLessThan(300);
    expect(pre.headers['access-control-allow-origin']).toBe(DASHBOARD_ORIGIN);
    const evilPre = await a.inject({
      method: 'OPTIONS', url: '/api/v1/instances',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(evilPre.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never writes a token to the logs', async () => {
    const token = await auth.signToken({ aud: 'anon' });
    await app().inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) });
    const good = await auth.signToken();
    await app().inject({ method: 'GET', url: '/api/v1/me', headers: bearer(good) });
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(good);
  });
});
