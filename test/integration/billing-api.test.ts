import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { IdentityService } from '../../src/modules/auth/identity-service.js';
import { createTestAuth, testConfig } from '../helpers/auth.js';
import { PRICE, WEBHOOK_TOKEN, makeBilling, webhookBody } from '../helpers/billing-env.js';
import { resetDb } from '../helpers/db.js';
import { TEST_MASTER_KEY, silentLogger } from '../helpers/service-env.js';
import { createLogger } from '../../src/shared/logger.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const WEBHOOK = '/api/v1/billing/sumopod/webhook';
let auth: Awaited<ReturnType<typeof createTestAuth>>;
let env: ReturnType<typeof makeBilling>;
let planId: string;

const billingCfg = { sumopod: { apiKey: 'test-sumopod-key', webhookToken: WEBHOOK_TOKEN, webhookSecret: null, env: 'sandbox' as const, callbackUrl: `https://api.example.test${WEBHOOK}` } };

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
const post = (a: ReturnType<typeof app>, body: unknown, headers: Record<string, string> = {}) =>
  a.inject({ method: 'POST', url: WEBHOOK, headers: { 'content-type': 'application/json', 'x-webhook-token': WEBHOOK_TOKEN, ...headers }, payload: JSON.stringify(body) });
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

  describe('SumoPod sandbox on a production deployment', () => {
    const sandboxApp = (billing: typeof billingCfg | Record<string, unknown>) => buildServer({
      service: env.service, commands: env.commands, logger: silentLogger,
      config: testConfig('hermes-stub:0.2.0', TEST_MASTER_KEY, { nodeEnv: 'production', betaAllowedEmails: ['invited@example.test'], billing: billing as never, maxInstancesPerTenant: 1 }),
      customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
      billing: env.billing,
    });

    it('lets only invited beta users start a purchase while SumoPod is in sandbox', async () => {
      const a = sandboxApp(billingCfg);
      const refused = await checkout(a, await user('stranger@example.test'));
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('billing_not_open');
      expect(await prisma.subscription.count()).toBe(0);
      expect((await checkout(a, await user('Invited@Example.test'))).statusCode).toBe(201);
    });

    it('PAID_CHECKOUT_OPEN=false refuses everyone but invited accounts, even outside production', async () => {
      const a = buildServer({
        service: env.service, commands: env.commands, logger: silentLogger,
        config: testConfig('hermes-stub:0.2.0', TEST_MASTER_KEY, { betaAllowedEmails: ['invited@example.test'], paidCheckoutOpen: false, billing: billingCfg, maxInstancesPerTenant: 1 }),
        customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
        billing: env.billing,
      });
      const refused = await checkout(a, await user('stranger@example.test'));
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('billing_not_open');
      expect((await checkout(a, await user('invited@example.test'))).statusCode).toBe(201);
    });

    it('PAID_CHECKOUT_OPEN=false also lets an account that only has a database invite start a purchase, until it is revoked', async () => {
      await prisma.betaInvite.create({ data: { email: 'table-invited@example.test' } });
      const a = buildServer({
        service: env.service, commands: env.commands, logger: silentLogger,
        config: testConfig('hermes-stub:0.2.0', TEST_MASTER_KEY, { paidCheckoutOpen: false, billing: billingCfg, maxInstancesPerTenant: 1 }),
        customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
        billing: env.billing,
      });
      expect((await checkout(a, await user('stranger@example.test'))).statusCode).toBe(403);
      expect((await checkout(a, await user('Table-Invited@example.test'))).statusCode).toBe(201);
      await prisma.betaInvite.updateMany({ data: { revokedAt: new Date() } });
      const refused = await checkout(a, await user('table-invited@example.test'));
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('billing_not_open');
    });

    it('is open to everyone once SumoPod is in production', async () => {
      const a = sandboxApp({ sumopod: { ...billingCfg.sumopod, env: 'production' } });
      expect((await checkout(a, await user('stranger@example.test'))).statusCode).toBe(201);
    });
  });

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

    it('answers 503 when SumoPod is unreachable', async () => {
      env.sumopod.failNext = true;
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

    it('the whole path: pay by webhook, instance appears, renew, cancel', async () => {
      const a = app();
      const h = await user();
      const { payment } = (await checkout(a, h)).json();
      const orderId = (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).merchantOrderId;
      const cb = await post(a, webhookBody({ orderId }));
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
      await post(a, webhookBody({ orderId: (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).merchantOrderId }));
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
      await post(a, webhookBody({ orderId: (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).merchantOrderId }));
      await settle();
      const sub = await prisma.subscription.findFirstOrThrow();
      const del = await a.inject({ method: 'DELETE', url: `/api/v1/instances/${sub.instanceId}`, headers: h });
      expect(del.statusCode).toBe(202);
      expect((await prisma.subscription.findFirstOrThrow()).status).toBe('ENDED');
    });
  });

  describe('SumoPod webhook route', () => {
    async function pending() {
      const a = app();
      const h = await user();
      const { payment } = (await checkout(a, h)).json();
      const orderId = (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).merchantOrderId;
      return { a, h, orderId };
    }

    it('needs no Authorization header and accepts an authenticated webhook', async () => {
      const { a, orderId } = await pending();
      expect((await post(a, webhookBody({ orderId }))).statusCode).toBe(200);
      await settle();
      expect((await prisma.payment.findFirstOrThrow()).status).toBe('PAID');
    });

    it('a wrong token is 400 and records nothing', async () => {
      const { a, orderId } = await pending();
      const res = await post(a, webhookBody({ orderId }), { 'x-webhook-token': 'not-the-webhook-token' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_webhook');
      expect((await prisma.payment.findFirstOrThrow()).status).toBe('PENDING');
      expect(await prisma.paymentEvent.count()).toBe(0);
    });

    it('the removed Duitku callback route does not exist', async () => {
      const res = await app().inject({ method: 'POST', url: '/api/v1/billing/duitku/callback', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'a=1' });
      expect(res.statusCode).toBe(404);
    });

    it('never writes the body or the webhook token to the log', async () => {
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
      await post(a, webhookBody({ orderId, reference: 'pay_log_check' }));
      await post(a, webhookBody({ orderId }), { 'x-webhook-token': 'wrong-token-in-log-check' });
      await settle();
      expect(logs).toContain('sumopod webhook processed');
      expect(logs).not.toContain(WEBHOOK_TOKEN);
      expect(logs).not.toContain('wrong-token-in-log-check');
      expect(logs).not.toContain('pay_log_check');
      expect(logs).not.toContain(h.authorization.slice(7));
    });

    it('rejects a body over 16 KB', async () => {
      const res = await post(app(), { pad: 'x'.repeat(20_000) });
      expect(res.statusCode).toBe(413);
    });

    it('is 404 when billing is off, and the customer billing routes do not exist either', async () => {
      const a = app({ billingOn: false });
      expect((await post(a, webhookBody({ orderId: 'x' }))).statusCode).toBe(404);
      expect((await a.inject({ method: 'GET', url: '/api/v1/subscriptions', headers: await user() })).statusCode).toBe(404);
    });
  });
});

