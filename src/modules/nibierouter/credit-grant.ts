import type { CreditGrant, PrismaClient } from '@prisma/client';
import type { NibieRouterClient } from './nibierouter-client.js';

/**
 * Posts one `CreditGrant` to the router at most once (see the model in the Prisma schema). Returns `busy` when another
 * run claimed the same attempt first: that run finishes it, or a later retry checks the router's history before posting.
 * A router failure throws and leaves the row PENDING with its raised `attempts`.
 */
export async function applyGrant(
  prisma: PrismaClient,
  client: Pick<NibieRouterClient, 'grantCredit' | 'hasCreditNote'>,
  userId: string,
  row: Pick<CreditGrant, 'id' | 'status' | 'attempts' | 'amountNano' | 'note'>,
): Promise<'done' | 'busy'> {
  if (row.status === 'DONE') return 'done';
  // An earlier attempt may have reached the router and only its answer got lost: look before posting again.
  if (row.attempts > 0 && (await client.hasCreditNote(userId, row.note))) {
    await prisma.creditGrant.update({ where: { id: row.id }, data: { status: 'DONE' } });
    return 'done';
  }
  // Raised before the call, so a crash after the call leaves a trace and the next run checks the history first. The
  // compare-and-set on `attempts` keeps two runs that read the same row from both posting.
  const claim = await prisma.creditGrant.updateMany({ where: { id: row.id, status: 'PENDING', attempts: row.attempts }, data: { attempts: { increment: 1 } } });
  if (claim.count === 0) return 'busy';
  const { balanceNano } = await client.grantCredit(userId, row.amountNano, row.note);
  await prisma.creditGrant.update({ where: { id: row.id }, data: { status: 'DONE', balanceAfterNano: balanceNano } });
  return 'done';
}
