import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { IdentityService } from '../../src/modules/auth/identity-service.js';
import { moveWallet } from '../../src/modules/billing/wallet.js';
import { InstanceService } from '../../src/modules/instances/instance-service.js';
import { AiAccountService } from '../../src/modules/nibierouter/ai-account.js';
import { applyGrant } from '../../src/modules/nibierouter/credit-grant.js';
import { NANO_PER_USD, type NibieRouterClient, type RouterUsage } from '../../src/modules/nibierouter/nibierouter-client.js';
import { RouterUnavailableError } from '../../src/shared/errors.js';
import { createTestAuth, testConfig } from '../helpers/auth.js';
import { resetDb } from '../helpers/db.js';
import { FakeRuntime } from '../helpers/fake-runtime.js';
import { TEST_MASTER_KEY, silentLogger } from '../helpers/service-env.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const IMAGE = 'hermes-stub:0.2.0';
const RATE = 16_000;

/** Records every credit posted; `down` makes the call fail, `lostAnswer` posts it but fails the answer. */
class FakeRouter {
  grants: { userId: string; nano: bigint; note: string }[] = [];
  down = false;
  lostAnswer = false;
  async grantCredit(userId: string, nano: bigint, note: string) {
    if (this.down) throw new RouterUnavailableError('unreachable');
    this.grants.push({ userId, nano, note });
    if (this.lostAnswer) throw new RouterUnavailableError('unreachable');
    return { balanceNano: nano };
  }
  async hasCreditNote(userId: string, note: string) {
    return this.grants.some((g) => g.userId === userId && g.note === note);
  }
  async getUsage(): Promise<RouterUsage> {
    return { balanceNano: 0n, spend30dNano: 0n, daily: [], models: [] };
  }
  async getIdrPerUsd() {
    return RATE;
  }
}

let auth: Awaited<ReturnType<typeof createTestAuth>>;
let router: FakeRouter;
let clock: number;

const service = (buy = true) =>
  new AiAccountService({ prisma, client: router as unknown as NibieRouterClient, logger: silentLogger, buy, now: () => clock });

function app(ai: AiAccountService) {
  const inst = new InstanceService({ prisma, runtime: new FakeRuntime(), image: IMAGE, production: false, logger: silentLogger, masterKey: TEST_MASTER_KEY, diskQuota: 'off', egressPolicy: 'off' });
  return buildServer({
    service: inst, logger: silentLogger,
    config: testConfig(IMAGE, TEST_MASTER_KEY),
    customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
    ai,
  });
}
type App = ReturnType<typeof app>;

/** A customer with a router user and `balanceIdr` in the wallet. */
async function customer(a: App, balanceIdr = 100_000) {
  const headers = { authorization: `Bearer ${await auth.signToken({ sub: randomUUID(), email: `c-${randomUUID().slice(0, 8)}@example.test` })}` };
  const me = (await a.inject({ method: 'GET', url: '/api/v1/me', headers })).json() as { tenantId: string };
  await prisma.tenant.update({ where: { id: me.tenantId }, data: { routerUserId: `ru-${me.tenantId}` } });
  if (balanceIdr > 0) {
    await prisma.$transaction((tx) => moveWallet(tx, { tenantId: me.tenantId, amountIdr: balanceIdr, kind: 'ADMIN_CREDIT', refId: randomUUID() }));
  }
  return { headers, tenantId: me.tenantId, userId: `ru-${me.tenantId}` };
}

const buy = (a: App, headers: Record<string, string>, amountIdr: number, key = randomUUID()) =>
  a.inject({ method: 'POST', url: '/api/v1/ai/credit', headers: { ...headers, 'idempotency-key': key }, payload: { amountIdr } });

const balance = async (tenantId: string) => (await prisma.wallet.findUnique({ where: { tenantId } }))?.balanceIdr ?? 0;

