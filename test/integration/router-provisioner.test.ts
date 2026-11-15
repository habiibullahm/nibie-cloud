import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { ProviderService } from '../../src/modules/integrations/provider-service.js';
import { NANO_PER_USD, type NibieRouterClient } from '../../src/modules/nibierouter/nibierouter-client.js';
import { MAX_ATTEMPTS, RouterProvisioner } from '../../src/modules/nibierouter/router-provisioner.js';
import { PrismaSecretStore } from '../../src/modules/secrets/secret-store.js';
import { RouterUnavailableError } from '../../src/shared/errors.js';
import { createLogger } from '../../src/shared/logger.js';
import { resetDb } from '../helpers/db.js';
import { seedBilling } from '../helpers/billing-env.js';

// Postgres only: the router is an in-memory fake that behaves like the real one where it matters
// (a secret is shown once, a credit grant is not idempotent).
const prisma = createPrisma(process.env.DATABASE_URL!);
const CREDIT = 2n * NANO_PER_USD;

class FakeRouter implements NibieRouterClient {
  users = 0;
  keys: { userId: string; name: string; revoked: boolean }[] = [];
  history: { userId: string; note: string; delta: bigint }[] = [];
  balance = 0n;
  failNext: ('createUser' | 'createKey' | 'grantCredit' | 'hasCreditNote' | 'listKeys')[] = [];
  /** grantCredit reaches the ledger but the answer is lost. */
  loseGrantAnswer = false;
  calls: string[] = [];

  private maybeFail(op: (typeof this.failNext)[number]) {
    this.calls.push(op);
    const i = this.failNext.indexOf(op);
    if (i >= 0) { this.failNext.splice(i, 1); throw new RouterUnavailableError('unreachable'); }
  }
  async createUser() { this.maybeFail('createUser'); this.users += 1; return { id: `ru-${this.users}` }; }
  async grantCredit(userId: string, delta: bigint, note: string) {
    this.maybeFail('grantCredit');
    this.history.push({ userId, note, delta });
    this.balance += delta;
    if (this.loseGrantAnswer) { this.loseGrantAnswer = false; throw new RouterUnavailableError('unreachable'); }
    return { balanceNano: this.balance };
  }
  async hasCreditNote(userId: string, note: string) { this.maybeFail('hasCreditNote'); return this.history.some((h) => h.userId === userId && h.note === note); }
  async createKey(userId: string, input: { name: string }) {
    this.maybeFail('createKey');
    this.keys.push({ userId, name: input.name, revoked: false });
    return { id: `k-${this.keys.length}`, secret: `sk-fake-${input.name}-0123456789` };
  }
  async listKeys(userId: string) { this.maybeFail('listKeys'); return this.keys.filter((k) => k.userId === userId).map((k) => ({ name: k.name, revoked: k.revoked })); }
}

let s: Awaited<ReturnType<typeof seedBilling>>;
let router: FakeRouter;
let secrets: PrismaSecretStore;
let providers: ProviderService;
let prov: RouterProvisioner;
let applied: string[];
let applyFails = false;

async function mk(o: { credit?: bigint | null } = {}) {
  const plan = await prisma.plan.update({ where: { id: s.plan.id }, data: { includedCreditNano: o.credit === undefined ? CREDIT : o.credit } });
  const instance = await prisma.instance.create({
    data: { tenantId: s.tenant.id, planId: plan.id, nodeId: s.node.id, name: 'x', idempotencyKey: crypto.randomUUID(), image: 'hermes-stub:0.2.0', status: 'ACTIVE' },
  });
  const sub = await prisma.subscription.create({
    data: { tenantId: s.tenant.id, planId: plan.id, instanceId: instance.id, intendedName: 'x', status: 'ACTIVE', currentPeriodEnd: new Date('2027-01-01T00:00:00Z') },
  });
  return { instance, sub };
}
const rowOf = (instanceId: string) => prisma.routerProvisioning.findUniqueOrThrow({ where: { instanceId } });

