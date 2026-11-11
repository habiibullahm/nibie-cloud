import { Prisma } from '@prisma/client';

const CONNECTIVITY_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);

/** True when Postgres could not be reached or timed out (as opposed to a data/logic error). */
export function isDatabaseUnavailable(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientInitializationError) return true;
  if (e instanceof Prisma.PrismaClientKnownRequestError) return CONNECTIVITY_CODES.has(e.code);
  return false;
}
