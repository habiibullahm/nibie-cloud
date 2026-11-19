/** SumoPod Managed Payment client. */

import { z } from 'zod';
import { OutboundBlockedError, OutboundFailedError, PaymentProviderRejectedError, PaymentProviderUnavailableError, ValidationError } from '../../shared/errors.js';
import { safeFetch, type SafeFetchOptions, type SafeFetchResult } from '../net/safe-fetch.js';
import type { InvoiceRequest, InvoiceResponse, PaymentClient } from './payment-client.js';

export interface SumoPodConfig {
  apiKey: string;
  webhookToken: string;
  env: 'sandbox' | 'production';
  callbackUrl: string;
}

/** Smallest invoice amount the client sends; a plan priced below it is not for sale. */
export const SUMOPOD_MIN_AMOUNT_IDR = 1_000;

const HOSTS = { sandbox: 'api-pay-sandbox.sumopod.com', production: 'api-pay.sumopod.com' } as const;

const invoiceRespSchema = z.object({
  payment_id: z.string().min(1).max(200),
  // SumoPod always returns its hosted payment page (`https://pay.sumopod.com/pay/<payment_id>`, dashboard Quick Start).
  payment_link_url: z.string().min(1).max(2048),
  status: z.string().optional(),
});

/** SumoPod's own limit for `expires_in_hours` (24, also its default when omitted). */
const MAX_EXPIRY_HOURS = 24;

/**
 * SumoPod Managed Payment `createInvoice`. Sends `X-Api-Key` header (never logged).
 * Supported method: QRIS (fee 0.7% + Rp 300, settles ~2 days).
 */
export function createSumoPodClient(cfg: SumoPodConfig, deps: { fetcher?: typeof safeFetch; timeoutMs?: number } = {}): PaymentClient {
  const fetcher = deps.fetcher ?? safeFetch;
  const host = HOSTS[cfg.env];
  return {
    async createInvoice(input) {
      if (input.merchantOrderId.length < 1 || input.merchantOrderId.length > 128) throw new ValidationError('invalid order id');
      if (!Number.isInteger(input.amountIdr) || input.amountIdr < SUMOPOD_MIN_AMOUNT_IDR) throw new ValidationError('invalid amount');
      if (input.productDetails.length > 255) throw new ValidationError('invalid product details');

      const body = JSON.stringify({
        order_id: input.merchantOrderId,
        amount: input.amountIdr,
        currency: 'IDR',
        payment_method_type_code: 'QRIS',
        // Without these SumoPod falls back to the project's dashboard Redirect URLs, which point at
        // production — the payer would land on the live site after paying a sandbox invoice.
        success_return_url: input.returnUrl,
        cancel_return_url: input.returnUrl,
        // Without this the QR stays payable for SumoPod's default 24 hours, long after our own row expired, so a
        // customer could pay an old invoice after opening a new one. Whole hours only, rounded up.
        ...(input.expiryMinutes !== undefined
          ? { expires_in_hours: Math.min(MAX_EXPIRY_HOURS, Math.max(1, Math.ceil(input.expiryMinutes / 60))) }
          : {}),
      });

      let res: SafeFetchResult;
      try {
        res = await fetcher(`https://${host}/api/v1/payments`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': cfg.apiKey,
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

      let parsed: z.infer<typeof invoiceRespSchema>;
      try {
        parsed = invoiceRespSchema.parse(JSON.parse(res.body));
      } catch {
        throw new PaymentProviderRejectedError();
      }

      if (res.status !== 200 && res.status !== 201) throw new PaymentProviderRejectedError();

      const paymentUrl = parsed.payment_link_url;
      try {
        if (new URL(paymentUrl).protocol !== 'https:') throw new Error('not https');
      } catch {
        throw new PaymentProviderRejectedError();
      }

      return { reference: parsed.payment_id, paymentUrl };
    },
  };
}