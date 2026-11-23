import { randomUUID } from 'node:crypto';
import { SignJWT, UnsecuredJWT, createLocalJWKSet, errors, exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTokenVerifier } from '../../src/modules/auth/token-verifier.js';
import { AuthUnavailableError, UnauthorizedError } from '../../src/shared/errors.js';

const SUPABASE_URL = 'https://abcd.supabase.co';
const ISSUER = `${SUPABASE_URL}/auth/v1`;

let privateKey: CryptoKey;
let publicJwk: JWK;
let verify: ReturnType<typeof createTokenVerifier>;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  verify = createTokenVerifier({ supabaseUrl: SUPABASE_URL, keys: createLocalJWKSet({ keys: [publicJwk] }) });
});

interface Overrides { sub?: string; email?: string | null; iss?: string; aud?: string; exp?: string | number; kid?: string; aal?: string | null; sessionId?: unknown; amr?: { method: string; timestamp: number }[] }

async function sign(o: Overrides = {}): Promise<string> {
  const claims: Record<string, unknown> = { role: 'authenticated' };
  if (o.email !== null) claims.email = o.email ?? 'user@example.test';
  // Supabase adds `aal`/`amr` only once MFA exists on the account; a token without `aal` is aal1.
  if (o.aal !== null) claims.aal = o.aal ?? 'aal1';
  if (o.amr) claims.amr = o.amr;
  if (o.sessionId !== undefined) claims.session_id = o.sessionId;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: o.kid ?? 'k1' })
    .setSubject(o.sub ?? randomUUID())
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? 'authenticated')
    .setIssuedAt()
    .setExpirationTime(o.exp ?? '1h')
    .sign(privateKey);
}

describe('createTokenVerifier', () => {
  it('accepts a valid token and returns the user id and email', async () => {
    const sub = randomUUID();
    const claims = await verify(await sign({ sub, email: 'a@example.test' }));
    expect(claims).toEqual({ userId: sub, email: 'a@example.test', aal: 'aal1' });
  });

  it('reads the aal claim, and treats a token without one as aal1 (Supabase adds it only with MFA)', async () => {
    expect((await verify(await sign({ aal: 'aal2' }))).aal).toBe('aal2');
    expect((await verify(await sign({ aal: 'aal1' }))).aal).toBe('aal1');
    expect((await verify(await sign({ aal: null }))).aal).toBe('aal1');
  });

  it('passes the Supabase session id through only when it is a UUID', async () => {
    const sid = randomUUID();
    expect((await verify(await sign({ sessionId: sid }))).sessionId).toBe(sid);
    expect(await verify(await sign())).not.toHaveProperty('sessionId');
    expect(await verify(await sign({ sessionId: 'not-a-uuid' }))).not.toHaveProperty('sessionId');
    expect(await verify(await sign({ sessionId: 42 }))).not.toHaveProperty('sessionId');
  });

  it('never trusts an aal value it does not recognise: anything but aal2 reads as aal1', async () => {
    for (const aal of ['aal3', 'AAL2', 'aal2 ', '', 'true', '2']) {
      expect((await verify(await sign({ aal }))).aal, aal).toBe('aal1');
    }
  });

  it.each([
    ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ['wrong issuer', { iss: 'https://evil.supabase.co/auth/v1' }],
    ['wrong audience', { aud: 'anon' }],
    ['missing email', { email: null }],
    ['empty email', { email: '' }],
    ['non-uuid sub', { sub: 'not-a-uuid' }],
    ['unknown kid', { kid: 'zzz' }],
  ] as const)('rejects %s', async (_name, o) => {
    await expect(verify(await sign(o))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it.each(['', 'garbage', 'a.b.c', 'x'.repeat(10_000)])('rejects a malformed token (%#)', async (t) => {
    await expect(verify(t)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects an unsecured alg:none token', async () => {
    const t = new UnsecuredJWT({ email: 'a@example.test' }).setSubject(randomUUID()).setIssuer(ISSUER).setAudience('authenticated').setExpirationTime('1h').encode();
    await expect(verify(t)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects an HS256 token signed with the public key bytes as the secret', async () => {
    const secret = new TextEncoder().encode(JSON.stringify(publicJwk));
    const t = await new SignJWT({ email: 'a@example.test' })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setSubject(randomUUID()).setIssuer(ISSUER).setAudience('authenticated').setExpirationTime('1h')
      .sign(secret);
    await expect(verify(t)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('never puts the token in the error', async () => {
    const t = await sign({ aud: 'anon' });
    const err = await verify(t).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(String(err?.message)).not.toContain(t);
    expect(String(err?.message)).toBe('Unauthorized');
  });
});

describe('createTokenVerifier: key set unavailable', () => {
  it.each([
    ['a network failure', () => new TypeError('fetch failed')],
    ['a JWKS timeout', () => new errors.JWKSTimeout()],
    ['a non-200 JWKS response', () => new errors.JOSEError('Expected 200 OK from the JSON Web Key Set HTTP response')],
    ['an invalid JWKS document', () => new errors.JWKSInvalid('JSON Web Key Set malformed')],
  ])('reports %s as AuthUnavailableError, not as a bad token', async (_name, make) => {
    const v = createTokenVerifier({ supabaseUrl: SUPABASE_URL, keys: async () => { throw make(); } });
    await expect(v(await sign())).rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it('still answers Unauthorized when the key set simply has no matching key', async () => {
    await expect(verify(await sign({ kid: 'unknown' }))).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
