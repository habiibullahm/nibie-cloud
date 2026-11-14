import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../config/env.js';
import { OutboundBlockedError, OutboundFailedError, PaymentProviderRejectedError, PaymentProviderUnavailableError, ValidationError } from '../../shared/errors.js';
import { safeFetch, type SafeFetchOptions, type SafeFetchResult } from '../net/safe-fetch.js';

export type DuitkuConfig = NonNullable<Config['billing']>;

/** Duitku rejects anything below this (error text in the POP docs). */
export const DUITKU_MIN_AMOUNT_IDR = 10_000;

const HOSTS = { sandbox: 'api-sandbox.duitku.com', production: 'api-prod.duitku.com' } as const;

export interface InvoiceRequest {
  /** Generated here, unique per transaction, at most 50 characters. */
  merchantOrderId: string;
  /** Integer rupiah. */
  amountIdr: number;
  productDetails: string;
  email: string;
  /** Where the customer's browser goes after paying. It never changes payment state. */
  returnUrl: string;
  /** How long the invoice stays payable. */
  expiryMinutes: number;
}

export interface InvoiceResponse {
  reference: string;
  paymentUrl: string;
}

export interface DuitkuClient {
  createInvoice(input: InvoiceRequest): Promise<InvoiceResponse>;
}

type Fetcher = (url: string, opts: SafeFetchOptions) => Promise<SafeFetchResult>;

const hmacHex = (apiKey: string, data: string): string => createHmac('sha256', apiKey).update(data).digest('hex');

const answerSchema = z.object({
  statusCode: z.string(),
  reference: z.string().min(1).max(100).optional(),
  paymentUrl: z.string().max(2048).optional(),
});

/**
 * Duitku POP `createInvoice`. The key signs `merchantCode + timestamp` (HMAC-SHA256, lowercase hex) and is
 * never sent. Provider error text is not passed on: a refusal becomes a fixed error, an unreachable
 * provider another one, so no message can leak the key or Duitku internals to a customer.
 */
export function createDuitkuClient(cfg: DuitkuConfig, deps: { fetcher?: Fetcher; now?: () => number; timeoutMs?: number } = {}): DuitkuClient {
  const fetcher = deps.fetcher ?? safeFetch;
  const now = deps.now ?? (() => Date.now());
  const host = HOSTS[cfg.env];
  return {
    async createInvoice(input) {
      validate(input);
      const timestamp = String(now());
      const body = JSON.stringify({
        paymentAmount: input.amountIdr,
        merchantOrderId: input.merchantOrderId,
        productDetails: input.productDetails,
        email: input.email,
        callbackUrl: cfg.callbackUrl,
        returnUrl: input.returnUrl,
        expiryPeriod: input.expiryMinutes,
      });
      let res: SafeFetchResult;
      try {
        res = await fetcher(`https://${host}/api/merchant/createInvoice`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-duitku-timestamp': timestamp,
            'x-duitku-merchantcode': cfg.merchantCode,
            'x-duitku-signature': hmacHex(cfg.apiKey, cfg.merchantCode + timestamp),
          },
          body,
          timeoutMs: deps.timeoutMs ?? 10_000,
          maxBytes: 64 * 1024,
          allowHosts: [host],
        });
      } catch (e) {
        if (e instanceof OutboundFailedError || e instanceof OutboundBlockedError) throw new PaymentProviderUnavailableError();
        throw e;
      }
      if (res.status >= 500) throw new PaymentProviderUnavailableError();
      let parsed: z.infer<typeof answerSchema>;
      try {
        parsed = answerSchema.parse(JSON.parse(res.body));
      } catch {
        throw new PaymentProviderRejectedError();
      }
      if (res.status !== 200 || parsed.statusCode !== '00' || !parsed.reference || !parsed.paymentUrl) throw new PaymentProviderRejectedError();
      try {
        if (new URL(parsed.paymentUrl).protocol !== 'https:') throw new Error('not https');
      } catch {
        throw new PaymentProviderRejectedError();
      }
      return { reference: parsed.reference, paymentUrl: parsed.paymentUrl };
    },
  };
}

function validate(i: InvoiceRequest): void {
  if (i.merchantOrderId.length < 1 || i.merchantOrderId.length > 50) throw new ValidationError('invalid order id');
  if (!Number.isInteger(i.amountIdr) || i.amountIdr < DUITKU_MIN_AMOUNT_IDR) throw new ValidationError('invalid amount');
  if (i.productDetails.length < 1 || i.productDetails.length > 255) throw new ValidationError('invalid product details');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.email) || i.email.length > 100) throw new ValidationError('invalid email');
  if (i.returnUrl.length > 255 || !/^https:\/\//.test(i.returnUrl)) throw new ValidationError('invalid return url');
  if (!Number.isInteger(i.expiryMinutes) || i.expiryMinutes < 1 || i.expiryMinutes > 1440) throw new ValidationError('invalid expiry');
}

/**
 * Callback authenticity: `HMAC-SHA256(merchantCode + amount + merchantOrderId, apiKey)` as lowercase hex,
 * compared in constant time. `amount` is the form field exactly as Duitku sent it (a string).
 */
export function verifyCallbackSignature(
  cfg: Pick<DuitkuConfig, 'merchantCode' | 'apiKey'>,
  input: { amount: string; merchantOrderId: string; signature: string },
): boolean {
  if (!/^[0-9a-f]{64}$/.test(input.signature)) return false;
  const expected = Buffer.from(hmacHex(cfg.apiKey, cfg.merchantCode + input.amount + input.merchantOrderId), 'hex');
  const given = Buffer.from(input.signature, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
