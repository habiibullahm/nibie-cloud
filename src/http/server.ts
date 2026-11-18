import cors from '@fastify/cors';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { Config } from '../config/env.js';
import { InstanceCommands } from '../modules/instances/instance-commands.js';
import type { JobQueue } from '../modules/jobs/types.js';
import type { InstanceService } from '../modules/instances/instance-service.js';
import type { LogService } from '../modules/integrations/log-service.js';
import type { Integrations } from '../modules/integrations/types.js';
import { isDatabaseUnavailable } from '../db/errors.js';
import type { BillingService } from '../modules/billing/billing-service.js';
import type { Mailer } from '../modules/billing/mailer.js';
import type { CaptchaVerifier } from '../modules/waitlist/turnstile.js';
import { registerDuitkuCallback } from './duitku-callback.js';
import { registerSumoPodWebhook } from './sumopod-callback.js';
import { registerCustomerRoutes, type CustomerDeps } from './customer-routes.js';
import { registerOperatorRoutes } from './operator-routes.js';
import { registerAdminRoutes, type AdminDeps } from './admin-routes.js';
import { registerPublicRoutes } from './public-routes.js';
import { registerReadyz, type ReadinessCheck } from './readyz.js';
import { AppError, NotFoundError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';

/**
 * Two API surfaces in separate plugins so no hook crosses over: the operator API (bearer ADMIN_TOKEN,
 * loopback) and, when `customer` is given, the customer API (Supabase access tokens).
 */
export function buildServer(deps: {
  service: InstanceService;
  /** Defaults to running every operation inline (no queue). */
  commands?: InstanceCommands;
  /** The job queue behind `commands`, for the operator's failed-job routes. Null or absent: inline mode. */
  queue?: JobQueue | null;
  config: Config;
  logger: Logger;
  customer?: CustomerDeps;
  /** Admin dashboard API (Supabase token on `ADMIN_EMAILS`). Absent: the admin routes do not exist (404). */
  admin?: AdminDeps;
  /** Provider and Telegram services. Null or absent: those routes answer 503 `secrets_unavailable`. */
  integrations?: Integrations | null;
  /** Redacted container logs for the customer API. Absent: the logs route answers 404. */
  logs?: LogService | null;
  /** Duitku billing. Null or absent: the billing routes and the callback do not exist (404). */
  billing?: BillingService | null;
  /** Dependency checks for `/readyz` (database, Redis, Docker). Absent: `/readyz` answers 200 like `/healthz`. */
  readiness?: Record<string, ReadinessCheck>;
  /** Sends the waiting-list confirmation emails. Null, absent or disabled: `POST /public/waitlist` answers 503. */
  mailer?: Mailer | null;
  /** Captcha check for the waiting-list form (Turnstile). Null or absent: no captcha is asked. */
  captcha?: CaptchaVerifier | null;
}): FastifyInstance {
  const { service, config, logger, customer } = deps;
  const integrations = deps.integrations ?? null;
  const commands = deps.commands ?? new InstanceCommands({ service, queue: null, logger });
  // Only the loopback reverse proxy (Caddy) is trusted for X-Forwarded-For, so `req.ip` and the request log carry the real
  // client address. The operator API's proxy-header guard reads the raw headers and does not depend on this.
  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger, trustProxy: ['127.0.0.1', '::1'] });

  // Bearer tokens only (no cookies). Production allows only the dashboard origin; CORS_EXTRA_ORIGINS adds local dev origins.
  const origins = [...(config.dashboardOrigin ? [config.dashboardOrigin] : []), ...(config.corsExtraOrigins ?? [])];
  if (origins.length > 0) {
    app.register(cors, {
      origin: origins,
      credentials: false,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['authorization', 'content-type', 'idempotency-key'],
      maxAge: 600,
    });
  }

  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'validation_error', message: 'Invalid request' } });
    }
    const e = err as { name?: string; statusCode?: number };
    if (isDatabaseUnavailable(err)) {
      req.log.error({ errName: e.name }, 'database unavailable');
      return reply.status(503).send({ error: { code: 'database_unavailable', message: 'Database is temporarily unavailable' } });
    }
    if (e.statusCode === 429) {
      return reply.status(429).send({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: 'bad_request', message: 'Bad request' } });
    }
    // Free-text error messages can contain secrets, so only the error class is logged.
    req.log.error({ errName: e.name }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Internal error' } });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  registerReadyz(app, deps.readiness ?? {});

  registerOperatorRoutes(app, { service, commands, queue: deps.queue ?? null, config, integrations });
  const billing = deps.billing ?? null;
  if (customer) registerPublicRoutes(app, { prisma: customer.prisma, config, mailer: deps.mailer ?? null, captcha: deps.captcha ?? null });
  if (customer) registerCustomerRoutes(app, { customer, service, commands, config, integrations, logs: deps.logs ?? null, billing });
  if (deps.admin) registerAdminRoutes(app, { admin: deps.admin, config, mailer: deps.mailer ?? null });
  if (billing) {
    registerDuitkuCallback(app, { billing, logger });
    registerSumoPodWebhook(app, { billing, logger });
  }

  app.setNotFoundHandler(async () => {
    throw new NotFoundError('Route not found');
  });

  return app;
}
