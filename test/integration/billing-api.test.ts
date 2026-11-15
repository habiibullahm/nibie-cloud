import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { IdentityService } from '../../src/modules/auth/identity-service.js';
import { createTestAuth, testConfig } from '../helpers/auth.js';
import { API_KEY, MERCHANT, PRICE, callbackForm, makeBilling, sign } from '../helpers/billing-env.js';
import { resetDb } from '../helpers/db.js';
import { TEST_MASTER_KEY, silentLogger } from '../helpers/service-env.js';
import { createLogger } from '../../src/shared/logger.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const CALLBACK = '/api/v1/billing/duitku/callback';
let auth: Awaited<ReturnType<typeof createTestAuth>>;
let env: ReturnType<typeof makeBilling>;
let planId: string;

const billingCfg = { gateway: 'duitku' as const, duitku: { merchantCode: MERCHANT, apiKey: API_KEY, env: 'sandbox' as const, callbackUrl: `https://api.example.test${CALLBACK}` }, sumopod: null };

function app(opts: { billingOn?: boolean } = {}) {
  const on = opts.billingOn ?? true;
  return buildServer({
    service: env.service, commands: env.commands, logger: silentLogger,
    config: testConfig('hermes-stub:0.2.0', TEST_MASTER_KEY, { billing: on ? billingCfg : null, maxInstancesPerTenant: 1 }),
    customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
    billing: on ? env.billing : null,
  });
}

async function user(email = 'owner@example.test', sub = randomUUID()) {
  return { authorization: `Bearer ${await auth.signToken({ sub, email })}` };
}
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const post = (a: ReturnType<typeof app>, body: Record<string, string>, headers: Record<string, string> = {}) =>
  a.inject({ method: 'POST', url: CALLBACK, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, payload: form(body) });
const checkout = (a: ReturnType<typeof app>, h: Record<string, string>, body: unknown = { name: 'agent', planId }, key: string = randomUUID()) =>
  a.inject({ method: 'POST', url: '/api/v1/subscriptions/checkout', headers: { ...h, 'idempotency-key': key }, payload: body as object });
const settle = () => new Promise((r) => setTimeout(r, 150));

