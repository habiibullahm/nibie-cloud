import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/env.js';
import { createPrisma } from '../../src/db/client.js';
import { buildServer } from '../../src/http/server.js';
import { AuditService } from '../../src/modules/admin/audit-service.js';
import { IdentityService } from '../../src/modules/auth/identity-service.js';
import { BillingTick } from '../../src/modules/billing/billing-tick.js';
import { moveWallet, TOPUP_MAX_IDR, TOPUP_MIN_IDR, WALLET_MAX_IDR } from '../../src/modules/billing/wallet.js';
import { createTestAuth, testConfig } from '../helpers/auth.js';
import { WEBHOOK_TOKEN, makeBilling, seedBilling, webhookBody } from '../helpers/billing-env.js';
import { resetDb } from '../helpers/db.js';
import { TEST_MASTER_KEY, silentLogger } from '../helpers/service-env.js';

// Wallet (top-up saldo): ledger invariants, the top-up invoice, the webhook credit, expiry, and the customer and admin routes.

const prisma = createPrisma(process.env.DATABASE_URL!);
const IMAGE = 'hermes-stub:0.2.0';
const BOSS = 'boss@nibie.app';
let auth: Awaited<ReturnType<typeof createTestAuth>>;
let env: ReturnType<typeof makeBilling>;
let s: Awaited<ReturnType<typeof seedBilling>>;

const balance = async (tenantId: string) => (await prisma.wallet.findUnique({ where: { tenantId } }))?.balanceIdr ?? 0;
const credit = (tenantId: string, amountIdr: number) =>
  prisma.$transaction((tx) => moveWallet(tx, { tenantId, amountIdr, kind: 'ADMIN_CREDIT', refId: randomUUID() }));
const topup = (amountIdr: number, key = randomUUID()) =>
  env.billing.wallet!.startTopup({ tenantId: s.tenant.id, email: 'owner@example.test', amountIdr, idempotencyKey: key });
const pay = (orderId: string, o: { amount?: number; status?: string; reference?: string } = {}) =>
  env.billing.handleSumoPodWebhook({ token: WEBHOOK_TOKEN }, webhookBody({ orderId, ...o }) as Record<string, unknown>);
const orderOf = async (id: string) => (await prisma.walletTopup.findUniqueOrThrow({ where: { id } })).merchantOrderId;

function app(cfg: Partial<Config> = {}) {
  return buildServer({
    service: env.service, commands: env.commands, logger: silentLogger,
    config: testConfig(IMAGE, TEST_MASTER_KEY, {
      adminEmails: [BOSS], walletEnabled: true,
      billing: { sumopod: { apiKey: 'k', webhookToken: WEBHOOK_TOKEN, env: 'sandbox', callbackUrl: 'https://example.test/hook' } },
      ...cfg,
    }),
    customer: { verify: auth.verify, identity: new IdentityService({ prisma }), prisma },
    admin: { verify: auth.verify, prisma, audit: new AuditService({ prisma }) },
    billing: env.billing,
  });
}
const as = async (email: string, aal = 'aal2') => ({ authorization: `Bearer ${await auth.signToken({ sub: randomUUID(), email, aal })}` });

