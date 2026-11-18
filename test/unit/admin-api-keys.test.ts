import { describe, expect, it } from 'vitest';
import { generateKey, hashKey, isAdminKey, keyUsable, KEY_PREFIX } from '../../src/modules/admin/api-keys.js';

describe('admin api keys', () => {
  it('makes a random, prefixed key whose hash and prefix are all that is stored', () => {
    const a = generateKey();
    const b = generateKey();
    expect(a.plaintext).toMatch(/^nca_[A-Za-z0-9_-]{43}$/);
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).toBe(hashKey(a.plaintext));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).not.toContain(a.plaintext.slice(KEY_PREFIX.length));
    expect(a.plaintext.startsWith(a.prefix)).toBe(true);
    expect(a.prefix).toHaveLength(10);
    expect(isAdminKey(a.plaintext)).toBe(true);
    expect(isAdminKey('eyJhbGciOi.jwt')).toBe(false);
  });

  it('is usable only before its expiry and while not revoked', () => {
    const now = new Date('2026-11-19T00:00:00Z');
    const later = new Date('2026-11-20T00:00:00Z');
    const earlier = new Date('2026-11-18T00:00:00Z');
    expect(keyUsable({ revokedAt: null, expiresAt: null }, now)).toBe(true);
    expect(keyUsable({ revokedAt: null, expiresAt: later }, now)).toBe(true);
    expect(keyUsable({ revokedAt: null, expiresAt: now }, now)).toBe(false);
    expect(keyUsable({ revokedAt: null, expiresAt: earlier }, now)).toBe(false);
    expect(keyUsable({ revokedAt: earlier, expiresAt: null }, now)).toBe(false);
  });
});
