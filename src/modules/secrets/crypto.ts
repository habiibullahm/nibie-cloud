import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption (PRD 7.4). Each secret gets its own random 32-byte data key. The data key encrypts
 * the value with AES-256-GCM; a key-encryption key (KEK, kept outside the database) wraps the data key
 * with AES-256-GCM. The AAD binds both ciphertexts to `tenantId:secretId:purpose`, so a stolen row cannot
 * be moved to another tenant or id. Everything is base64; nothing here logs or returns plaintext.
 */
export interface Kek {
  version: number;
  key: Buffer;
}

export interface SealedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
  wrappedKey: string;
  wrapIv: string;
  wrapTag: string;
  kekVersion: number;
}

/** One opaque error for every failure: no detail about which part was wrong. */
export class SecretDecryptError extends Error {
  constructor() {
    super('Secret could not be decrypted');
    this.name = 'SecretDecryptError';
  }
}

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

function assertKek(kek: Kek): void {
  if (!Number.isInteger(kek.version) || kek.version < 1 || kek.key.length !== KEY_BYTES) {
    throw new Error('Invalid key-encryption key');
  }
}

function gcmEncrypt(key: Buffer, data: Buffer, aad: Buffer): { out: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv(ALGO, key, iv);
  c.setAAD(aad);
  const out = Buffer.concat([c.update(data), c.final()]);
  return { out, iv, tag: c.getAuthTag() };
}

function gcmDecrypt(key: Buffer, data: Buffer, iv: Buffer, tag: Buffer, aad: Buffer): Buffer {
  const d = createDecipheriv(ALGO, key, iv);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]);
}

const b64 = (s: string): Buffer => Buffer.from(s, 'base64');

export function seal(kek: Kek, plaintext: string, aad: string): SealedSecret {
  assertKek(kek);
  const dataKey = randomBytes(KEY_BYTES);
  const aadBuf = Buffer.from(aad, 'utf8');
  const value = gcmEncrypt(dataKey, Buffer.from(plaintext, 'utf8'), aadBuf);
  const wrapped = gcmEncrypt(kek.key, dataKey, aadBuf);
  dataKey.fill(0);
  return {
    ciphertext: value.out.toString('base64'),
    iv: value.iv.toString('base64'),
    tag: value.tag.toString('base64'),
    wrappedKey: wrapped.out.toString('base64'),
    wrapIv: wrapped.iv.toString('base64'),
    wrapTag: wrapped.tag.toString('base64'),
    kekVersion: kek.version,
  };
}

function unwrap(keks: Kek[], s: SealedSecret, aadBuf: Buffer): Buffer {
  const kek = keks.find((k) => k.version === s.kekVersion);
  if (!kek) throw new SecretDecryptError();
  return gcmDecrypt(kek.key, b64(s.wrappedKey), b64(s.wrapIv), b64(s.wrapTag), aadBuf);
}

export function open(keks: Kek[], s: SealedSecret, aad: string): string {
  const aadBuf = Buffer.from(aad, 'utf8');
  let dataKey: Buffer | null = null;
  try {
    dataKey = unwrap(keks, s, aadBuf);
    return gcmDecrypt(dataKey, b64(s.ciphertext), b64(s.iv), b64(s.tag), aadBuf).toString('utf8');
  } catch {
    throw new SecretDecryptError();
  } finally {
    dataKey?.fill(0);
  }
}

/** Moves the data key to another KEK version. The value ciphertext is untouched and never decrypted. */
export function rewrap(keks: Kek[], s: SealedSecret, aad: string, to: Kek): SealedSecret {
  assertKek(to);
  const aadBuf = Buffer.from(aad, 'utf8');
  let dataKey: Buffer | null = null;
  try {
    dataKey = unwrap(keks, s, aadBuf);
    const wrapped = gcmEncrypt(to.key, dataKey, aadBuf);
    return { ...s, wrappedKey: wrapped.out.toString('base64'), wrapIv: wrapped.iv.toString('base64'), wrapTag: wrapped.tag.toString('base64'), kekVersion: to.version };
  } catch {
    throw new SecretDecryptError();
  } finally {
    dataKey?.fill(0);
  }
}

/** Last four characters for display; short values show nothing of themselves. */
export function keyHint(plaintext: string): string {
  return plaintext.length >= 12 ? plaintext.slice(-4) : '****';
}
