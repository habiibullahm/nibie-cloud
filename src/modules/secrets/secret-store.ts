import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { NotFoundError } from '../../shared/errors.js';
import { keyHint, open, rewrap, seal, type Kek, type SealedSecret } from './crypto.js';

/** Either the client or a transaction, so callers can make a secret change atomic with their own rows. */
export type Db = PrismaClient | Prisma.TransactionClient;

export interface PutInput {
  tenantId: string;
  /** Short fixed label (`telegram_bot_token`, `provider_api_key`); part of the AAD. */
  purpose: string;
  plaintext: string;
}

/**
 * All customer credentials go through this interface (PRD 7.4). `put` and the metadata calls are safe for
 * request handlers. `get` returns plaintext and is for the worker / runtime path only: nothing under
 * `src/http` may import it (a unit test enforces that).
 */
export interface SecretStore {
  put(input: PutInput, db?: Db): Promise<{ id: string; keyHint: string }>;
  get(tenantId: string, secretId: string): Promise<string>;
  /** Marks the secret revoked and drops its ciphertext. Idempotent. */
  revoke(tenantId: string, secretId: string, db?: Db): Promise<void>;
  /** Removes rows entirely (instance deletion). Returns how many were removed. */
  deleteMany(tenantId: string, secretIds: string[], db?: Db): Promise<number>;
  /** Moves every row still on an older KEK version to the current one. Returns rows changed. */
  rewrapAll(): Promise<number>;
  countsByVersion(): Promise<Record<number, number>>;
}

const aadOf = (tenantId: string, secretId: string, purpose: string): string => `${tenantId}:${secretId}:${purpose}`;

export class PrismaSecretStore implements SecretStore {
  private readonly prisma: PrismaClient;
  private readonly current: Kek;
  private readonly keks: Kek[];

  constructor(opts: { prisma: PrismaClient; current: Kek; previous: Kek | null }) {
    this.prisma = opts.prisma;
    this.current = opts.current;
    this.keks = opts.previous ? [opts.current, opts.previous] : [opts.current];
  }

  async put(input: PutInput, db: Db = this.prisma): Promise<{ id: string; keyHint: string }> {
    const id = randomUUID();
    const sealed = seal(this.current, input.plaintext, aadOf(input.tenantId, id, input.purpose));
    const hint = keyHint(input.plaintext);
    await db.secret.create({ data: { id, tenantId: input.tenantId, purpose: input.purpose, keyHint: hint, ...sealed } });
    return { id, keyHint: hint };
  }

  async get(tenantId: string, secretId: string): Promise<string> {
    const row = await this.prisma.secret.findFirst({ where: { id: secretId, tenantId, revokedAt: null } });
    if (!row) throw new NotFoundError('Secret not found');
    return open(this.keks, row, aadOf(row.tenantId, row.id, row.purpose));
  }

  async revoke(tenantId: string, secretId: string, db: Db = this.prisma): Promise<void> {
    await db.secret.updateMany({
      where: { id: secretId, tenantId, revokedAt: null },
      data: { revokedAt: new Date(), ciphertext: '', iv: '', tag: '', wrappedKey: '', wrapIv: '', wrapTag: '', keyHint: '' },
    });
  }

  async deleteMany(tenantId: string, secretIds: string[], db: Db = this.prisma): Promise<number> {
    if (secretIds.length === 0) return 0;
    const r = await db.secret.deleteMany({ where: { tenantId, id: { in: secretIds } } });
    return r.count;
  }

  async rewrapAll(): Promise<number> {
    const rows = await this.prisma.secret.findMany({ where: { revokedAt: null, kekVersion: { not: this.current.version } } });
    let changed = 0;
    for (const row of rows) {
      const next: SealedSecret = rewrap(this.keks, row, aadOf(row.tenantId, row.id, row.purpose), this.current);
      const r = await this.prisma.secret.updateMany({
        where: { id: row.id, kekVersion: row.kekVersion, revokedAt: null },
        data: { wrappedKey: next.wrappedKey, wrapIv: next.wrapIv, wrapTag: next.wrapTag, kekVersion: next.kekVersion, rotatedAt: new Date() },
      });
      changed += r.count;
    }
    return changed;
  }

  async countsByVersion(): Promise<Record<number, number>> {
    const groups = await this.prisma.secret.groupBy({ by: ['kekVersion'], where: { revokedAt: null }, _count: { _all: true } });
    return Object.fromEntries(groups.map((g) => [g.kekVersion, g._count._all]));
  }
}