describe('RouterProvisioner', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seedBilling(prisma);
    router = new FakeRouter();
    secrets = new PrismaSecretStore({ prisma, current: { version: 1, key: randomBytes(32) }, previous: null });
    const logger = createLogger({ level: 'silent' });
    providers = new ProviderService({ prisma, secrets, logger, fetcher: async () => ({ status: 200, headers: {}, body: '{}' }) });
    applied = [];
    applyFails = false;
    prov = new RouterProvisioner({
      prisma, client: router, providers, cfg: { defaultModel: 'model-x', emailDomain: 'cloud.example.test' }, logger,
      applyConfig: async (_t, i) => { if (applyFails) throw new Error('busy'); applied.push(i); },
    });
  });
  afterAll(() => prisma.$disconnect());

  it('creates the user, attaches a per-instance key and grants the credit once', async () => {
    const { instance, sub } = await mk();
    expect(await prov.begin({ tenantId: s.tenant.id, instanceId: instance.id, subscriptionId: sub.id })).toBe('done');
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: s.tenant.id } })).routerUserId).toBe('ru-1');
    expect(router.keys).toEqual([{ userId: 'ru-1', name: `inst-${instance.id}`, revoked: false }]);
    expect(router.history).toEqual([{ userId: 'ru-1', note: `nibie-cloud credit ${sub.id}`, delta: CREDIT }]);
    const cfg = await prisma.providerConfig.findUniqueOrThrow({ where: { instanceId: instance.id } });
    expect(cfg).toMatchObject({ kind: 'NIBIEROUTER', model: 'model-x' });
    expect((await prisma.instance.findUniqueOrThrow({ where: { id: instance.id } })).configRevision).toBeGreaterThan(0);
    expect(await rowOf(instance.id)).toMatchObject({ status: 'DONE', lastError: null });
    expect(await prisma.creditGrant.findUniqueOrThrow({ where: { subscriptionId: sub.id } })).toMatchObject({ status: 'DONE', balanceAfterNano: CREDIT });
  });

  it('restarts the instance once after attaching the key, and a failed restart does not undo the provisioning', async () => {
    const { instance, sub } = await mk({ credit: null });
    await prov.begin({ tenantId: s.tenant.id, instanceId: instance.id, subscriptionId: sub.id });
    expect(applied).toEqual([instance.id]);
    await prov.run(instance.id);
    expect(applied).toEqual([instance.id]);

    applyFails = true;
    const b = await mk({ credit: null });
    expect(await prov.begin({ tenantId: s.tenant.id, instanceId: b.instance.id, subscriptionId: b.sub.id })).toBe('done');
    expect(await prisma.providerConfig.count({ where: { instanceId: b.instance.id } })).toBe(1);
  });

  it('is idempotent: running again changes nothing at the router', async () => {
    const { instance, sub } = await mk();
    await prov.begin({ tenantId: s.tenant.id, instanceId: instance.id, subscriptionId: sub.id });
    const before = { users: router.users, keys: router.keys.length, hist: router.history.length, calls: router.calls.length };
    await prov.begin({ tenantId: s.tenant.id, instanceId: instance.id, subscriptionId: sub.id });
    await prov.run(instance.id);
    expect({ users: router.users, keys: router.keys.length, hist: router.history.length, calls: router.calls.length }).toEqual(before);
  });

  it('a plan without credit gets a key and no grant', async () => {
    const { instance, sub } = await mk({ credit: null });
    await prov.begin({ tenantId: s.tenant.id, instanceId: instance.id, subscriptionId: sub.id });
    expect(router.keys).toHaveLength(1);
    expect(router.history).toHaveLength(0);
    expect(await prisma.creditGrant.count()).toBe(0);
  });

  it('one router user per tenant, one key per instance', async () => {
    const a = await mk({ credit: null });
    await prov.begin({ tenantId: s.tenant.id, instanceId: a.instance.id, subscriptionId: a.sub.id });
    const instance2 = await prisma.instance.create({
      data: { tenantId: s.tenant.id, planId: s.plan.id, nodeId: s.node.id, name: 'y', idempotencyKey: crypto.randomUUID(), image: 'hermes-stub:0.2.0', status: 'ACTIVE' },
    });
    await prov.begin({ tenantId: s.tenant.id, instanceId: instance2.id, subscriptionId: null });
    expect(router.users).toBe(1);
    expect(router.keys.map((k) => k.name)).toEqual([`inst-${a.instance.id}`, `inst-${instance2.id}`]);
  });

  it('two runs at once create one router user', async () => {
    const a = await mk({ credit: null });
    const instance2 = await prisma.instance.create({
      data: { tenantId: s.tenant.id, planId: s.plan.id, nodeId: s.node.id, name: 'y', idempotencyKey: crypto.randomUUID(), image: 'hermes-stub:0.2.0', status: 'ACTIVE' },
    });
    await Promise.all([
      prov.begin({ tenantId: s.tenant.id, instanceId: a.instance.id, subscriptionId: a.sub.id }),
      prov.begin({ tenantId: s.tenant.id, instanceId: instance2.id, subscriptionId: null }),
    ]);
    expect(router.users).toBe(1);
  });

  it('an instance with its own provider keeps it, and a credit-less plan makes no router call at all', async () => {
    const { instance, sub } = await mk({ credit: null });
    await providers.put(s.tenant.id, instance.id, { baseUrl: 'https://llm.example.com/v1', model: 'own', apiKey: 'sk-own-key-0123456789' });
    expect(await prov.begin({ tenantId: s.tenant.id, instanceId: instance.id, subscriptionId: sub.id })).toBe('done');
    expect(router.calls).toEqual([]);
    expect((await prisma.providerConfig.findUniqueOrThrow({ where: { instanceId: instance.id } })).kind).toBe('BYOK');
  });

  it('an instance with its own provider still receives the included credit, without a new key', async () => {
    const { instance, sub } = await mk();
    await providers.put(s.tenant.id, instance.id, { baseUrl: 'https://llm.example.com/v1', model: 'own', apiKey: 'sk-own-key-0123456789' });
    await prov.begin({ tenantId: s.tenant.id, instanceId: instance.id, subscriptionId: sub.id });
    expect(router.keys).toHaveLength(0);
    expect(router.history).toHaveLength(1);
    expect((await prisma.providerConfig.findUniqueOrThrow({ where: { instanceId: instance.id } })).kind).toBe('BYOK');
  });

  it('a router outage leaves the row PENDING with a short code, and the tick finishes it later', async () => {
    const { instance, sub } = await mk();
    router.failNext = ['createUser'];
    expect(await prov.begin({ tenantId: s.tenant.id, instanceId: instance.id, subscriptionId: sub.id })).toBe('pending');
    expect(await rowOf(instance.id)).toMatchObject({ status: 'PENDING', lastError: 'router_unreachable', attempts: 1 });
    expect(await prov.runPending()).toBe(1);
    expect(await rowOf(instance.id)).toMatchObject({ status: 'DONE', lastError: null, attempts: 2 });
    expect(router.history).toHaveLength(1);
  });

  it('a failed key creation does not repeat the user, and the retry attaches the key', async () => {
    const { instance, sub } = await mk();
    router.failNext = ['createKey'];
    await prov.begin({ tenantId: s.tenant.id, instanceId: instance.id, subscriptionId: sub.id });
    await prov.runPending();
    expect(router.users).toBe(1);
    expect(router.keys).toHaveLength(1);
    expect(await prisma.providerConfig.count({ where: { instanceId: instance.id } })).toBe(1);
  });

  it('credit is granted exactly once when the answer of the grant was lost', async () => {
    const { instance, sub } = await mk();
    router.loseGrantAnswer = true;
    expect(await prov.begin({ tenantId: s.tenant.id, instanceId: instance.id, subscriptionId: sub.id })).toBe('pending');
    expect(router.history).toHaveLength(1); // it did reach the router
    expect(await prov.runPending()).toBe(1);
    expect(router.history).toHaveLength(1); // the retry found the note and did not post again
    expect(router.balance).toBe(CREDIT);
    expect(await prisma.creditGrant.findUniqueOrThrow({ where: { subscriptionId: sub.id } })).toMatchObject({ status: 'DONE' });
  });

  it('when the history cannot be checked after an ambiguous grant, it does not post again', async () => {
    const { instance, sub } = await mk();
    router.loseGrantAnswer = true;
    await prov.begin({ tenantId: s.tenant.id, instanceId: instance.id, subscriptionId: sub.id });
    router.failNext = ['hasCreditNote', 'hasCreditNote'];
    await prov.run(instance.id);
    await prov.run(instance.id);
    expect(router.history).toHaveLength(1);
    expect(await prov.run(instance.id)).toBe('done');
    expect(router.history).toHaveLength(1);
  });

  it('an unrevoked key of the same name that we hold no secret for blocks the run with orphan_key', async () => {
    const { instance, sub } = await mk({ credit: null });
    await prov.begin({ tenantId: s.tenant.id, instanceId: instance.id, subscriptionId: sub.id });
    await prisma.providerConfig.deleteMany({ where: { instanceId: instance.id } }); // the secret is gone, the router key stays
    await prisma.routerProvisioning.update({ where: { instanceId: instance.id }, data: { status: 'PENDING' } });
    expect(await prov.run(instance.id)).toBe('pending');
    expect(await rowOf(instance.id)).toMatchObject({ lastError: 'orphan_key' });
    expect(router.keys).toHaveLength(1);
    router.keys[0]!.revoked = true; // the operator revoked it
    expect(await prov.run(instance.id)).toBe('done');
    expect(router.keys).toHaveLength(2);
  });

  it('skips a deleted instance', async () => {
    const { instance, sub } = await mk();
    await prisma.instance.update({ where: { id: instance.id }, data: { status: 'DELETED' } });
    expect(await prov.begin({ tenantId: s.tenant.id, instanceId: instance.id, subscriptionId: sub.id })).toBe('skipped');
    expect(router.calls).toEqual([]);
  });

  it('runPending creates the row for an instance that was linked but never recorded, and stops at MAX_ATTEMPTS', async () => {
    const { instance } = await mk({ credit: null });
    expect(await prisma.routerProvisioning.count()).toBe(0);
    expect(await prov.runPending()).toBe(1);
    expect((await rowOf(instance.id)).status).toBe('DONE');

    const b = await mk({ credit: null });
    await prisma.routerProvisioning.create({ data: { instanceId: b.instance.id, tenantId: s.tenant.id, subscriptionId: b.sub.id, attempts: MAX_ATTEMPTS } });
    // (a second subscription for the same tenant is fine here: the unique key is the instance)
    expect(await prov.runPending()).toBe(0);
    expect((await rowOf(b.instance.id)).status).toBe('PENDING');
  });

  it('never stores the router secret in the provisioning row or leaks it in lastError', async () => {
    const { instance, sub } = await mk();
    router.failNext = ['grantCredit'];
    await prov.begin({ tenantId: s.tenant.id, instanceId: instance.id, subscriptionId: sub.id });
    const row = JSON.stringify(await rowOf(instance.id));
    expect(row).not.toContain('sk-fake');
  });
});
