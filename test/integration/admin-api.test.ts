import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/env.js';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { IdentityService } from '../../src/modules/auth/identity-service.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { AuditService } from '../../src/modules/admin/audit-service.js';
import { silentLogger } from '../helpers/service-env.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { createTestAuth, testConfig } from '../helpers/auth.js';
import { resetDb } from '../helpers/db.js';
import { TEST_MASTER_KEY, seed } from '../helpers/service-env.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const IMAGE = 'hermes-stub:0.2.0';
const BOSS = 'boss@nibie.app';

let auth: Awaited<ReturnType<typeof createTestAuth>>;
let s: Awaited<ReturnType<typeof seed>>;

function app(cfg: Partial<Config> = {}) {
  const service = new InstanceService({ prisma, runtime: new FakeRuntime(), image: IMAGE, production: false, logger: silentLogger, masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off' });
  return buildServer({
    service, logger: silentLogger,
    config: testConfig(IMAGE, TEST_MASTER_KEY, { adminEmails: [BOSS], betaAllowedEmails: ['alice@example.test'], ...cfg }),
    customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
    admin: { verify: auth.verify, prisma, audit: new AuditService({ prisma }) },
  });
}
const read = (a: ReturnType<typeof app>, url: string, token: string) =>
  a.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
const boss = async (aal: string = 'aal2') => auth.signToken({ email: BOSS, aal });
const alice = async () => auth.signToken({ email: 'alice@example.test', aal: 'aal2' });

/** Provisions one instance for alice through the customer API, the way a real tenant would. */
async function provision(a: ReturnType<typeof app>): Promise<{ id: string; tenantId: string }> {
  const created = await a.inject({
    method: 'POST', url: '/api/v1/instances',
    headers: { authorization: `Bearer ${await alice()}`, 'idempotency-key': randomUUID() },
    payload: { name: 'agent', planId: s.plan.id },
  });
  expect(created.statusCode).toBe(202);
  return created.json().instance as { id: string; tenantId: string };
}

describe('admin read API', () => {
  beforeAll(async () => { auth = await createTestAuth(); });
  beforeEach(async () => { await resetDb(prisma); s = await seed(prisma); });
  afterAll(() => prisma.$disconnect());

  it('lists customers with their tenant, email and instance count', async () => {
    const a = app();
    const inst = await provision(a);
    const res = await read(a, '/api/v1/admin/customers', await boss());
    expect(res.statusCode).toBe(200);
    const { customers } = res.json() as { customers: { tenantId: string; email: string; instanceCount: number }[] };
    // `seed()` creates two empty tenants besides the real customer, so find ours rather than assume one.
    const mine = customers.filter((c) => c.email !== null);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ tenantId: inst.tenantId, email: 'alice@example.test', instanceCount: 1 });
    expect(customers.find((c) => c.tenantId === inst.tenantId)?.instanceCount).toBe(1);
  });

  it('searches customers by email (case-insensitive) and never returns a secret', async () => {
    const a = app();
    await provision(a);
    const hit = await read(a, '/api/v1/admin/customers?q=ALICE', await boss());
    expect((hit.json() as { customers: unknown[] }).customers).toHaveLength(1);
    const miss = await read(a, '/api/v1/admin/customers?q=nobody', await boss());
    expect((miss.json() as { customers: unknown[] }).customers).toHaveLength(0);
    expect(JSON.stringify(hit.json())).not.toMatch(/ciphertext|wrappedKey|apiKey|Bearer /);
  });

  it('reads one customer with their instances, subscriptions and payments', async () => {
    const a = app();
    const inst = await provision(a);
    const res = await read(a, `/api/v1/admin/customers/${inst.tenantId}`, await boss());
    expect(res.statusCode).toBe(200);
    const body = res.json() as { customer: { email: string }; instances: { id: string }[] };
    expect(body.customer.email).toBe('alice@example.test');
    expect(body.instances.map((i) => i.id)).toContain(inst.id);
  });

  it('answers 404 for an unknown customer, not an empty body', async () => {
    const res = await read(app(), `/api/v1/admin/customers/${randomUUID()}`, await boss());
    expect(res.statusCode).toBe(404);
  });

  it('lists instances across tenants with the owner email, and filters by status', async () => {
    const a = app();
    const inst = await provision(a);
    const all = await read(a, '/api/v1/admin/instances', await boss());
    const rows = (all.json() as { instances: { id: string; email: string; status: string }[] }).instances;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: inst.id, email: 'alice@example.test' });
    const active = await read(a, '/api/v1/admin/instances?status=ACTIVE', await boss());
    expect((active.json() as { instances: unknown[] }).instances).toHaveLength(1);
    const stopped = await read(a, '/api/v1/admin/instances?status=STOPPED', await boss());
    expect((stopped.json() as { instances: unknown[] }).instances).toHaveLength(0);
  });

  it('reads one instance with its events, and 404s for an unknown id', async () => {
    const a = app();
    const inst = await provision(a);
    const res = await read(a, `/api/v1/admin/instances/${inst.id}`, await boss());
    expect(res.statusCode).toBe(200);
    const body = res.json() as { instance: { id: string }; events: unknown[] };
    expect(body.instance.id).toBe(inst.id);
    expect(body.events.length).toBeGreaterThan(0);
    expect((await read(a, `/api/v1/admin/instances/${randomUUID()}`, await boss())).statusCode).toBe(404);
  });

  it('lists plans, including inactive ones, with their price and credit', async () => {
    await prisma.plan.create({ data: { slug: 'retired', name: 'Retired', active: false, cpuMillis: 100, memoryMb: 64, pids: 32, storageMb: 128 } });
    const res = await read(app(), '/api/v1/admin/plans', await boss());
    const { plans } = res.json() as { plans: { slug: string; active: boolean }[] };
    expect(plans.map((p) => p.slug).sort()).toEqual(['retired', 'test-small']);
    expect(plans.find((p) => p.slug === 'retired')?.active).toBe(false);
  });

  it('lists runtime nodes and their instance counts', async () => {
    const a = app();
    await provision(a);
    const res = await read(a, '/api/v1/admin/nodes', await boss());
    const { nodes } = res.json() as { nodes: { name: string; instanceCount: number }[] };
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ name: 'local', instanceCount: 1 });
  });

  it('reports an overview: counts by status and the billing/router switches', async () => {
    const a = app();
    await provision(a);
    const res = await read(a, '/api/v1/admin/overview', await boss());
    expect(res.statusCode).toBe(200);
    const body = res.json() as { counts: Record<string, number>; system: { billing: boolean; router: boolean; redis: boolean } };
    // Three tenants: the real customer plus the two empty ones `seed()` creates.
    expect(body.counts.customers).toBe(3);
    expect(body.counts.instances).toBe(1);
    expect(body.counts.activeInstances).toBe(1);
    expect(body.system).toEqual({ billing: false, router: false, redis: false });
  });

  it('lists failed jobs and the audit trail', async () => {
    const a = app();
    const audit = new AuditService({ prisma });
    await audit.record({ actorEmail: BOSS, action: 'GET /api/v1/admin/overview', targetType: null, targetId: null, reason: null, detail: null });
    const jobs = await read(a, '/api/v1/admin/jobs/failed', await boss());
    // No queue in this build: an explicit 503, not an empty list that looks healthy.
    expect(jobs.statusCode).toBe(503);
    expect(jobs.json().error.code).toBe('queue_unavailable');
    const trail = await read(a, '/api/v1/admin/audit', await boss());
    expect((trail.json() as { entries: { action: string }[] }).entries.map((e) => e.action)).toContain('GET /api/v1/admin/overview');
  });

  it('never answers with a stored secret, on any read route', async () => {
    const a = app();
    const inst = await provision(a);
    const token = await boss();
    // A real secret row, so a leak would have something to leak.
    await prisma.secret.create({
      data: {
        tenantId: inst.tenantId, purpose: 'provider:openai', ciphertext: 'CIPHERTEXT-MARKER', iv: 'i', tag: 't',
        wrappedKey: 'WRAPPEDKEY-MARKER', wrapIv: 'wi', wrapTag: 'wt', kekVersion: 1, keyHint: 'abcd',
      },
    });
    for (const url of [
      '/api/v1/admin/overview', '/api/v1/admin/customers', `/api/v1/admin/customers/${inst.tenantId}`,
      '/api/v1/admin/instances', `/api/v1/admin/instances/${inst.id}`, '/api/v1/admin/plans', '/api/v1/admin/nodes',
      '/api/v1/admin/subscriptions', '/api/v1/admin/payments', '/api/v1/admin/audit', '/api/v1/admin/system',
    ]) {
      const res = await read(a, url, token);
      expect(res.statusCode, url).toBeLessThan(400);
      expect(JSON.stringify(res.json()), url).not.toMatch(/CIPHERTEXT-MARKER|WRAPPEDKEY-MARKER|ciphertext|wrappedKey/);
    }
  });

  it('is read-only: Fase A exposes no mutating admin route at all', async () => {
    const a = app();
    const inst = await provision(a);
    // The aal2 rule itself is unit-tested on `assertAdminAllowed`; here we assert the surface is read-only.
    for (const [method, url] of [
      ['POST', `/api/v1/admin/instances/${inst.id}/restart`],
      ['POST', `/api/v1/admin/instances/${inst.id}/stop`],
      ['PUT', `/api/v1/admin/plans/${s.plan.id}`],
      ['POST', '/api/v1/admin/settings/signup'],
    ] as const) {
      const res = await a.inject({ method, url, headers: { authorization: `Bearer ${await boss()}` } });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('refuses a non-admin on every read route', async () => {
    const a = app();
    const token = await alice();
    for (const url of ['/api/v1/admin/overview', '/api/v1/admin/customers', '/api/v1/admin/instances', '/api/v1/admin/plans', '/api/v1/admin/audit']) {
      const res = await read(a, url, token);
      expect(res.statusCode, url).toBe(403);
    }
  });
});
