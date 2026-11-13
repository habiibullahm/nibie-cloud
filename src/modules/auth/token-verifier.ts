import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { AuthUnavailableError, UnauthorizedError } from '../../shared/errors.js';
import { isUuid } from '../../shared/uuid.js';

export interface AuthClaims {
  /** Supabase Auth user id (`sub`). */
  userId: string;
  email: string;
}

export interface VerifierOptions {
  /** `https://<project-ref>.supabase.co`, no trailing slash. */
  supabaseUrl: string;
  /** Key resolver. Defaults to the project's remote JWKS; tests inject a local set. */
  keys?: JWTVerifyGetKey;
  clockToleranceSec?: number;
}

/** Asymmetric only: never `none`, never `HS*` (the Supabase docs advise against the shared secret). */
const ALGORITHMS = ['ES256', 'RS256', 'EdDSA'];
const MAX_TOKEN_LENGTH = 8192;
/** The Supabase docs say not to cache the JWKS in the application for longer than 10 minutes. */
const JWKS_CACHE_MS = 10 * 60 * 1000;

/** jose codes that mean "the key set could not be loaded", as opposed to "this token is bad". */
const KEY_SET_FAILURES = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID', 'ERR_JOSE_GENERIC']);

/** Anything that is not a jose token/claim error (for example a failed fetch) is a key set failure. */
function keySetUnavailable(e: unknown): boolean {
  return !(e instanceof errors.JOSEError) || KEY_SET_FAILURES.has(e.code);
}

/**
 * Verifies a Supabase access token locally against the project's JWKS. Every token fault, whatever
 * its cause, is the same `UnauthorizedError`; a key set that cannot be loaded is `AuthUnavailableError`
 * so an outage does not look like a sign-out.
 */
export function createTokenVerifier(o: VerifierOptions): (token: string) => Promise<AuthClaims> {
  const issuer = `${o.supabaseUrl}/auth/v1`;
  const keys =
    o.keys ??
    createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { cacheMaxAge: JWKS_CACHE_MS });
  const clockTolerance = o.clockToleranceSec ?? 5;

  return async (token) => {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      throw new UnauthorizedError();
    }
    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer,
        audience: 'authenticated',
        algorithms: ALGORITHMS,
        clockTolerance,
        requiredClaims: ['sub', 'exp'],
      }));
    } catch (e) {
      throw keySetUnavailable(e) ? new AuthUnavailableError() : new UnauthorizedError();
    }
    const { sub, email } = payload;
    if (!isUuid(sub) || typeof email !== 'string' || email.length === 0) throw new UnauthorizedError();
    return { userId: sub, email };
  };
}
