import { isIP } from 'node:net';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { Config } from '../config/env.js';
import { freeBetaRemaining } from '../modules/instances/free-beta.js';
import { joinWaitlist } from '../modules/waitlist/waitlist.js';
import { AppError } from '../shared/errors.js';

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

const control = /[\u0000-\u001f\u007f]/;
const singleLine = (max: number) => z.string().trim().min(1).max(max).refine((v) => !control.test(v), 'no control characters');

/** Strict: an unknown key is a validation error. `website` is the honeypot: invisible to people, filled by bots. */
export const waitlistBody = z.object({
  name: singleLine(100),
  email: z.string().trim().toLowerCase().email().max(254),
  useCase: z.string().trim().min(3).max(500),
  website: z.string().max(500).optional(),
}).strict();

class WaitlistFullError extends AppError {
  constructor() {
    super('The waiting list is full right now. Please try again later.', 503, 'waitlist_full');
  }
}

/**
 * Routes with no authentication, for the public website. Nothing personal or per-tenant is ever returned here.
 * `GET /api/v1/public/beta-slots` feeds the "N of 10 free slots left" counter on the landing page, and
 * `POST /api/v1/public/waitlist` takes a name, email and use case once the free slots are used.
 */
export function registerPublicRoutes(app: FastifyInstance, deps: { prisma: PrismaClient; config: Config }): void {
  const { prisma, config } = deps;
  app.register(async (pub) => {
    await pub.register(rateLimit, { global: true, max: 60, timeWindow: '1 minute', keyGenerator: clientIp });
    pub.get('/api/v1/public/beta-slots', async (_req, reply) => {
      reply.header('cache-control', 'public, max-age=15');
      return {
        total: config.freeBetaSlots,
        remaining: await freeBetaRemaining(prisma, config.freeBetaSlots, { queueFirst: config.mail !== null }),
      };
    });

    pub.post('/api/v1/public/waitlist', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const body = waitlistBody.parse(req.body);
      // A bot that fills the hidden field gets the same answer as a person, and nothing is stored.
      if (body.website !== undefined && body.website.length > 0) return { ok: true };
      // A new address and one already on the list look the same from outside, so the list cannot be probed for who joined.
      const result = await joinWaitlist(prisma, { name: body.name, email: body.email, useCase: body.useCase });
      if (result === 'full') throw new WaitlistFullError();
      return { ok: true };
    });
  });
}
