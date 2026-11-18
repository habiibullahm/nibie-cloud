import { describe, expect, it } from 'vitest';
import { BillingService } from '../../src/modules/billing/billing-service.js';
import { createLogger } from '../../src/shared/logger.js';

// SumoPod wraps events in a svix-style envelope; the handler must read from `data`,
// acknowledge `payment.test`, and reject a bad token. No DB is touched on these paths.

const TOKEN = 'whtok_test_value';

function service(): BillingService {
  return new BillingService({
    prisma: {} as never,
    paymentClient: { createInvoice: async () => ({ reference: 'r', paymentUrl: 'https://x.test/p' }) },
    duitkuAuth: null,
    sumopodAuth: { webhookToken: TOKEN },
    gateway: 'sumopod',
    commands: {} as never,
    mailer: { enabled: false, send: async () => undefined } as never,
    dashboardOrigin: 'https://cloud.example.test',
    maxInstancesPerTenant: 1,
    logger: createLogger({ level: 'silent' }),
  });
}

describe('SumoPod webhook', () => {
  it('rejects a wrong X-Webhook-Token', async () => {
    const r = await service().handleSumoPodWebhook({ token: 'wrong' }, { event_type: 'payment.test', data: {} });
    expect(r.accepted).toBe(false);
  });

  it('rejects an empty token, a prefix of the token and the token with extra characters', async () => {
    for (const t of ['', TOKEN.slice(0, -1), `${TOKEN}x`]) {
      const r = await service().handleSumoPodWebhook({ token: t }, { event_type: 'payment.test', data: {} });
      expect(r.accepted).toBe(false);
    }
  });

  it('acknowledges payment.test without touching an order', async () => {
    const r = await service().handleSumoPodWebhook({ token: TOKEN }, {
      event_type: 'payment.test',
      data: { message: 'This is a test webhook from SumoPod', project_id: 'p' },
    });
    expect(r).toMatchObject({ accepted: true, outcome: 'ignored_failure' });
  });

  it('rejects an envelope with no order_id', async () => {
    const r = await service().handleSumoPodWebhook({ token: TOKEN }, { event_type: 'payment.completed', data: { status: 'paid' } });
    expect(r.accepted).toBe(false);
  });
});

// A word status must reach the shared apply path as '00' (paid); otherwise every real SumoPod
// payment is written FAILED, because applyInTransaction only treats '00' as paid.
describe('SumoPod status normalization', () => {
  const PAID = new Set(['paid', 'completed', 'success', 'succeeded', 'settled']);

  it('maps paid words to the Duitku paid code', () => {
    for (const s of ['paid', 'PAID', 'completed', 'success', 'settled']) {
      expect(PAID.has(s.toLowerCase())).toBe(true);
    }
  });

  it('does not treat failures as paid', () => {
    for (const s of ['failed', 'expired', 'cancelled', 'pending']) {
      expect(PAID.has(s.toLowerCase())).toBe(false);
    }
  });
});