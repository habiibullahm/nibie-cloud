import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/env.js';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { IdentityService } from '../../src/modules/auth/identity-service.js';
import { addInvite, isInvited, listInvites, normalizeEmail, revokeInvite } from '../../src/modules/beta/invites.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { createTestAuth, testConfig } from '../helpers/auth.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { TEST_MASTER_KEY, seed, silentLogger } from '../helpers/service-env.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const IMAGE = 'hermes-stub:0.2.0';
const ENV_ONLY = 'env-only@example.test';
const TABLE_ONLY = 'table-only@example.test';
const STRANGER = 'stranger@example.test';

let auth: Awaited<ReturnType<typeof createTestAuth>>;
let s: Awaited<ReturnType<typeof seed>>;

/** Free beta slots are 0 here, so the invite lists are the only way to deploy. */
function app(cfg: Partial<Config> = {}) {
  const service = new InstanceService({
    prisma, runtime: new FakeRuntime(), image: IMAGE, production: false, logger: silentLogger,
    masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off', pollIntervalMs: 10, healthTimeoutMs: 2000,
  });
  return buildServer({
    service, logger: silentLogger,
    config: testConfig(IMAGE, TEST_MASTER_KEY, { betaAllowedEmails: [ENV_ONLY], freeBetaSlots: 0, ...cfg }),
    customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
  });
}

async function user(email: string) {
  const token = await auth.signToken({ sub: randomUUID(), email });
  return { authorization: `Bearer ${token}` };
}
const plansFor = async (a: ReturnType<typeof app>, headers: Record<string, string>) =>
  ((await a.inject({ method: 'GET', url: '/api/v1/plans', headers })).json().plans as Array<{ slug: string }>).map((p) => p.slug);
const create = (a: ReturnType<typeof app>, headers: Record<string, string>) =>
  a.inject({ method: 'POST', url: '/api/v1/instances', headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { name: 'agent', planId: s.plan.id } });

describe('beta invite list', () => {
  beforeAll(async () => { auth = await createTestAuth(); });
  beforeEach(async () => { await resetDb(prisma); s = await seed(prisma); });
  afterAll(() => prisma.$disconnect());

  describe('service', () => {
    it('stores the address trimmed and lowercase and matches it any way it is typed', async () => {
      expect(normalizeEmail('  Mixed.Case@Example.TEST ')).toBe('mixed.case@example.test');
      const row = await addInvite(prisma, { email: '  Mixed.Case@Example.TEST ', note: 'friend', addedBy: 'admin@example.test' });
      expect(row).toMatchObject({ email: 'mixed.case@example.test', note: 'friend', addedBy: 'admin@example.test', revokedAt: null });
      expect(await isInvited(prisma, 'MIXED.case@example.test')).toBe(true);
      expect(await isInvited(prisma, 'someone-else@example.test')).toBe(false);
    });

    it('adding the same address twice keeps one row', async () => {
      const first = await addInvite(prisma, { email: TABLE_ONLY });
      const second = await addInvite(prisma, { email: TABLE_ONLY.toUpperCase(), note: 'again' });
      expect(second.id).toBe(first.id);
      expect(await prisma.betaInvite.count()).toBe(1);
      expect(second.note).toBe('again');
    });

    it('revokes without deleting, reports whether anything was revoked, and re-adding restores access', async () => {
      await addInvite(prisma, { email: TABLE_ONLY });
      expect(await revokeInvite(prisma, TABLE_ONLY)).toBe(true);
      expect(await isInvited(prisma, TABLE_ONLY)).toBe(false);
      expect(await revokeInvite(prisma, TABLE_ONLY)).toBe(false);
      expect(await revokeInvite(prisma, 'never-invited@example.test')).toBe(false);
      expect(await prisma.betaInvite.count()).toBe(1);
      await addInvite(prisma, { email: TABLE_ONLY });
      expect(await isInvited(prisma, TABLE_ONLY)).toBe(true);
    });

    it('lists active invites newest first, and revoked ones only on request', async () => {
      await addInvite(prisma, { email: 'a@example.test' });
      await new Promise((r) => setTimeout(r, 5));
      await addInvite(prisma, { email: 'b@example.test' });
      await addInvite(prisma, { email: 'c@example.test' });
      await revokeInvite(prisma, 'b@example.test');
      expect((await listInvites(prisma)).map((r) => r.email)).toEqual(['c@example.test', 'a@example.test']);
      expect((await listInvites(prisma, { includeRevoked: true })).map((r) => r.email).sort()).toEqual(['a@example.test', 'b@example.test', 'c@example.test']);
    });
  });

  describe('customer API with zero free slots', () => {
    it('lets an account on the env list deploy, as before', async () => {
      const a = app();
      const h = await user(ENV_ONLY);
      expect(await plansFor(a, h)).toEqual(['test-small']);
      expect((await create(a, h)).statusCode).toBe(202);
    });

    it('lets an account that only has a table invite see the free plan and deploy', async () => {
      await addInvite(prisma, { email: TABLE_ONLY });
      const a = app();
      const h = await user(TABLE_ONLY.toUpperCase());
      expect(await plansFor(a, h)).toEqual(['test-small']);
      expect((await create(a, h)).statusCode).toBe(202);
    });

    it('refuses an unlisted account: no free plan, 403 provisioning_not_enabled', async () => {
      const a = app();
      const h = await user(STRANGER);
      expect(await plansFor(a, h)).toEqual([]);
      const res = await create(a, h);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('provisioning_not_enabled');
      expect(await prisma.instance.count()).toBe(0);
    });

    it('refuses an account whose invite was revoked, and accepts it again when re-invited', async () => {
      await addInvite(prisma, { email: TABLE_ONLY });
      await revokeInvite(prisma, TABLE_ONLY);
      const a = app();
      const h = await user(TABLE_ONLY);
      expect(await plansFor(a, h)).toEqual([]);
      expect((await create(a, h)).statusCode).toBe(403);
      await addInvite(prisma, { email: TABLE_ONLY });
      expect(await plansFor(a, h)).toEqual(['test-small']);
      expect((await create(a, h)).statusCode).toBe(202);
    });

    it('takes effect without a restart: an invite added while the server runs applies to the next request', async () => {
      const a = app();
      const h = await user(STRANGER);
      expect((await create(a, h)).statusCode).toBe(403);
      await addInvite(prisma, { email: STRANGER });
      expect((await create(a, h)).statusCode).toBe(202);
    });
  });
});
