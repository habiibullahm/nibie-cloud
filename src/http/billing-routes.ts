import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { BillingService } from '../modules/billing/billing-service.js';
import { TOPUP_MAX_IDR, TOPUP_MIN_IDR } from '../modules/billing/wallet.js';
import { CaptchaFailedError, type CaptchaVerifier } from '../modules/waitlist/turnstile.js';
import { AppError } from '../shared/errors.js';
import { principalOf } from './customer-auth.js';
import { clientIp } from './public-routes.js';

const checkoutBody = z.object({ name: z.string(), planId: z.string().uuid() }).strict();
const upgradeBody = z.object({ instanceId: z.string().uuid(), planId: z.string().uuid() }).strict();
const changePlanBody = z.object({ planId: z.string().uuid() }).strict();
const idempotencyKey = z.string().min(1).max(128);
const topupBody = z.object({ amountIdr: z.number().int().min(TOPUP_MIN_IDR).max(TOPUP_MAX_IDR) }).strict();
const autoRenewBody = z.object({ enabled: z.boolean() }).strict();
const walletPayBody = z.object({ captchaToken: z.string().max(2048).optional() }).strict();

/**
 * Spending money needs a solved Turnstile when the backend has a secret, checked before anything is read or written; an
 * outage fails closed. Null `captcha`: none asked.
 */
export async function requireCaptcha(captcha: CaptchaVerifier | null, token: string | undefined, req: FastifyRequest): Promise<void> {
  if (!captcha) return;
  const outcome = await captcha(token, clientIp(req));
  if (outcome === 'invalid') throw new CaptchaFailedError();
  if (outcome === 'unavailable') throw new AppError('The anti-bot check is unavailable. Please try again later.', 503, 'captcha_unavailable');
}

/** Customer billing routes. Registered inside the customer plugin, so the token and the tenant are already resolved. */
export function registerBillingRoutes(
  api: FastifyInstance,
  billing: BillingService,
  gate: (email: string) => void | Promise<void> = () => undefined,
  /** Turnstile check for paying from the wallet; null: none asked. */
  captcha: CaptchaVerifier | null = null,
): void {
  type SubParams = { subscriptionId: string };

  api.get('/subscriptions', async (req) => ({ subscriptions: await billing.list(principalOf(req).tenantId) }));

  api.get<{ Params: SubParams }>('/subscriptions/:subscriptionId', async (req) => ({
    subscription: await billing.get(principalOf(req).tenantId, req.params.subscriptionId),
  }));

  api.post('/subscriptions/checkout', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const p = principalOf(req);
    await gate(p.email);
    const key = idempotencyKey.parse(req.headers['idempotency-key']);
    const body = checkoutBody.parse(req.body);
    const out = await billing.checkout({ tenantId: p.tenantId, email: p.email, planId: body.planId, name: body.name, idempotencyKey: key });
    return reply.status(201).send(out);
  });

  // A free instance onto a paid plan, keeping its data; the plan changes once the payment is verified.
  api.post('/subscriptions/upgrade', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const p = principalOf(req);
    await gate(p.email);
    const key = idempotencyKey.parse(req.headers['idempotency-key']);
    const body = upgradeBody.parse(req.body);
    const out = await billing.upgrade({ tenantId: p.tenantId, email: p.email, instanceId: body.instanceId, planId: body.planId, idempotencyKey: key });
    return reply.status(201).send(out);
  });

  // Moves an active paid subscription to another paid plan with at least the same resources.
  api.post<{ Params: SubParams }>('/subscriptions/:subscriptionId/change-plan', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const p = principalOf(req);
    await gate(p.email);
    const key = idempotencyKey.parse(req.headers['idempotency-key']);
    const body = changePlanBody.parse(req.body);
    const out = await billing.changePlan({
      tenantId: p.tenantId, email: p.email, subscriptionId: req.params.subscriptionId, planId: body.planId, idempotencyKey: key,
    });
    return reply.status(201).send(out);
  });

  api.post<{ Params: SubParams }>('/subscriptions/:subscriptionId/renew', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const p = principalOf(req);
    await gate(p.email);
    const out = await billing.renew({ tenantId: p.tenantId, email: p.email, subscriptionId: req.params.subscriptionId });
    return reply.status(201).send(out);
  });

  api.post<{ Params: SubParams }>('/subscriptions/:subscriptionId/cancel', async (req) => ({
    subscription: await billing.cancel(principalOf(req).tenantId, req.params.subscriptionId),
  }));

  api.get<{ Params: { paymentId: string } }>('/payments/:paymentId', async (req) => ({
    payment: await billing.getPayment(principalOf(req).tenantId, req.params.paymentId),
  }));

  api.get('/invoices', async (req) => ({ invoices: await billing.invoices(principalOf(req).tenantId) }));

  api.get<{ Params: { invoiceId: string } }>('/invoices/:invoiceId', async (req) => ({
    invoice: await billing.invoice(principalOf(req).tenantId, req.params.invoiceId),
  }));

  // Wallet (top-up saldo): only with WALLET_ENABLED, otherwise these paths are 404.
  const wallet = billing.wallet;
  if (!wallet) return;

  api.get('/wallet', async (req) => ({ wallet: await wallet.view(principalOf(req).tenantId) }));

  // Pays an open hosting invoice from the balance; the plan change and receipt follow after the response.
  api.post<{ Params: { paymentId: string } }>('/payments/:paymentId/pay-with-wallet', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const p = principalOf(req);
    await gate(p.email);
    const body = walletPayBody.parse(req.body ?? {});
    await requireCaptcha(captcha, body.captchaToken, req);
    const { postActions, ...result } = await billing.payWithWallet(p.tenantId, req.params.paymentId);
    setImmediate(() => void postActions().catch((e: Error) => req.log.error({ errName: e.name }, 'post-payment actions failed')));
    return result;
  });

  api.post<{ Params: SubParams }>('/subscriptions/:subscriptionId/auto-renew', async (req) => ({
    subscription: await billing.setAutoRenew(principalOf(req).tenantId, req.params.subscriptionId, autoRenewBody.parse(req.body).enabled),
  }));

  api.post('/wallet/topups', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const p = principalOf(req);
    await gate(p.email);
    const key = idempotencyKey.parse(req.headers['idempotency-key']);
    const body = topupBody.parse(req.body);
    const topup = await wallet.startTopup({ tenantId: p.tenantId, email: p.email, amountIdr: body.amountIdr, idempotencyKey: key });
    return reply.status(201).send({ topup });
  });

  api.get<{ Params: { topupId: string } }>('/wallet/topups/:topupId', async (req) => ({
    topup: await wallet.getTopup(principalOf(req).tenantId, req.params.topupId),
  }));
}
