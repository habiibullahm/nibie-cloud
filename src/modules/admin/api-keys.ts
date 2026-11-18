import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/** Every admin key starts with this, so the auth hook can tell a key from a Supabase token without a lookup. */
export const KEY_PREFIX = 'nca_';
/** `nca_` plus 32 bytes in base64url (43 characters). */
const KEY_FORMAT = /^nca_[A-Za-z0-9_-]{43}$/;
/** Expiry choices offered when a key is created; null means until revoked. */
export const KEY_EXPIRY_DAYS = [30, 90, 365] as const;
/** `lastUsedAt` is written at most this often, so a busy key does not write a row on every request. */
const LAST_USED_EVERY_MS = 60_000;

/** The columns an admin may see. Never the hash. */
export interface AdminApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  createdByEmail: string;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

const visible = {
  id: true, name: true, prefix: true, createdByEmail: true, createdAt: true, expiresAt: true, revokedAt: true, lastUsedAt: true,
} as const;

/** A new key: 32 random bytes. Only `hash` and `prefix` are stored. */
export function generateKey(): { plaintext: string; hash: string; prefix: string } {
  const plaintext = KEY_PREFIX + randomBytes(32).toString('base64url');
  return { plaintext, hash: hashKey(plaintext), prefix: plaintext.slice(0, KEY_PREFIX.length + 6) };
}

/** SHA-256 hex. The key is random, so a fast unsalted hash is enough: there is nothing to guess. */
export function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

export function isAdminKey(token: string): boolean {
  return token.startsWith(KEY_PREFIX);
}

/** True while the key may be used: not revoked and not past its expiry. */
export function keyUsable(k: { revokedAt: Date | null; expiresAt: Date | null }, now: Date): boolean {
  return k.revokedAt === null && (k.expiresAt === null || k.expiresAt > now);
}

export async function createKey(
  db: Db,
  input: { name: string; expiresInDays: number | null; createdByUserId: string; createdByEmail: string },
  now: Date = new Date(),
): Promise<{ key: AdminApiKeyRow; plaintext: string }> {
  const { plaintext, hash, prefix } = generateKey();
  const expiresAt = input.expiresInDays === null ? null : new Date(now.getTime() + input.expiresInDays * 86_400_000);
  const key = await db.adminApiKey.create({
    data: { name: input.name, prefix, hash, createdByUserId: input.createdByUserId, createdByEmail: input.createdByEmail, createdAt: now, expiresAt },
    select: visible,
  });
  return { key, plaintext };
}

/**
 * The usable key behind this plaintext, or null. Looked up by hash, so the database never sees the key and a timing
 * difference reveals nothing about it.
 */
export async function findActiveKey(
  db: Db,
  plaintext: string,
  now: Date = new Date(),
): Promise<{ id: string; prefix: string; createdByUserId: string; createdByEmail: string } | null> {
  // Malformed input never reaches the database.
  if (!KEY_FORMAT.test(plaintext)) return null;
  const row = await db.adminApiKey.findUnique({ where: { hash: hashKey(plaintext) } });
  if (!row || !keyUsable(row, now)) return null;
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_EVERY_MS) {
    await db.adminApiKey.update({ where: { id: row.id }, data: { lastUsedAt: now } });
  }
  return { id: row.id, prefix: row.prefix, createdByUserId: row.createdByUserId, createdByEmail: row.createdByEmail };
}

/** Every key, revoked and expired ones included, newest first. */
export async function listKeys(db: Db): Promise<AdminApiKeyRow[]> {
  return db.adminApiKey.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: visible });
}

/** Revokes a key. Null when it does not exist; `changed` false when it was already revoked. */
export async function revokeKey(db: Db, id: string, now: Date = new Date()): Promise<{ key: AdminApiKeyRow; changed: boolean } | null> {
  const existing = await db.adminApiKey.findUnique({ where: { id }, select: visible });
  if (!existing) return null;
  if (existing.revokedAt) return { key: existing, changed: false };
  const key = await db.adminApiKey.update({ where: { id }, data: { revokedAt: now }, select: visible });
  return { key, changed: true };
}
