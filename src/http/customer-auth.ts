import type { FastifyInstance } from 'fastify';
import type { IdentityService, Principal } from '../modules/auth/identity-service.js';
import type { AuthClaims } from '../modules/auth/token-verifier.js';
import { AuthUnavailableError, UnauthorizedError } from '../shared/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the customer auth hook. Never taken from the request body, path or query. */
    principal?: Principal;
  }
}

export interface CustomerAuthDeps {
  verify: (token: string) => Promise<AuthClaims>;
  identity: IdentityService;
}

const BEARER = /^Bearer ([^\s]+)$/;

/** Requires a valid Supabase access token on every route of this plugin scope. */
export function registerCustomerAuth(app: FastifyInstance, deps: CustomerAuthDeps): void {
  app.decorateRequest('principal', undefined);
  // Sign-ins and failed sign-ins are recorded by Supabase Auth; this log line ties a session to our API traffic.
  // shortcut: process-local and cleared when full, so a session may be logged again after a restart; enough for a log trail.
  const seenSessions = new Set<string>();
  app.addHook('onRequest', async (req) => {
    const m = BEARER.exec(req.headers.authorization ?? '');
    if (!m) throw new UnauthorizedError();
    let claims: AuthClaims;
    try {
      claims = await deps.verify(m[1]!);
    } catch (e) {
      // An outage must be visible to the operator; a bad token is routine and stays quiet.
      if (e instanceof AuthUnavailableError) req.log.error('token verification unavailable: key set could not be loaded');
      throw e;
    }
    req.principal = await deps.identity.resolve(claims);
    if (claims.sessionId && !seenSessions.has(claims.sessionId)) {
      if (seenSessions.size >= 10_000) seenSessions.clear();
      seenSessions.add(claims.sessionId);
      req.log.info({ userId: claims.userId, sessionId: claims.sessionId, aal: claims.aal }, 'customer session first seen');
    }
  });
}

/** The principal of an authenticated customer request; a route outside the auth scope is a bug. */
export function principalOf(req: { principal?: Principal }): Principal {
  if (!req.principal) throw new UnauthorizedError();
  return req.principal;
}