describe('deploy/Caddyfile', () => {
  const caddy = readFileSync(new URL('../../deploy/Caddyfile', import.meta.url), 'utf8');
  const matcher = /@public \{\s*path ([^\n]+)/.exec(caddy)?.[1] ?? '';

  it('forwards the billing routes and the SumoPod webhook, and no longer the Duitku callback', () => {
    for (const p of ['/api/v1/subscriptions', '/api/v1/subscriptions/*', '/api/v1/payments/*', '/api/v1/wallet', '/api/v1/wallet/*', '/api/v1/invoices', '/api/v1/invoices/*', '/api/v1/billing/sumopod/webhook']) {
      expect(matcher.split(/\s+/)).toContain(p);
    }
    expect(matcher).not.toContain('duitku');
  });

  it('forwards every public route the backend registers', () => {
    // A public route missing here answers 404 in production while every local test passes (support-contact, 2026-11-19).
    const src = readFileSync(new URL('../../src/http/public-routes.ts', import.meta.url), 'utf8');
    const routes = [...src.matchAll(/pub\.(?:get|post)\(\s*'(\/api\/v1\/public\/[^']+)'/g)].map((m) => m[1]);
    expect(routes.length).toBeGreaterThan(3);
    expect(routes.filter((r) => !matcher.split(/\s+/).includes(r!))).toEqual([]);
  });

  it('still never forwards the operator API, jobs or everything else', () => {
    expect(matcher).not.toMatch(/tenants|jobs|\/api\/v1\/\*/);
    expect(caddy).toMatch(/\(\\\.\\\.\|%2e\|%2f\|\/\/\)/);
  });
});
