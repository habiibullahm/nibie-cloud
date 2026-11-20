import { describe, expect, it } from 'vitest';
import { createSumoPodClient } from '../../src/modules/billing/sumopod-client.js';
import type { SafeFetchOptions, SafeFetchResult } from '../../src/modules/net/safe-fetch.js';
import { PaymentProviderRejectedError, PaymentProviderUnavailableError } from '../../src/shared/errors.js';

// Request and response shapes come from the SumoPod dashboard Quick Start (2026-11-20).

const CFG = { apiKey: 'test-key', webhookToken: 'whtok_x', env: 'sandbox' as const, callbackUrl: 'https://example.test/hook' };
const INPUT = {
  merchantOrderId: 'nc-0123456789abcdef0123456789abcdef', amountIdr: 25_000, productDetails: 'Hosting',
  email: 'owner@example.test', returnUrl: 'https://cloud.example.test/dashboard/billing', expiryMinutes: 60,
};

function client(status: number, body: unknown) {
  const calls: { url: string; opts: SafeFetchOptions }[] = [];
  const fetcher = async (url: string, opts: SafeFetchOptions): Promise<SafeFetchResult> => {
    calls.push({ url, opts });
    return { status, headers: {}, body: JSON.stringify(body) };
  };
  return { calls, c: createSumoPodClient(CFG, { fetcher: fetcher as never }) };
}

const OK = { payment_id: 'b2c4', order_id: INPUT.merchantOrderId, amount: 25_000, payment_link_url: 'https://pay.sumopod.com/pay/b2c4', status: 'pending' };

describe('SumoPod client', () => {
  it('sends the order, QRIS, the return URLs and a one-hour expiry, and returns the hosted link', async () => {
    const { calls, c } = client(201, OK);
    expect(await c.createInvoice(INPUT)).toEqual({ reference: 'b2c4', paymentUrl: 'https://pay.sumopod.com/pay/b2c4' });
    expect(calls[0]!.url).toBe('https://api-pay-sandbox.sumopod.com/api/v1/payments');
    expect(JSON.parse(calls[0]!.opts.body!)).toEqual({
      order_id: INPUT.merchantOrderId, amount: 25_000, currency: 'IDR', payment_method_type_code: 'QRIS',
      success_return_url: INPUT.returnUrl, cancel_return_url: INPUT.returnUrl, expires_in_hours: 1,
    });
  });

  it('rounds the expiry up to whole hours within SumoPod\'s 1 to 24, and omits it when not given', async () => {
    for (const [minutes, hours] of [[1, 1], [61, 2], [24 * 60, 24], [48 * 60, 24]] as const) {
      const { calls, c } = client(201, OK);
      await c.createInvoice({ ...INPUT, expiryMinutes: minutes });
      expect(JSON.parse(calls[0]!.opts.body!).expires_in_hours).toBe(hours);
    }
    const { calls, c } = client(201, OK);
    const { expiryMinutes: _omit, ...noExpiry } = INPUT;
    await c.createInvoice(noExpiry);
    expect(JSON.parse(calls[0]!.opts.body!)).not.toHaveProperty('expires_in_hours');
  });

  it('rejects a response without payment_link_url instead of building a link', async () => {
    const { payment_link_url: _omit, ...noLink } = OK;
    await expect(client(201, { ...noLink, payment_code: '000201010212' }).c.createInvoice(INPUT)).rejects.toBeInstanceOf(PaymentProviderRejectedError);
  });

  it('rejects a non-https link and reports a 5xx as unavailable', async () => {
    await expect(client(201, { ...OK, payment_link_url: 'http://pay.sumopod.com/pay/b2c4' }).c.createInvoice(INPUT)).rejects.toBeInstanceOf(PaymentProviderRejectedError);
    await expect(client(503, {}).c.createInvoice(INPUT)).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
  });
});
