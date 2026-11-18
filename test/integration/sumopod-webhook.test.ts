import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { IdentityService } from '../../src/modules/auth/identity-service.js';
import { BillingService } from '../../src/modules/billing/billing-service.js';
import { createLogger } from '../../src/shared/logger.js';
import { createTestAuth, testConfig } from '../helpers/auth.js';
import { PRICE, makeBilling } from '../helpers/billing-env.js';
import { resetDb } from '../helpers/db.js';
import { TEST_MASTER_KEY } from '../helpers/service-env.js';

// The SumoPod webhook: envelope shape, token check, status normalization, and the full
// payment -> PAID -> instance activation path. Regression guard for three bugs found in a real
// sandbox check-out (top-level field read, word status treated as a Duitku failure code, no
// return URL). Uses the real Fastify route so the body parsing and header handling are covered.

const prisma = createPrisma(process.env.DATABASE_URL!);
const WEBHOOK = '/api/v1/billing/sumopod/webhook';
const TOKEN = 'whtok_test_value_for_integration';
let auth: Awaited<ReturnType<typeof createTestAuth>>;
let env: ReturnType<typeof makeBilling>;
let billing: BillingService;
let planId: string;

function app() {
  return buildServer({
    service: env.service, commands: env.commands, logger: createLogger({ level: 'silent' }),
    config: testConfig('hermes-stub:0.2.0', TEST_MASTER_KEY, {
      billing: {
        gateway: 'sumopod',
        duitku: null,
        sumopod: { apiKey: 'test-key', webhookToken: TOKEN, env: 'sandbox', callbackUrl: 'https://example.test/hook' },
      },
      maxInstancesPerTenant: 2,
    }),
    customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
    billing,
  });
}

function post(a: ReturnType<typeof app>, body: unknown, headers: Record<string, string> = {}) {
  return a.inject({
    method: 'POST', url: WEBHOOK,
    headers: { 'content-type': 'application/json', 'x-webhook-token': TOKEN, ...headers },
    payload: JSON.stringify(body),
  });
}

