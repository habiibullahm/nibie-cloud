import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { keyHint, open, rewrap, seal, SecretDecryptError, type Kek, type SealedSecret } from '../../src/modules/secrets/crypto.js';

const kek = (version: number): Kek => ({ version, key: randomBytes(32) });
const AAD = 'tenant-1:secret-1:telegram';
const PLAINTEXT = 'canary-plaintext-9f3a-ABCDEF';

describe('envelope encryption', () => {
  it('round-trips', () => {
    const k = kek(1);
    expect(open([k], seal(k, PLAINTEXT, AAD), AAD)).toBe(PLAINTEXT);
  });

  it('never stores the plaintext in any field', () => {
    const k = kek(1);
    const s = seal(k, PLAINTEXT, AAD);
    expect(JSON.stringify(s)).not.toContain(PLAINTEXT);
    expect(JSON.stringify(s)).not.toContain(k.key.toString('base64'));
  });

  it('produces different output for the same plaintext (random data key and iv)', () => {
    const k = kek(1);
    const a = seal(k, PLAINTEXT, AAD);
    const b = seal(k, PLAINTEXT, AAD);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
  });

  it.each<[string, (s: SealedSecret) => SealedSecret]>([
    ['ciphertext', (s) => ({ ...s, ciphertext: flip(s.ciphertext) })],
    ['iv', (s) => ({ ...s, iv: flip(s.iv) })],
    ['tag', (s) => ({ ...s, tag: flip(s.tag) })],
    ['wrapped key', (s) => ({ ...s, wrappedKey: flip(s.wrappedKey) })],
    ['wrap iv', (s) => ({ ...s, wrapIv: flip(s.wrapIv) })],
    ['wrap tag', (s) => ({ ...s, wrapTag: flip(s.wrapTag) })],
  ])('fails closed when the %s is tampered with', (_n, mutate) => {
    const k = kek(1);
    const bad = mutate(seal(k, PLAINTEXT, AAD));
    expectGeneric(() => open([k], bad, AAD));
  });

  it('fails when the AAD differs (a secret cannot be moved to another tenant or id)', () => {
    const k = kek(1);
    const s = seal(k, PLAINTEXT, AAD);
    expectGeneric(() => open([k], s, 'tenant-2:secret-1:telegram'));
  });

  it('fails when the key version is unknown or the key is wrong', () => {
    const k = kek(1);
    const s = seal(k, PLAINTEXT, AAD);
    expectGeneric(() => open([kek(2)], s, AAD));
    expectGeneric(() => open([{ version: 1, key: randomBytes(32) }], s, AAD));
    expectGeneric(() => open([], s, AAD));
  });

  it('opens with the previous key by version and rewraps to the new one without changing the plaintext', () => {
    const oldK = kek(1);
    const newK = kek(2);
    const s = seal(oldK, PLAINTEXT, AAD);
    expect(open([newK, oldK], s, AAD)).toBe(PLAINTEXT);
    const r = rewrap([newK, oldK], s, AAD, newK);
    expect(r.kekVersion).toBe(2);
    expect(r.ciphertext).toBe(s.ciphertext);
    expect(open([newK], r, AAD)).toBe(PLAINTEXT);
    expectGeneric(() => open([oldK], r, AAD));
  });

  it('rewrap of a tampered secret fails closed', () => {
    const k = kek(1);
    const s = seal(k, PLAINTEXT, AAD);
    expectGeneric(() => rewrap([k], { ...s, wrappedKey: flip(s.wrappedKey) }, AAD, k));
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => seal({ version: 1, key: randomBytes(16) }, PLAINTEXT, AAD)).toThrow();
  });

  it('error messages never contain plaintext, key or aad', () => {
    const k = kek(1);
    const s = seal(k, PLAINTEXT, AAD);
    try {
      open([k], s, 'other-aad-value');
      throw new Error('should have failed');
    } catch (e) {
      expect(e).toBeInstanceOf(SecretDecryptError);
      const msg = (e as Error).message;
      for (const leak of [PLAINTEXT, k.key.toString('base64'), 'other-aad-value', AAD]) expect(msg).not.toContain(leak);
    }
  });
});

describe('keyHint', () => {
  it('returns the last four characters of a long value', () => {
    expect(keyHint('sk-abcdefghijkl1234')).toBe('1234');
  });
  it('hides short values completely', () => {
    expect(keyHint('short')).toBe('****');
  });
});

function flip(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  buf[0] = (buf[0] ?? 0) ^ 0xff;
  return buf.toString('base64');
}

function expectGeneric(fn: () => unknown): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(SecretDecryptError);
  expect((err as Error).message).toBe('Secret could not be decrypted');
}
