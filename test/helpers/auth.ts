import { randomUUID } from 'node:crypto';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import type { Config } from '../../src/config/env.js';
import { createTokenVerifier } from '../../src/modules/auth/token-verifier.js';

export const TEST_SUPABASE_URL = 'https://test-project.supabase.co';
export const TEST_ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';
export const DASHBOARD_ORIGIN = 'https://cloud.nibie.app';

export interface TokenOverrides { sub?: string; email?: string; exp?: string | number; aud?: string }

/** Local signing keys and a verifier that trusts them: no network, no Supabase project. */
export async function createTestAuth() {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };
  const verify = createTokenVerifier({ supabaseUrl: TEST_SUPABASE_URL, keys: createLocalJWKSet({ keys: [jwk] }) });
  const signToken = (o: TokenOverrides = {}): Promise<string> =>
    new SignJWT({ email: o.email ?? 'user@example.test', role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject(o.sub ?? randomUUID())
      .setIssuer(`${TEST_SUPABASE_URL}/auth/v1`)
      .setAudience(o.aud ?? 'authenticated')
      .setIssuedAt()
      .setExpirationTime(o.exp ?? '1h')
      .sign(privateKey);
  return { verify, signToken };
}

export function testConfig(image: string, masterKey: string, o: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'test', databaseUrl: 'x', hermesImage: image, port: 0, adminToken: TEST_ADMIN_TOKEN,
    dockerSocketPath: '', masterKey, runtime: 'runc',
    diskQuota: 'off', diskCheckIntervalMs: 300_000, egressPolicy: 'off', canaryImage: undefined, canaryPrivateIp: undefined,
    supabaseUrl: TEST_SUPABASE_URL, dashboardOrigin: DASHBOARD_ORIGIN, betaAllowedEmails: [], maxInstancesPerTenant: 1, redisUrl: null, secrets: null,
    ...o,
  };
}
