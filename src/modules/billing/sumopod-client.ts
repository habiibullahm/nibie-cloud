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

const HOSTS = { sandbox: 'api-pay-sandbox.sumopod.com', production: 'api-pay.sumopod.com' } as const;

const invoiceRespSchema = z.object({
  payment_id: z.string().min(1).max(200),
  payment_link_url: z.string().max(2048).optional(),
  payment_code: z.string().max(100).optional(),
  status: z.string().optional(),
}).refine((d) => d.payment_link_url || d.payment_code, { message: 'needs payment_link_url or payment_code' });

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
      if (!Number.isInteger(input.amountIdr) || input.amountIdr < 1_000) throw new ValidationError('invalid amount');
      if (input.productDetails.length > 255) throw new ValidationError('invalid product details');

      const body = JSON.stringify({
        order_id: input.merchantOrderId,
        amount: input.amountIdr,
        currency: 'IDR',
        payment_method_type_code: 'QRIS',
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

      const paymentUrl = parsed.payment_link_url ?? '';
      try {
        if (paymentUrl && new URL(paymentUrl).protocol !== 'https:') throw new Error('not https');
      } catch {
        throw new PaymentProviderRejectedError();
      }

      return {
        reference: parsed.payment_id,
        paymentUrl: paymentUrl || `https://app.sumopod.com/pay/${parsed.payment_code}`,
      };
    },
  };
}