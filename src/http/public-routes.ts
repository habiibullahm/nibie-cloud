import { isIP } from 'node:net';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { Config } from '../config/env.js';
import { freeBetaRemaining } from '../modules/instances/free-beta.js';
import { renderWaitlistConfirm } from '../modules/billing/email-templates.js';
import type { Mailer } from '../modules/billing/mailer.js';
import { CONFIRM_TOKEN_PATTERN, confirmWaitlist, forgetConfirmSend, joinWaitlist } from '../modules/waitlist/waitlist.js';
import { CaptchaFailedError, type CaptchaVerifier } from '../modules/waitlist/turnstile.js';
import { readSupportContact } from '../modules/support/contact.js';
import { AppError } from '../shared/errors.js';
import { ipv6Groups } from '../shared/ip.js';

/**
 * The address of the visitor. The process listens on loopback behind Caddy, which sets `X-Forwarded-For` to the address it
 * saw (and discards any value the visitor sent), so the last entry is the real client. Without a valid entry the socket
 * address is used. Behind this proxy only: never trust the header on a port that is reachable directly.
 */
export function clientIp(req: FastifyRequest): string {
  const raw = req.headers['x-forwarded-for'];
  const last = (Array.isArray(raw) ? raw.join(',') : raw ?? '').split(',').at(-1)?.trim() ?? '';
  return isIP(last) ? last : req.ip;
}

/** The first 64 bits of a (valid) IPv6 address, written as `a:b:c:d::/64`. */
function ipv6Prefix64(ip: string): string {
  return `${ipv6Groups(ip).slice(0, 4).join(':')}::/64`;
}

/**
 * Rate-limit key for public routes: the client's IPv4 address, or the /64 network of an IPv6 address. One IPv6 customer
 * usually holds a whole /64, so keying on the full address would give them as many fresh limits as they like.
 */
export function rateLimitKey(req: FastifyRequest): string {
  const ip = clientIp(req);
  if (isIP(ip) !== 6) return ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return mapped ? mapped[1]! : ipv6Prefix64(ip);
}

const control = /[\u0000-\u001f\u007f]/;
const singleLine = (max: number) => z.string().trim().min(1).max(max).refine((v) => !control.test(v), 'no control characters');

/** Strict: an unknown key is a validation error. `website` is the honeypot: invisible to people, filled by bots. */
export const waitlistBody = z.object({
  name: singleLine(100),
  email: z.string().trim().toLowerCase().email().max(254),
  useCase: z.string().trim().min(3).max(500),
  website: z.string().max(500).optional(),
  /** Cloudflare Turnstile token from the form; required when the backend has a Turnstile secret. */
  captchaToken: z.string().max(2048).optional(),
}).strict();

export const confirmBody = z.object({ token: z.string().regex(CONFIRM_TOKEN_PATTERN) }).strict();

class WaitlistFullError extends AppError {
  constructor() {
    super('The waiting list is full right now. Please try again later.', 503, 'waitlist_full');
  }
}

/** No email can be sent (not configured, or the send failed): without the confirmation email nobody can join. */
class WaitlistUnavailableError extends AppError {
  constructor() {
    super('The waiting list cannot take entries right now. Please try again later.', 503, 'waitlist_unavailable');
  }
}

class ConfirmLinkInvalidError extends AppError {
  constructor() {
    super('This confirmation link is not valid or has expired.', 400, 'confirm_link_invalid');
  }
}

/**
 * Routes with no authentication, for the public website. Nothing personal or per-tenant is ever returned here.
 * `GET /api/v1/public/beta-slots` feeds the "N of 10 free slots left" counter on the landing page, and
 * `POST /api/v1/public/waitlist` takes a name, email and use case once the free slots are used and emails a confirmation
 * link; `POST /api/v1/public/waitlist/confirm` turns the entry into a place in line (double opt-in).
 */
export function registerPublicRoutes(app: FastifyInstance, deps: { prisma: PrismaClient; config: Config; mailer: Mailer | null; captcha?: CaptchaVerifier | null }): void {
  const { prisma, config } = deps;
  const captcha = deps.captcha ?? null;
  const mailer = deps.mailer?.enabled ? deps.mailer : null;
  const confirmPage = `${config.dashboardOrigin ?? 'https://cloud.nibie.app'}/daftar-tunggu/konfirmasi`;
  app.register(async (pub) => {
    await pub.register(rateLimit, {
      global: true, max: 60, timeWindow: '1 minute', keyGenerator: rateLimitKey,
      onExceeded: (req) => req.log.warn({ route: req.routeOptions.url }, 'public rate limit hit'),
    });
    pub.get('/api/v1/public/beta-slots', async (_req, reply) => {
      reply.header('cache-control', 'public, max-age=15');
      return {
        total: config.freeBetaSlots,
        remaining: await freeBetaRemaining(prisma, config.freeBetaSlots, { queueFirst: config.mail !== null }),
      };
    });

    /** Support contacts set on the admin Pengaturan page, for the dashboard's Support page and footer (signed in or not). */
    pub.get('/api/v1/public/support-contact', async (_req, reply) => {
      reply.header('cache-control', 'public, max-age=60');
      return readSupportContact(prisma);
    });

    pub.post('/api/v1/public/waitlist', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const body = waitlistBody.parse(req.body);
      // A bot that fills the hidden field gets the same answer as a person, and nothing is stored.
      if (body.website !== undefined && body.website.length > 0) return { ok: true };
      if (!mailer) throw new WaitlistUnavailableError();
      // Before anything is stored or sent: a person must have solved the captcha.
      if (captcha) {
        const outcome = await captcha(body.captchaToken, clientIp(req));
        if (outcome === 'invalid') throw new CaptchaFailedError();
        if (outcome === 'unavailable') throw new WaitlistUnavailableError();
      }
      // A new address and one already on the list look the same from outside, so the list cannot be probed for who joined.
      const result = await joinWaitlist(prisma, { name: body.name, email: body.email, useCase: body.useCase });
      if (result.kind === 'full') throw new WaitlistFullError();
      if (result.kind === 'busy') throw new WaitlistUnavailableError();
      if (result.kind === 'send') {
        try {
          await mailer.send({
            to: body.email,
            ...renderWaitlistConfirm({ confirmUrl: `${confirmPage}#t=${result.token}`, validUntil: result.expiresAt }),
          });
        } catch {
          // Let the person ask again at once instead of waiting for the resend interval.
          await forgetConfirmSend(prisma, result.id);
          throw new WaitlistUnavailableError();
        }
      }
      return { ok: true };
    });

    pub.post('/api/v1/public/waitlist/confirm', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const parsed = confirmBody.safeParse(req.body);
      if (!parsed.success || (await confirmWaitlist(prisma, parsed.data.token)) === 'invalid') throw new ConfirmLinkInvalidError();
      return { ok: true };
    });
  });
}