describe('wallet', () => {
  beforeAll(async () => { auth = await createTestAuth(); });
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seedBilling(prisma);
    env = makeBilling(prisma, { wallet: true });
  });
  afterAll(() => prisma.$disconnect());

  describe('ledger', () => {
    it('applies a movement once per (kind, refId) and records the balance after it', async () => {
      const ref = randomUUID();
      const m = { tenantId: s.tenant.id, amountIdr: 25_000, kind: 'TOPUP' as const, refId: ref };
      expect(await prisma.$transaction((tx) => moveWallet(tx, m))).toEqual({ balanceIdr: 25_000, applied: true });
      expect(await prisma.$transaction((tx) => moveWallet(tx, m))).toEqual({ balanceIdr: 25_000, applied: false });
      const entries = await prisma.walletEntry.findMany({ where: { tenantId: s.tenant.id } });
      expect(entries).toHaveLength(1);
      expect(entries[0]!.balanceAfterIdr).toBe(25_000);
    });

    it('never goes below zero, even with debits racing each other', async () => {
      await credit(s.tenant.id, 100_000);
      const debit = () => prisma.$transaction((tx) => moveWallet(tx, { tenantId: s.tenant.id, amountIdr: -60_000, kind: 'ADMIN_DEBIT', refId: randomUUID() }));
      const results = await Promise.allSettled([debit(), debit(), debit()]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(failed.every((r) => (r.reason as { code?: string }).code === 'insufficient_balance')).toBe(true);
      expect(await balance(s.tenant.id)).toBe(40_000);
    });

    it('is protected by a database CHECK as well', async () => {
      await credit(s.tenant.id, 1_000);
      await expect(prisma.wallet.update({ where: { tenantId: s.tenant.id }, data: { balanceIdr: -1 } })).rejects.toThrow();
    });
  });

  describe('top-up', () => {
    it('creates a SumoPod invoice for the amount, with an nw- order and a return to the billing page', async () => {
      const t = await topup(50_000);
      expect(t.status).toBe('PENDING');
      expect(t.paymentUrl).toMatch(/^https:\/\/sandbox\.sumopod\.test\/pay\/nw-/);
      const inv = env.sumopod.invoices[0]!;
      expect(inv.amountIdr).toBe(50_000);
      expect(inv.merchantOrderId).toMatch(/^nw-[0-9a-f]{32}$/);
      expect(inv.returnUrl).toBe(`https://cloud.example.test/dashboard/billing?topup=${t.id}`);
    });

    it('refuses amounts outside the limits and non-integers', async () => {
      for (const amount of [TOPUP_MIN_IDR - 1, TOPUP_MAX_IDR + 1, 10_000.5, 0, -10_000]) {
        await expect(topup(amount)).rejects.toMatchObject({ code: 'validation_error' });
      }
      expect(env.sumopod.invoices).toHaveLength(0);
    });

    it('replays the same Idempotency-Key and refuses it with another amount', async () => {
      const key = randomUUID();
      const a = await topup(20_000, key);
      const b = await topup(20_000, key);
      expect(b.id).toBe(a.id);
      expect(env.sumopod.invoices).toHaveLength(1);
      await expect(topup(30_000, key)).rejects.toMatchObject({ code: 'conflict' });
    });

    it('refuses a top-up that would take balance plus open top-ups above the cap', async () => {
      await credit(s.tenant.id, WALLET_MAX_IDR - 1_000_000);
      await topup(1_000_000);
      await expect(topup(TOPUP_MIN_IDR)).rejects.toMatchObject({ code: 'wallet_limit' });
    });

    it('marks the top-up FAILED when the invoice cannot be created', async () => {
      env.sumopod.failNext = true;
      await expect(topup(20_000)).rejects.toBeTruthy();
      expect((await prisma.walletTopup.findFirstOrThrow()).status).toBe('FAILED');
    });
  });

  describe('webhook', () => {
    it('credits a paid top-up once, records it, and sends a receipt', async () => {
      const t = await topup(75_000);
      const order = await orderOf(t.id);
      const r = await pay(order, { amount: 75_000 });
      expect(r).toMatchObject({ accepted: true, outcome: 'topped_up' });
      if (r.accepted) await r.postActions();
      expect(await balance(s.tenant.id)).toBe(75_000);
      expect((await prisma.walletTopup.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('PAID');
      expect(env.mailer.sent.at(-1)?.subject).toBe('Top-up saldo diterima - Nibie Cloud');
      expect(env.mailer.sent.at(-1)?.text).toContain('Rp 75.000');

      // Redelivered, and a second paid event with another reference: still credited once.
      expect(await pay(order, { amount: 75_000 })).toMatchObject({ outcome: 'duplicate' });
      expect(await pay(order, { amount: 75_000, reference: 'REF-2' })).toMatchObject({ outcome: 'already_paid' });
      expect(await balance(s.tenant.id)).toBe(75_000);
      expect(await prisma.walletEntry.count({ where: { kind: 'TOPUP' } })).toBe(1);
    });

    it('never credits on an amount mismatch or a failure', async () => {
      const t = await topup(40_000);
      const order = await orderOf(t.id);
      expect(await pay(order, { amount: 400_000 })).toMatchObject({ outcome: 'amount_mismatch' });
      expect(await pay(order, { amount: 40_000, status: 'failed', reference: 'REF-F' })).toMatchObject({ outcome: 'failed' });
      expect(await balance(s.tenant.id)).toBe(0);
      expect((await prisma.walletTopup.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('FAILED');
    });

    it('still credits a top-up paid after it expired, even above the cap: money is never lost', async () => {
      const t = await topup(1_000_000);
      env.clock.advanceDays(1);
      await new BillingTick({ prisma, billing: env.billing, commands: env.commands, mailer: env.mailer, logger: silentLogger, now: () => env.clock.now }).runOnce();
      expect((await prisma.walletTopup.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('EXPIRED');
      await credit(s.tenant.id, WALLET_MAX_IDR - 500_000);
      expect(await pay(await orderOf(t.id), { amount: 1_000_000 })).toMatchObject({ outcome: 'topped_up' });
      expect(await balance(s.tenant.id)).toBe(WALLET_MAX_IDR + 500_000);
    });

    it('leaves hosting payments on their own path', async () => {
      expect(await pay('nw-unknown', { amount: 10_000 })).toMatchObject({ outcome: 'unknown_order' });
    });
  });

  describe('routes', () => {
    it('are 404 when WALLET_ENABLED is off', async () => {
      env = makeBilling(prisma, { wallet: false });
      const a = app({ walletEnabled: false });
      const me = await as('owner@example.test', 'aal1');
      expect((await a.inject({ method: 'GET', url: '/api/v1/wallet', headers: me })).statusCode).toBe(404);
      expect((await a.inject({ method: 'POST', url: `/api/v1/admin/customers/${s.tenant.id}/wallet/adjust`, headers: await as(BOSS), payload: { amountIdr: 1000, reason: 'test reason' } })).statusCode).toBe(404);
    });

    it('lets a customer read the wallet and start a top-up', async () => {
      const a = app();
      const me = await as('new@example.test', 'aal1');
      const view = await a.inject({ method: 'GET', url: '/api/v1/wallet', headers: me });
      expect(view.statusCode).toBe(200);
      expect(view.json().wallet).toMatchObject({ balanceIdr: 0, limits: { topupMinIdr: TOPUP_MIN_IDR, topupMaxIdr: TOPUP_MAX_IDR, maxBalanceIdr: WALLET_MAX_IDR } });
      const bad = await a.inject({ method: 'POST', url: '/api/v1/wallet/topups', headers: { ...me, 'idempotency-key': 'k1' }, payload: { amountIdr: 5_000 } });
      expect(bad.statusCode).toBe(400);
      const res = await a.inject({ method: 'POST', url: '/api/v1/wallet/topups', headers: { ...me, 'idempotency-key': 'k1' }, payload: { amountIdr: 25_000 } });
      expect(res.statusCode).toBe(201);
      const id = res.json().topup.id as string;
      expect((await a.inject({ method: 'GET', url: `/api/v1/wallet/topups/${id}`, headers: me })).json().topup.amountIdr).toBe(25_000);
      // Another customer cannot see it.
      expect((await a.inject({ method: 'GET', url: `/api/v1/wallet/topups/${id}`, headers: await as('other@example.test', 'aal1') })).statusCode).toBe(404);
    });

    it('lets an admin with a second factor adjust a wallet, with a reason in the audit log', async () => {
      const a = app();
      const url = `/api/v1/admin/customers/${s.tenant.id}/wallet/adjust`;
      expect((await a.inject({ method: 'POST', url, headers: await as(BOSS, 'aal1'), payload: { amountIdr: 10_000, reason: 'goodwill' } })).statusCode).toBe(403);
      expect((await a.inject({ method: 'POST', url, headers: await as('guest@example.test'), payload: { amountIdr: 10_000, reason: 'goodwill' } })).statusCode).toBe(403);
      expect((await a.inject({ method: 'POST', url, headers: await as(BOSS), payload: { amountIdr: 10_000 } })).statusCode).toBe(400);

      const boss = await as(BOSS);
      const ok = await a.inject({ method: 'POST', url, headers: boss, payload: { amountIdr: 10_000, reason: 'goodwill credit' } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().wallet.balanceIdr).toBe(10_000);
      const over = await a.inject({ method: 'POST', url, headers: boss, payload: { amountIdr: -20_000, reason: 'correction' } });
      expect(over.statusCode).toBe(409);
      expect(over.json().error.code).toBe('insufficient_balance');
      expect(await balance(s.tenant.id)).toBe(10_000);

      const log = await prisma.auditLog.findMany({ where: { action: 'POST /customers/:tenantId/wallet/adjust' } });
      expect(log).toHaveLength(1);
      expect(log[0]!.reason).toBe('goodwill credit');
      const entry = await prisma.walletEntry.findFirstOrThrow({ where: { tenantId: s.tenant.id } });
      expect(entry).toMatchObject({ kind: 'ADMIN_CREDIT', note: 'Penyesuaian admin', actorEmail: BOSS });

      const detail = await a.inject({ method: 'GET', url: `/api/v1/admin/customers/${s.tenant.id}`, headers: boss });
      expect(detail.json().wallet.balanceIdr).toBe(10_000);
    });
  });
});
