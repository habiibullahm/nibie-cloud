import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createDuitkuClient, verifyCallbackSignature } from '../../src/modules/billing/duitku-client.js';
import { OutboundFailedError, PaymentProviderRejectedError, PaymentProviderUnavailableError, ValidationError } from '../../src/shared/errors.js';

const cfg = {
  merchantCode: 'DS00000',
  apiKey: 'api-key-secret-value',
  env: 'sandbox' as const,
  callbackUrl: 'https://api.example.test/api/v1/billing/duitku/callback',
};
const hmac = (data: string) => createHmac('sha256', cfg.apiKey).update(data).digest('hex');

const invoice = {
  merchantOrderId: 'nc-0123456789abcdef0123456789abcdef',
  amountIdr: 10_000,
  productDetails: 'Nibie Cloud Small, 30 hari',
  email: 'customer@example.test',
  returnUrl: 'https://cloud.example.test/dashboard/instances?payment=x',
  expiryMinutes: 60,
};

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async () => ({ status, headers: {}, body: typeof body === 'string' ? body : JSON.stringify(body) }));
}

describe('createDuitkuClient.createInvoice', () => {
  it('signs with HMAC-SHA256(merchantCode + timestamp) and posts the sandbox endpoint', async () => {
    const f = fakeFetch({ merchantCode: 'DS00000', reference: 'REF1', paymentUrl: 'https://sandbox.duitku.com/pay/REF1', statusCode: '00', statusMessage: 'SUCCESS' });
    const client = createDuitkuClient(cfg, { fetcher: f, now: () => 1_700_000_000_000 });
    const out = await client.createInvoice(invoice);
    expect(out).toEqual({ reference: 'REF1', paymentUrl: 'https://sandbox.duitku.com/pay/REF1' });
    const [url, opts] = f.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string; allowHosts: string[] }];
    expect(url).toBe('https://api-sandbox.duitku.com/api/merchant/createInvoice');
    expect(opts.method).toBe('POST');
    expect(opts.allowHosts).toEqual(['api-sandbox.duitku.com']);
    expect(opts.headers['x-duitku-timestamp']).toBe('1700000000000');
    expect(opts.headers['x-duitku-merchantcode']).toBe('DS00000');
    expect(opts.headers['x-duitku-signature']).toBe(hmac('DS000001700000000000'));
    expect(opts.headers['content-type']).toBe('application/json');
    const sent = JSON.parse(opts.body);
    expect(sent).toMatchObject({
      paymentAmount: 10_000, merchantOrderId: invoice.merchantOrderId, productDetails: invoice.productDetails,
      email: invoice.email, callbackUrl: cfg.callbackUrl, returnUrl: invoice.returnUrl, expiryPeriod: 60,
    });
    expect(opts.body).not.toContain(cfg.apiKey);
  });

  it('uses the production endpoint when configured', async () => {
    const f = fakeFetch({ reference: 'R', paymentUrl: 'https://passport.duitku.com/pay/R', statusCode: '00' });
    await createDuitkuClient({ ...cfg, env: 'production' }, { fetcher: f }).createInvoice(invoice);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('https://api-prod.duitku.com/api/merchant/createInvoice');
  });

  it.each([
    ['order id over 50 characters', { merchantOrderId: 'x'.repeat(51) }],
    ['empty order id', { merchantOrderId: '' }],
    ['amount below the Duitku minimum', { amountIdr: 9_999 }],
    ['fractional amount', { amountIdr: 10_000.5 }],
    ['product details over 255 characters', { productDetails: 'p'.repeat(256) }],
    ['invalid email', { email: 'nope' }],
    ['return URL that is not https', { returnUrl: 'http://x.test/' }],
  ])('rejects %s before any request', async (_label, patch) => {
    const f = fakeFetch({});
    await expect(createDuitkuClient(cfg, { fetcher: f }).createInvoice({ ...invoice, ...patch })).rejects.toBeInstanceOf(ValidationError);
    expect(f).not.toHaveBeenCalled();
  });

  it('turns a non-00 statusCode into a fixed rejection without provider text or the key', async () => {
    const f = fakeFetch({ statusCode: '01', statusMessage: `bad signature ${cfg.apiKey}` }, 400);
    const err = await createDuitkuClient(cfg, { fetcher: f }).createInvoice(invoice).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentProviderRejectedError);
    expect(String((err as Error).message)).not.toContain(cfg.apiKey);
    expect(String((err as Error).message)).not.toContain('bad signature');
  });

  it('treats an HTML or malformed answer as a rejection, and a 5xx as unavailable', async () => {
    await expect(createDuitkuClient(cfg, { fetcher: fakeFetch('<html>oops</html>', 200) }).createInvoice(invoice)).rejects.toBeInstanceOf(PaymentProviderRejectedError);
    await expect(createDuitkuClient(cfg, { fetcher: fakeFetch({ statusCode: '00' }, 200) }).createInvoice(invoice)).rejects.toBeInstanceOf(PaymentProviderRejectedError);
    await expect(createDuitkuClient(cfg, { fetcher: fakeFetch('bad gateway', 502) }).createInvoice(invoice)).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
  });

  it('turns a network failure or timeout into PaymentProviderUnavailableError', async () => {
    const f = vi.fn(async () => { throw new OutboundFailedError('timeout'); });
    await expect(createDuitkuClient(cfg, { fetcher: f }).createInvoice(invoice)).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
  });

  it('refuses a payment URL that is not https', async () => {
    const f = fakeFetch({ reference: 'R', paymentUrl: 'http://evil.test/pay', statusCode: '00' });
    await expect(createDuitkuClient(cfg, { fetcher: f }).createInvoice(invoice)).rejects.toBeInstanceOf(PaymentProviderRejectedError);
  });
});

describe('verifyCallbackSignature', () => {
  const good = { amount: '10000', merchantOrderId: invoice.merchantOrderId };
  const sig = hmac(`DS00000${good.amount}${good.merchantOrderId}`);

  it('accepts HMAC-SHA256(merchantCode + amount + merchantOrderId)', () => {
    expect(verifyCallbackSignature(cfg, { ...good, signature: sig })).toBe(true);
  });

  it.each([
    ['tampered amount', { amount: '1', merchantOrderId: good.merchantOrderId, signature: sig }],
    ['tampered order id', { amount: good.amount, merchantOrderId: 'nc-other', signature: sig }],
    ['wrong length', { ...good, signature: sig.slice(0, 40) }],
    ['empty', { ...good, signature: '' }],
    ['uppercase hex', { ...good, signature: sig.toUpperCase() }],
    ['not hex', { ...good, signature: 'z'.repeat(64) }],
    ['md5 style signature', { ...good, signature: 'a'.repeat(32) }],
  ])('rejects %s', (_label, input) => {
    expect(verifyCallbackSignature(cfg, input)).toBe(false);
  });

  it('rejects a signature made with another key', () => {
    const other = createHmac('sha256', 'other-key').update(`DS00000${good.amount}${good.merchantOrderId}`).digest('hex');
    expect(verifyCallbackSignature(cfg, { ...good, signature: other })).toBe(false);
  });
});
