/**
 * Manual check of the REAL Duitku sandbox (milestone D, Task 0). Not part of `pnpm test`.
 *
 *   DUITKU_MERCHANT_CODE=... DUITKU_API_KEY=... pnpm tsx test/validation/duitku-sandbox-live.ts --email you@example.com [--raw]
 *
 * Creates ONE sandbox invoice for the minimum amount and prints its status code, reference and payment
 * URL, so the credentials, the signature scheme and the timestamp format can be confirmed. With --raw it
 * also prints the field NAMES of the raw response (never the API key). Open the printed paymentUrl and
 * pay with the Duitku sandbox simulators. Refuses to run against production.
 */
import { DUITKU_MIN_AMOUNT_IDR, createDuitkuClient } from '../../src/modules/billing/duitku-client.js';
import { createHmac, randomUUID } from 'node:crypto';

const merchantCode = process.env.DUITKU_MERCHANT_CODE;
const apiKey = process.env.DUITKU_API_KEY;
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const email = arg('--email');

if (process.env.DUITKU_ENV === 'production') {
  console.error('Refusing: this harness only talks to the sandbox.');
  process.exit(1);
}
if (!merchantCode || !apiKey || !email) {
  console.error('Set DUITKU_MERCHANT_CODE and DUITKU_API_KEY in the environment and pass --email <address>.');
  process.exit(1);
}

const callbackUrl = process.env.DUITKU_CALLBACK_URL ?? 'https://example.invalid/api/v1/billing/duitku/callback';
const orderId = `nc-${randomUUID().replaceAll('-', '')}`;
const invoice = {
  merchantOrderId: orderId, amountIdr: DUITKU_MIN_AMOUNT_IDR, productDetails: 'NibieCloud sandbox check',
  email, returnUrl: 'https://cloud.nibie.app/dashboard/instances', expiryMinutes: 60,
};

if (process.argv.includes('--raw')) {
  const ts = String(Date.now());
  const res = await fetch('https://api-sandbox.duitku.com/api/merchant/createInvoice', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-duitku-timestamp': ts, 'x-duitku-merchantcode': merchantCode,
      'x-duitku-signature': createHmac('sha256', apiKey).update(merchantCode + ts).digest('hex'),
    },
    body: JSON.stringify({ paymentAmount: invoice.amountIdr, merchantOrderId: orderId, productDetails: invoice.productDetails, email, callbackUrl, returnUrl: invoice.returnUrl, expiryPeriod: 60 }),
  });
  const text = await res.text();
  let keys = '(not JSON)';
  try { keys = Object.keys(JSON.parse(text)).join(', '); } catch { /* keep the marker */ }
  console.log(`raw: HTTP ${res.status}, fields: ${keys}`);
}

try {
  const client = createDuitkuClient({ merchantCode, apiKey, env: 'sandbox', callbackUrl });
  const out = await client.createInvoice({ ...invoice, merchantOrderId: `nc-${randomUUID().replaceAll('-', '')}` });
  console.log('OK: invoice created in the sandbox');
  console.log(`reference:  ${out.reference}`);
  console.log(`paymentUrl: ${out.paymentUrl}`);
} catch (e) {
  console.error(`FAILED: ${(e as Error).name}: ${(e as Error).message}`);
  process.exit(1);
}