/** Creates a tenant + PENDING_PAYMENT subscription + PENDING payment through the real checkout path. */
async function pendingPayment(merchantOrderId = `nc-${randomUUID().replaceAll('-', '')}`) {
  const tenant = await prisma.tenant.create({ data: { name: 'acme' } });
  const sub = await prisma.subscription.create({
    data: { tenantId: tenant.id, planId, status: 'PENDING_PAYMENT', intendedName: 'agent', currentPeriodEnd: new Date(Date.now() + 86_400_000) },
  });
  await prisma.payment.create({
    data: {
      subscriptionId: sub.id, purpose: 'NEW', status: 'PENDING',
      amountIdr: PRICE, merchantOrderId, paymentUrl: 'https://sumo.sandbox.test/pay/1',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return { tenantId: tenant.id, subscriptionId: sub.id, merchantOrderId };
}

describe('SumoPod webhook', () => {
  beforeAll(async () => { auth = await createTestAuth(); });
  beforeEach(async () => {
    await resetDb(prisma);
    env = makeBilling(prisma);
    const plan = await prisma.plan.create({
      data: { slug: 'test-small', name: 'Test small', cpuMillis: 500, memoryMb: 256, pids: 128, storageMb: 1024, monthlyPriceIdr: PRICE },
    });
    await prisma.runtimeNode.create({ data: { name: 'local', region: 'local' } });
    planId = plan.id;
    billing = new BillingService({
      prisma, paymentClient: env.duitku, duitkuAuth: null,
      sumopodAuth: { webhookToken: TOKEN }, gateway: 'sumopod',
      commands: env.commands, mailer: env.mailer as never,
      dashboardOrigin: 'https://cloud.example.test', maxInstancesPerTenant: 2,
      logger: createLogger({ level: 'silent' }),
    });
  });
  afterAll(() => prisma.$disconnect());

  describe('with a Svix signing secret', () => {
    const SECRET = `whsec_${Buffer.alloc(24, 3).toString('base64')}`;
    function signedApp() {
      const signed = new BillingService({
        prisma, paymentClient: env.duitku, duitkuAuth: null,
        sumopodAuth: { webhookToken: TOKEN, webhookSecret: SECRET }, gateway: 'sumopod',
        commands: env.commands, mailer: env.mailer as never,
        dashboardOrigin: 'https://cloud.example.test', maxInstancesPerTenant: 2,
        logger: createLogger({ level: 'silent' }),
      });
      return buildServer({
        service: env.service, commands: env.commands, logger: createLogger({ level: 'silent' }),
        config: testConfig('hermes-stub:0.2.0', TEST_MASTER_KEY, {
          billing: { gateway: 'sumopod', duitku: null, sumopod: { apiKey: 'test-key', webhookToken: TOKEN, webhookSecret: SECRET, env: 'sandbox', callbackUrl: 'https://example.test/hook' } },
          maxInstancesPerTenant: 2,
        }),
        customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
        billing: signed,
      });
    }
    function sign(raw: string, ts = Math.floor(Date.now() / 1000), id = `msg_${randomUUID()}`) {
      const mac = createHmac('sha256', Buffer.from(SECRET.slice('whsec_'.length), 'base64')).update(`${id}.${ts}.${raw}`).digest('base64');
      return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${mac}` };
    }
    const send = (a: ReturnType<typeof signedApp>, raw: string, headers: Record<string, string>) =>
      a.inject({ method: 'POST', url: WEBHOOK, headers: { 'content-type': 'application/json', ...headers }, payload: raw });

    it('accepts a correctly signed payment and marks it PAID', async () => {
      const { merchantOrderId } = await pendingPayment();
      const raw = JSON.stringify({ event_type: 'payment.completed', data: { order_id: merchantOrderId, payment_id: 'pay_s1', amount: PRICE, status: 'paid' } });
      expect((await send(signedApp(), raw, sign(raw))).statusCode).toBe(200);
      expect((await prisma.payment.findUniqueOrThrow({ where: { merchantOrderId } })).status).toBe('PAID');
    });

    it('no longer accepts the token alone', async () => {
      const { merchantOrderId } = await pendingPayment();
      const raw = JSON.stringify({ event_type: 'payment.completed', data: { order_id: merchantOrderId, payment_id: 'pay_s2', amount: PRICE, status: 'paid' } });
      expect((await send(signedApp(), raw, { 'x-webhook-token': TOKEN })).statusCode).toBe(400);
      expect((await prisma.payment.findUniqueOrThrow({ where: { merchantOrderId } })).status).toBe('PENDING');
    });

    it('rejects a body changed after signing, e.g. a failure turned into a payment', async () => {
      const { merchantOrderId } = await pendingPayment();
      const failed = JSON.stringify({ event_type: 'payment.failed', data: { order_id: merchantOrderId, payment_id: 'pay_s3', amount: PRICE, status: 'failed' } });
      const forged = failed.replace('"failed"}', '"paid"}');
      expect((await send(signedApp(), forged, sign(failed))).statusCode).toBe(400);
      expect((await prisma.payment.findUniqueOrThrow({ where: { merchantOrderId } })).status).toBe('PENDING');
    });

    it('rejects a signed message replayed outside the five-minute window', async () => {
      const { merchantOrderId } = await pendingPayment();
      const raw = JSON.stringify({ event_type: 'payment.completed', data: { order_id: merchantOrderId, payment_id: 'pay_s4', amount: PRICE, status: 'paid' } });
      const old = Math.floor(Date.now() / 1000) - 10 * 60;
      expect((await send(signedApp(), raw, sign(raw, old))).statusCode).toBe(400);
      expect((await prisma.payment.findUniqueOrThrow({ where: { merchantOrderId } })).status).toBe('PENDING');
    });

    it('answers 400 to a body that is not JSON', async () => {
      const raw = '{not json';
      expect((await send(signedApp(), raw, sign(raw))).statusCode).toBe(400);
    });
  });

  it('rejects a wrong or missing X-Webhook-Token', async () => {
    const a = app();
    expect((await post(a, { event_type: 'payment.test', data: {} }, { 'x-webhook-token': 'wrong' })).statusCode).toBe(400);
    expect((await post(a, { event_type: 'payment.test', data: {} }, { 'x-webhook-token': '' })).statusCode).toBe(400);
  });

  it('acknowledges payment.test with 200 and writes nothing', async () => {
    const a = app();
    const res = await post(a, { event_type: 'payment.test', data: { message: 'test', project_id: 'p' } });
    expect(res.statusCode).toBe(200);
    expect(await prisma.paymentEvent.count()).toBe(0);
  });

  it('reads order_id from the data envelope, not the top level', async () => {
    const { merchantOrderId, subscriptionId } = await pendingPayment();
    const res = await post(app(), {
      event_type: 'payment.completed',
      data: { order_id: merchantOrderId, payment_id: 'pay_1', amount: PRICE, status: 'paid' },
    });
    expect(res.statusCode).toBe(200);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { merchantOrderId } });
    // The pre-fix handler read the top level, found no order_id, and answered 400 without touching the row.
    expect(payment.status).toBe('PAID');
    expect(payment.resultCode).toBe('00');
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    expect(sub.status).toBe('ACTIVE');
  });

  it('normalizes a word status to the Duitku paid code instead of writing FAILED', async () => {
    const { merchantOrderId } = await pendingPayment();
    await post(app(), {
      event_type: 'payment.completed',
      data: { order_id: merchantOrderId, payment_id: 'pay_2', amount: PRICE, status: 'completed' },
    });
    const payment = await prisma.payment.findUniqueOrThrow({ where: { merchantOrderId } });
    // Pre-fix this was FAILED: `completed` !== '00' made applyInTransaction take the failure branch.
    expect(payment.status).toBe('PAID');
  });

  it('marks a failure status FAILED and leaves the subscription unpaid', async () => {
    const { merchantOrderId, subscriptionId } = await pendingPayment();
    await post(app(), {
      event_type: 'payment.failed',
      data: { order_id: merchantOrderId, payment_id: 'pay_3', amount: PRICE, status: 'failed' },
    });
    const payment = await prisma.payment.findUniqueOrThrow({ where: { merchantOrderId } });
    expect(payment.status).toBe('FAILED');
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    expect(sub.status).toBe('PENDING_PAYMENT');
  });

  it('is idempotent: a redelivered event is a no-op', async () => {
    const { merchantOrderId } = await pendingPayment();
    const body = { event_type: 'payment.completed', data: { order_id: merchantOrderId, payment_id: 'pay_4', amount: PRICE, status: 'paid' } };
    const a = app();
    expect((await post(a, body)).statusCode).toBe(200);
    expect((await post(a, body)).statusCode).toBe(200);
    expect(await prisma.paymentEvent.count()).toBe(1);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { merchantOrderId } });
    expect(payment.status).toBe('PAID');
  });

  it('accepts a flat body (older/manual callers)', async () => {
    const { merchantOrderId } = await pendingPayment();
    await post(app(), { order_id: merchantOrderId, payment_id: 'pay_5', amount: PRICE, status: 'paid' });
    const payment = await prisma.payment.findUniqueOrThrow({ where: { merchantOrderId } });
    expect(payment.status).toBe('PAID');
  });

  it('rejects an amount mismatch without paying', async () => {
    const { merchantOrderId } = await pendingPayment();
    await post(app(), {
      event_type: 'payment.completed',
      data: { order_id: merchantOrderId, payment_id: 'pay_6', amount: PRICE + 1, status: 'paid' },
    });
    const payment = await prisma.payment.findUniqueOrThrow({ where: { merchantOrderId } });
    expect(payment.status).toBe('PENDING');
  });

  it('accepts an unknown order and records the event', async () => {
    const res = await post(app(), {
      event_type: 'payment.completed',
      data: { order_id: 'nc-does-not-exist', payment_id: 'pay_7', amount: PRICE, status: 'paid' },
    });
    expect(res.statusCode).toBe(200);
    const ev = await prisma.paymentEvent.findFirst();
    expect(ev?.outcome).toBe('unknown_order');
  });
});