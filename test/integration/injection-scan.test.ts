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
import { TEST_MASTER_KEY, seed, silentLogger } from '../helpers/service-env.js';

// A small dynamic scan: every customer, public and admin route gets SQL, script, template, traversal and oversized
// payloads in its path, query and body. Nothing may answer 500 or leak a database error, and the data must stay intact.
const prisma = createPrisma(process.env.DATABASE_URL!);
const IMAGE = 'hermes-stub:0.2.0';
const ADMIN = 'boss@nibie.app';
const CUSTOMER = 'alice@example.test';

const PAYLOADS = [
  "' OR '1'='1",
  `'; DROP TABLE "Plan"; --`,
  '" OR 1=1 --',
  '1 UNION SELECT NULL, version() --',
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  '../../../../etc/passwd',
  '${7*7}{{7*7}}<%= 7*7 %>',
  '{"$ne":null}',
  'a\u0000b',
  'x'.repeat(10_000),
];
const BODY_FIELDS = ['name', 'email', 'subject', 'message', 'category', 'planId', 'instanceId', 'reason', 'note', 'model', 'baseUrl',
  'apiKey', 'token', 'botToken', 'amountIdr', 'enabled', 'stockLimit', 'captchaToken', 'turnstileToken', 'cursor', 'status'];
const LEAK = /prisma|sqlstate|syntax error|relation "|postgres|at \S+\.(ts|js):\d+/i;

let auth: Awaited<ReturnType<typeof createTestAuth>>;

function app() {
  const service = new InstanceService({
    prisma, runtime: new FakeRuntime(), image: IMAGE, production: false, logger: silentLogger,
    masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off', pollIntervalMs: 10, healthTimeoutMs: 2000,
  });
  return buildServer({
    service, logger: silentLogger,
    config: testConfig(IMAGE, TEST_MASTER_KEY, { betaAllowedEmails: [CUSTOMER], adminEmails: [ADMIN] }),
    customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
    admin: { verify: auth.verify, prisma, audit: new AuditService({ prisma }) },
  });
}

describe('injection payload scan', () => {
  beforeAll(async () => { auth = await createTestAuth(); });
  beforeEach(async () => { await resetDb(prisma); await seed(prisma); });
  afterAll(() => prisma.$disconnect());

  it('answers every route with a client error or success, never a 500 or a database error', async () => {
    const a = app();
    const routes: Array<{ method: string; url: string }> = [];
    a.addHook('onRoute', (r) => {
      for (const method of [r.method].flat()) {
        if (method !== 'HEAD' && method !== 'OPTIONS') routes.push({ method, url: r.url });
      }
    });
    await a.ready();
    // The operator API (`/tenants/*`, ADMIN_TOKEN) is loopback-only behind the proxy; its other routes answer 401 here.
    // The webhook is signature-checked before anything else.
    const scanned = routes.filter((r) => r.url.startsWith('/api/v1/') && !r.url.startsWith('/api/v1/tenants') && !r.url.includes('/webhook'));
    expect(scanned.length).toBeGreaterThan(30);
    const plansBefore = await prisma.plan.count();
    const failures: string[] = [];

    for (const route of scanned) {
      for (const [i, p] of PAYLOADS.entries()) {
        // A fresh identity and address per request, so the rate limits never hide a response behind a 429.
        const sub = randomUUID();
        const authorization = route.url.startsWith('/api/v1/admin')
          ? `Bearer ${await auth.signToken({ sub, email: ADMIN, aal: 'aal2' })}`
          : route.url.startsWith('/api/v1/public') ? undefined : `Bearer ${await auth.signToken({ sub, email: CUSTOMER })}`;
        const enc = encodeURIComponent(p);
        const hasParams = route.url.includes(':');
        const url = hasParams
          ? route.url.replace(/:\w+/g, enc)
          : `${route.url}?cursor=${enc}&status=${enc}&limit=${enc}&q=${enc}&email=${enc}`;
        const body = ['POST', 'PUT', 'PATCH'].includes(route.method) ? Object.fromEntries(BODY_FIELDS.map((f) => [f, p])) : undefined;
        const res = await a.inject({
          method: route.method as 'GET', url, remoteAddress: `198.51.100.${(scanned.indexOf(route) * PAYLOADS.length + i) % 250}`,
          headers: { ...(authorization ? { authorization } : {}), 'idempotency-key': randomUUID() },
          ...(body ? { payload: body } : {}),
        });
        if (res.statusCode === 500 || LEAK.test(res.body)) failures.push(`${route.method} ${route.url} payload#${i} -> ${res.statusCode} ${res.body.slice(0, 200)}`);
      }
    }
    await a.close();
    expect(failures).toEqual([]);
    expect(await prisma.plan.count()).toBe(plansBefore);
  });

  it('stores and returns hostile text verbatim, as data', async () => {
    const a = app();
    const headers = { authorization: `Bearer ${await auth.signToken({ email: CUSTOMER })}` };
    const subject = `'; DROP TABLE "Plan"; -- <script>alert(1)</script>`;
    const message = `' OR '1'='1 "><img src=x onerror=alert(1)> \${7*7}`;
    const created = await a.inject({ method: 'POST', url: '/api/v1/support/tickets', headers, payload: { subject, category: 'OTHER', message } });
    expect(created.statusCode).toBe(201);
    const id = created.json().ticket.id as string;
    const got = await a.inject({ method: 'GET', url: `/api/v1/support/tickets/${id}`, headers });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toMatch(/^application\/json/);
    expect(got.json().ticket.subject).toBe(subject);
    expect(JSON.stringify(got.json())).toContain(JSON.stringify(message).slice(1, -1));
    expect(await prisma.plan.count()).toBe(1);
    await a.close();
  });
});