describe('billing API', () => {
  beforeAll(async () => { auth = await createTestAuth(); });
  beforeEach(async () => {
    await resetDb(prisma);
    env = makeBilling(prisma);
    const plan = await prisma.plan.create({ data: { slug: 'test-small', name: 'Test small', cpuMillis: 500, memoryMb: 256, pids: 128, storageMb: 1024, monthlyPriceIdr: PRICE } });
    await prisma.runtimeNode.create({ data: { name: 'local', region: 'local' } });
    planId = plan.id;
  });
  afterAll(() => prisma.$disconnect());

  describe('customer routes', () => {
    it('require a token', async () => {
      const a = app();
      for (const [method, url] of [['GET', '/api/v1/subscriptions'], ['POST', '/api/v1/subscriptions/checkout'], ['GET', `/api/v1/payments/${randomUUID()}`]] as const) {
        expect((await a.inject({ method, url })).statusCode).toBe(401);
      }
    });

    it('plans show the price once set', async () => {
      const res = await app().inject({ method: 'GET', url: '/api/v1/plans', headers: await user() });
      expect(res.json().plans[0].monthlyPriceIdr).toBe(PRICE);
    });

    it('checkout returns 201 with a payment URL, replays by key, and does not leak provider fields', async () => {
      const a = app();
      const h = await user();
      const key = randomUUID();
      const res = await checkout(a, h, { name: 'agent', planId }, key);
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.payment.paymentUrl).toMatch(/^https:\/\//);
      expect(body.subscription.status).toBe('PENDING_PAYMENT');
      expect(JSON.stringify(body)).not.toMatch(/reference|merchantOrderId|REF-/);
      const again = await checkout(a, h, { name: 'agent', planId }, key);
      expect(again.json().payment.id).toBe(body.payment.id);
      const got = await a.inject({ method: 'GET', url: `/api/v1/payments/${body.payment.id}`, headers: h });
      expect(got.json().payment.id).toBe(body.payment.id);
      const list = await a.inject({ method: 'GET', url: '/api/v1/subscriptions', headers: h });
      expect(list.json().subscriptions).toHaveLength(1);
    });

    it('checkout validates the body strictly and needs an Idempotency-Key', async () => {
      const a = app();
      const h = await user();
      expect((await checkout(a, h, { name: 'agent', planId, extra: 1 })).statusCode).toBe(400);
      expect((await checkout(a, h, { name: 'agent', planId: 'nope' })).statusCode).toBe(400);
      expect((await a.inject({ method: 'POST', url: '/api/v1/subscriptions/checkout', headers: h, payload: { name: 'a', planId } })).statusCode).toBe(400);
      expect((await checkout(a, h, { name: 'agent', planId: randomUUID() })).statusCode).toBe(404);
    });

    it('answers 409 plan_not_for_sale when the plan has no price', async () => {
      await prisma.plan.update({ where: { id: planId }, data: { monthlyPriceIdr: null } });
      const res = await checkout(app(), await user());
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('plan_not_for_sale');
    });

    it('answers 503 when Duitku is unreachable', async () => {
      env.duitku.failNext = true;
      const res = await checkout(app(), await user());
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('payment_provider_unavailable');
    });

    it('another user gets 404 on every id route', async () => {
      const a = app();
      const alice = await user('alice@example.test');
      const bob = await user('bob@example.test');
      const { subscription, payment } = (await checkout(a, alice)).json();
      for (const [method, url] of [
        ['GET', `/api/v1/subscriptions/${subscription.id}`], ['POST', `/api/v1/subscriptions/${subscription.id}/renew`],
        ['POST', `/api/v1/subscriptions/${subscription.id}/cancel`], ['GET', `/api/v1/payments/${payment.id}`],
      ] as const) {
        expect((await a.inject({ method, url, headers: bob })).statusCode, `${method} ${url}`).toBe(404);
      }
      expect((await a.inject({ method: 'GET', url: '/api/v1/subscriptions', headers: bob })).json().subscriptions).toEqual([]);
    });

    it('the whole path: pay by callback, instance appears, renew, cancel', async () => {
      const a = app();
      const h = await user();
      const { payment } = (await checkout(a, h)).json();
      const orderId = (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).merchantOrderId;
      const cb = await post(a, callbackForm({ orderId }));
      expect(cb.statusCode).toBe(200);
      await settle();
      const subs = (await a.inject({ method: 'GET', url: '/api/v1/subscriptions', headers: h })).json().subscriptions;
      expect(subs[0]).toMatchObject({ status: 'ACTIVE', name: 'agent' });
      expect(subs[0].instanceId).not.toBeNull();
      const inst = await a.inject({ method: 'GET', url: `/api/v1/instances/${subs[0].instanceId}`, headers: h });
      expect(inst.json().instance.status).toBe('ACTIVE');
      const renew = await a.inject({ method: 'POST', url: `/api/v1/subscriptions/${subs[0].id}/renew`, headers: h });
      expect(renew.statusCode).toBe(201);
      expect(renew.json().payment.purpose).toBe('RENEWAL');
      const cancel = await a.inject({ method: 'POST', url: `/api/v1/subscriptions/${subs[0].id}/cancel`, headers: h });
      expect(cancel.json().subscription.cancelAtPeriodEnd).toBe(true);
    });

    it('a suspended instance cannot be started or restarted by the customer, and other tenants still see 404', async () => {
      const a = app();
      const alice = await user('alice@example.test');
      const bob = await user('bob@example.test');
      const { payment } = (await checkout(a, alice)).json();
      await post(a, callbackForm({ orderId: (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).merchantOrderId }));
      await settle();
      const sub = await prisma.subscription.findFirstOrThrow();
      await env.commands.stop(sub.tenantId, sub.instanceId!);
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'SUSPENDED', suspendedAt: new Date(), retentionEndsAt: new Date(Date.now() + 86_400_000) } });
      for (const action of ['start', 'restart']) {
        const res = await a.inject({ method: 'POST', url: `/api/v1/instances/${sub.instanceId}/${action}`, headers: alice });
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('subscription_suspended');
        expect((await a.inject({ method: 'POST', url: `/api/v1/instances/${sub.instanceId}/${action}`, headers: bob })).statusCode).toBe(404);
      }
    });

    it('deleting the instance ends the subscription', async () => {
      const a = app();
      const h = await user();
      const { payment } = (await checkout(a, h)).json();
      await post(a, callbackForm({ orderId: (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).merchantOrderId }));
      await settle();
      const sub = await prisma.subscription.findFirstOrThrow();
      const del = await a.inject({ method: 'DELETE', url: `/api/v1/instances/${sub.instanceId}`, headers: h });
      expect(del.statusCode).toBe(202);
      expect((await prisma.subscription.findFirstOrThrow()).status).toBe('ENDED');
    });
  });

  describe('Duitku callback', () => {
    async function pending() {
      const a = app();
      const h = await user();
      const { payment } = (await checkout(a, h)).json();
      const orderId = (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).merchantOrderId;
      return { a, h, orderId, paymentId: payment.id as string };
    }

    it('needs no Authorization header and accepts a valid signed form', async () => {
      const { a, orderId } = await pending();
      const res = await post(a, callbackForm({ orderId }));
      expect(res.statusCode).toBe(200);
      await settle();
      expect((await prisma.payment.findFirstOrThrow()).status).toBe('PAID');
    });

    it('replay is 200 and changes nothing', async () => {
      const { a, orderId } = await pending();
      await post(a, callbackForm({ orderId }));
      await settle();
      const res = await post(a, callbackForm({ orderId }));
      expect(res.statusCode).toBe(200);
      await settle();
      expect(await prisma.instance.count()).toBe(1);
      expect(env.mailer.sent).toHaveLength(1);
    });

    it('a bad signature is 400 and activates nothing', async () => {
      const { a, orderId } = await pending();
      const res = await post(a, callbackForm({ orderId, signature: 'f'.repeat(64) }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_callback');
      expect((await prisma.payment.findFirstOrThrow()).status).toBe('PENDING');
      expect(await prisma.paymentEvent.count()).toBe(0);
    });

    it('a tampered amount is 200 without activation (valid signature for the tampered amount)', async () => {
      const { a, orderId } = await pending();
      const res = await post(a, { ...callbackForm({ orderId, amount: 10_000 }) });
      expect(res.statusCode).toBe(200);
      await settle();
      expect((await prisma.payment.findFirstOrThrow()).status).toBe('PENDING');
      expect(await prisma.instance.count()).toBe(0);
    });

    it('a changed amount with the original signature is 400', async () => {
      const { a, orderId } = await pending();
      const res = await post(a, { ...callbackForm({ orderId }), amount: '1' });
      expect(res.statusCode).toBe(400);
    });

    it('unknown order with a valid signature is 200', async () => {
      const res = await post(app(), callbackForm({ orderId: 'nc-unknown' }));
      expect(res.statusCode).toBe(200);
    });

    it('missing fields, array fields and an empty body are 400', async () => {
      const a = app();
      expect((await post(a, { merchantCode: MERCHANT })).statusCode).toBe(400);
      expect((await a.inject({ method: 'POST', url: CALLBACK, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: '' })).statusCode).toBe(400);
      const dup = `merchantCode=${MERCHANT}&amount=${PRICE}&amount=1&merchantOrderId=x&resultCode=00&signature=${sign(String(PRICE), 'x')}`;
      expect((await a.inject({ method: 'POST', url: CALLBACK, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: dup })).statusCode).toBe(400);
    });

    it('never writes the form body, the signature or the API key to the log', async () => {
      let logs = '';
      const logger = createLogger({ level: 'debug', stream: new Writable({ write(c, _e, cb) { logs += c.toString(); cb(); } }) });
      const a = buildServer({
        service: env.service, commands: env.commands, logger,
        config: testConfig('hermes-stub:0.2.0', TEST_MASTER_KEY, { billing: billingCfg }),
        customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
        billing: env.billing,
      });
      const h = await user();
      const { payment } = (await checkout(a, h)).json();
      const orderId = (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).merchantOrderId;
      const good = callbackForm({ orderId });
      await post(a, good);
      await post(a, { ...good, signature: 'e'.repeat(64) });
      await settle();
      expect(logs).toContain('duitku callback processed');
      expect(logs).not.toContain(good.signature);
      expect(logs).not.toContain('e'.repeat(64));
      expect(logs).not.toContain(API_KEY);
      expect(logs).not.toContain(h.authorization.slice(7));
    });

    it('rejects a body over 16 KB', async () => {
      const res = await app().inject({ method: 'POST', url: CALLBACK, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `a=${'x'.repeat(20_000)}` });
      expect(res.statusCode).toBe(413);
    });

    it('is 404 when billing is off, and the customer billing routes do not exist either', async () => {
      const a = app({ billingOn: false });
      expect((await post(a, callbackForm({ orderId: 'x' }))).statusCode).toBe(404);
      expect((await a.inject({ method: 'GET', url: '/api/v1/subscriptions', headers: await user() })).statusCode).toBe(404);
    });
  });
});

describe('deploy/Caddyfile', () => {
  const caddy = readFileSync(new URL('../../deploy/Caddyfile', import.meta.url), 'utf8');
  const matcher = /@public \{\s*path ([^\n]+)/.exec(caddy)?.[1] ?? '';

  it('forwards the billing routes and the Duitku callback', () => {
    for (const p of ['/api/v1/subscriptions', '/api/v1/subscriptions/*', '/api/v1/payments/*', '/api/v1/billing/duitku/callback']) {
      expect(matcher.split(/\s+/)).toContain(p);
    }
  });

  it('still never forwards the operator API, jobs or everything else', () => {
    expect(matcher).not.toMatch(/tenants|jobs|\/api\/v1\/\*/);
    expect(caddy).toMatch(/\(\\\.\\\.\|%2e\|%2f\|\/\/\)/);
  });
});
