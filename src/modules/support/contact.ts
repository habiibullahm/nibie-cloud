import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';

export interface SupportContactView {
  whatsapp: string | null;
  email: string | null;
}

/**
 * WhatsApp number as typed by an admin ("+62 812-3456-7890") to the digits wa.me needs ("6281234567890"). The country
 * code is required: a number starting with 0 is refused rather than guessed. Empty means "not offered".
 */
const whatsapp = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s\-().+]/g, ''))
  .refine((v) => v === '' || /^[1-9]\d{7,14}$/.test(v), 'WhatsApp number must be 8 to 15 digits with the country code, e.g. 6281234567890')
  .transform((v) => (v === '' ? null : v));

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .refine((v) => v === '' || z.string().email().safeParse(v).success, 'Invalid email address')
  .transform((v) => (v === '' ? null : v));

export const supportContactBody = z
  .object({ whatsapp, email, reason: z.string().trim().min(3).max(500) })
  .strict();

const EMPTY: SupportContactView = { whatsapp: null, email: null };

export async function readSupportContact(db: PrismaClient | Prisma.TransactionClient): Promise<SupportContactView> {
  const row = await db.supportContact.findUnique({ where: { id: 1 } });
  return row ? { whatsapp: row.whatsapp, email: row.email } : EMPTY;
}

export async function writeSupportContact(tx: Prisma.TransactionClient, next: SupportContactView): Promise<void> {
  await tx.supportContact.upsert({ where: { id: 1 }, create: { id: 1, ...next }, update: next });
}
