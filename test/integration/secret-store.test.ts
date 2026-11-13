import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../../src/db/client.js';
import { open, type Kek } from '../../src/modules/secrets/crypto.js';
import { PrismaSecretStore } from '../../src/modules/secrets/secret-store.js';
import { NotFoundError } from '../../src/shared/errors.js';
import { resetDb } from '../helpers/db.js';
import { seed } from '../helpers/service-env.js';

const prisma = createPrisma(process.env.DATABASE_URL!);
const k1: Kek = { version: 1, key: randomBytes(32) };
const k2: Kek = { version: 2, key: randomBytes(32) };
const PLAIN = 'canary-token-123456:ABCDEFGHIJKLMNOP-xyz';
let s: Awaited<ReturnType<typeof seed>>;
let store: PrismaSecretStore;

describe('PrismaSecretStore', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    s = await seed(prisma);
    store = new PrismaSecretStore({ prisma, current: k1, previous: null });
  });
  afterAll(() => prisma.$disconnect());

  it('put returns an id and a hint, and no column of the row holds the plaintext', async () => {
    const r = await store.put({ tenantId: s.tenant.id, purpose: 'telegram_bot_token', plaintext: PLAIN });
    expect(r.keyHint).toBe(PLAIN.slice(-4));
    const row = await prisma.secret.findUniqueOrThrow({ where: { id: r.id } });
    expect(JSON.stringify(row)).not.toContain(PLAIN);
    expect(JSON.stringify(row)).not.toContain(PLAIN.slice(0, 20));
    expect(row.kekVersion).toBe(1);
  });

  it('get round-trips for the owning tenant only', async () => {
    const r = await store.put({ tenantId: s.tenant.id, purpose: 'telegram_bot_token', plaintext: PLAIN });
    expect(await store.get(s.tenant.id, r.id)).toBe(PLAIN);
    await expect(store.get(s.other.id, r.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a row moved to another tenant cannot be decrypted (AAD binds the tenant)', async () => {
    const r = await store.put({ tenantId: s.tenant.id, purpose: 'telegram_bot_token', plaintext: PLAIN });
    await prisma.secret.update({ where: { id: r.id }, data: { tenantId: s.other.id } });
    await expect(store.get(s.other.id, r.id)).rejects.toThrow('Secret could not be decrypted');
  });

  it('get of a revoked secret is not found', async () => {
    const r = await store.put({ tenantId: s.tenant.id, purpose: 'provider_api_key', plaintext: PLAIN });
    await store.revoke(s.tenant.id, r.id);
    await expect(store.get(s.tenant.id, r.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await prisma.secret.findUniqueOrThrow({ where: { id: r.id } })).revokedAt).not.toBeNull();
  });

  it('revoke keeps no usable ciphertext', async () => {
    const r = await store.put({ tenantId: s.tenant.id, purpose: 'provider_api_key', plaintext: PLAIN });
    await store.revoke(s.tenant.id, r.id);
    const row = await prisma.secret.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.ciphertext).toBe('');
    expect(row.wrappedKey).toBe('');
  });

  it('rewrapAll moves rows to the new key version and keeps ids and plaintext', async () => {
    const r = await store.put({ tenantId: s.tenant.id, purpose: 'telegram_bot_token', plaintext: PLAIN });
    const rotated = new PrismaSecretStore({ prisma, current: k2, previous: k1 });
    expect(await rotated.get(s.tenant.id, r.id)).toBe(PLAIN); // old key still opens it
    expect(await rotated.rewrapAll()).toBe(1);
    const row = await prisma.secret.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.kekVersion).toBe(2);
    expect(row.rotatedAt).not.toBeNull();
    const onlyNew = new PrismaSecretStore({ prisma, current: k2, previous: null });
    expect(await onlyNew.get(s.tenant.id, r.id)).toBe(PLAIN);
    expect(open([k2], { ...row }, `${s.tenant.id}:${r.id}:telegram_bot_token`)).toBe(PLAIN);
  });

  it('a store without the right key fails closed with a generic error', async () => {
    const r = await store.put({ tenantId: s.tenant.id, purpose: 'telegram_bot_token', plaintext: PLAIN });
    const wrong = new PrismaSecretStore({ prisma, current: { version: 1, key: randomBytes(32) }, previous: null });
    await expect(wrong.get(s.tenant.id, r.id)).rejects.toThrow('Secret could not be decrypted');
  });

  it('countsByVersion reports how many secrets use each key version (no keys, no values)', async () => {
    await store.put({ tenantId: s.tenant.id, purpose: 'a', plaintext: PLAIN });
    await store.put({ tenantId: s.tenant.id, purpose: 'b', plaintext: PLAIN });
    expect(await store.countsByVersion()).toEqual({ 1: 2 });
  });

  it('deleteMany removes the rows entirely', async () => {
    const a = await store.put({ tenantId: s.tenant.id, purpose: 'a', plaintext: PLAIN });
    const b = await store.put({ tenantId: s.tenant.id, purpose: 'b', plaintext: PLAIN });
    expect(await store.deleteMany(s.tenant.id, [a.id, b.id])).toBe(2);
    expect(await prisma.secret.count()).toBe(0);
  });
});