describe('buying AI credit from the wallet (Rupiah)', () => {
  beforeAll(async () => { auth = await createTestAuth(); });
  beforeEach(async () => {
    await resetDb(prisma);
    router = new FakeRouter();
    clock = Date.now();
  });
  afterAll(() => prisma.$disconnect());

  it('takes the Rupiah from the wallet and credits the router once at the rate, rounded down; a replay buys nothing more', async () => {
    const a = app(service());
    const c = await customer(a);
    const key = randomUUID();
    const res = await buy(a, c.headers, 50_000, key);
    expect(res.statusCode).toBe(201);
    const nano = (50_000n * NANO_PER_USD) / BigInt(RATE);
    expect(res.json().purchase).toMatchObject({ amountIdr: 50_000, amountUsd: Number(nano) / 1e9, status: 'DONE' });
    expect(router.grants).toEqual([{ userId: c.userId, nano, note: `nibie-cloud wallet ${res.json().purchase.id}` }]);
    expect(await balance(c.tenantId)).toBe(50_000);
    const entry = await prisma.walletEntry.findFirstOrThrow({ where: { tenantId: c.tenantId, kind: 'AI_CREDIT' } });
    expect(entry).toMatchObject({ amountIdr: -50_000, refId: res.json().purchase.id, balanceAfterIdr: 50_000, note: 'Kredit AI US$3.13' });

    const again = await buy(a, c.headers, 50_000, key);
    expect(again.statusCode).toBe(201);
    expect(again.json().purchase.id).toBe(res.json().purchase.id);
    expect(router.grants).toHaveLength(1);
    expect(await balance(c.tenantId)).toBe(50_000);
    expect((await buy(a, c.headers, 20_000, key)).statusCode).toBe(409);
  });

  it('refuses without enough balance, without a router user, and outside the limits, leaving nothing behind', async () => {
    const a = app(service());
    const c = await customer(a, 30_000);
    const short = await buy(a, c.headers, 50_000);
    expect(short.statusCode).toBe(409);
    expect(short.json().error.code).toBe('insufficient_balance');
    expect(await prisma.creditGrant.count()).toBe(0);
    expect(await balance(c.tenantId)).toBe(30_000);

    expect((await buy(a, c.headers, 9_999)).statusCode).toBe(400);
    expect((await buy(a, c.headers, 1_000_001)).statusCode).toBe(400);
    expect((await buy(a, c.headers, 10_000.5)).statusCode).toBe(400);

    await prisma.tenant.update({ where: { id: c.tenantId }, data: { routerUserId: null } });
    const none = await buy(a, c.headers, 10_000);
    expect(none.statusCode).toBe(409);
    expect(none.json().error.code).toBe('ai_account_missing');
    expect(router.grants).toHaveLength(0);
  });

  it('router down: the wallet is charged, the grant stays PENDING, and the tick delivers it once after two minutes', async () => {
    const ai = service();
    const a = app(ai);
    const c = await customer(a);
    router.down = true;
    const res = await buy(a, c.headers, 20_000);
    expect(res.statusCode).toBe(201);
    expect(res.json().purchase.status).toBe('PENDING');
    expect(await balance(c.tenantId)).toBe(80_000);

    router.down = false;
    expect(await ai.retryPurchases()).toBe(0);
    clock += 3 * 60_000;
    expect(await ai.retryPurchases()).toBe(1);
    expect(await ai.retryPurchases()).toBe(0);
    expect(router.grants).toHaveLength(1);
    expect((await prisma.creditGrant.findFirstOrThrow()).status).toBe('DONE');
  });

  it('a lost router answer is found in the history on retry, not posted again', async () => {
    const ai = service();
    const a = app(ai);
    const c = await customer(a);
    router.lostAnswer = true;
    expect((await buy(a, c.headers, 20_000)).json().purchase.status).toBe('PENDING');
    router.lostAnswer = false;
    clock += 3 * 60_000;
    expect(await ai.retryPurchases()).toBe(1);
    expect(router.grants).toHaveLength(1);
  });

  it('two runs of the same attempt post once', async () => {
    const a = app(service());
    const c = await customer(a);
    const row = await prisma.creditGrant.create({ data: { tenantId: c.tenantId, amountNano: NANO_PER_USD, amountIdr: 16_000, idempotencyKey: 'k', note: 'n-1' } });
    const out = await Promise.all([applyGrant(prisma, router, c.userId, row), applyGrant(prisma, router, c.userId, row)]);
    expect(out.sort()).toEqual(['busy', 'done']);
    expect(router.grants).toHaveLength(1);
  });

  it('without the wallet: no route, and GET /ai says buying is off', async () => {
    const a = app(service(false));
    const c = await customer(a, 0);
    expect((await buy(a, c.headers, 20_000)).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/api/v1/ai', headers: c.headers })).json().buy).toBeNull();
    const on = app(service());
    expect((await on.inject({ method: 'GET', url: '/api/v1/ai', headers: c.headers })).json().buy).toEqual({ minIdr: 10_000, maxIdr: 1_000_000 });
  });
});
