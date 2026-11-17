import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { Config } from '../config/env.js';
import { freeBetaRemaining } from '../modules/instances/free-beta.js';

/**
 * Routes with no authentication, for the public website. Nothing personal or per-tenant is ever returned here.
 * `GET /api/v1/public/beta-slots` feeds the "N of 10 free slots left" counter on the landing page.
 */
export function registerPublicRoutes(app: FastifyInstance, deps: { prisma: PrismaClient; config: Config }): void {
  const { prisma, config } = deps;
  app.register(async (pub) => {
    await pub.register(rateLimit, { global: true, max: 60, timeWindow: '1 minute' });
    pub.get('/api/v1/public/beta-slots', async (_req, reply) => {
      reply.header('cache-control', 'public, max-age=15');
      return { total: config.freeBetaSlots, remaining: await freeBetaRemaining(prisma, config.freeBetaSlots) };
    });
  });
}
