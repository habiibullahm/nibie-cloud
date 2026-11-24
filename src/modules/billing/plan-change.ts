import { PERIOD_DAYS } from './lifecycle.js';
import { SUMOPOD_MIN_AMOUNT_IDR } from './sumopod-client.js';

export type PlanTerms = {
  monthlyPriceIdr: number;
  includedCreditNano: bigint | null;
  cpuMillis: number;
  memoryMb: number;
  storageMb: number;
};

export type PlanChangeQuote = {
  amountIdr: number;
  creditNano: bigint;
  immediate: boolean;
};

const PERIOD_MS = PERIOD_DAYS * 86_400_000;

/** Only same-or-larger resource plans can be switched to (shrinking XFS disk quota is not supported). */
export function canChangePlan(current: PlanTerms, target: PlanTerms): boolean {
  const fits =
    target.cpuMillis >= current.cpuMillis &&
    target.memoryMb >= current.memoryMb &&
    target.storageMb >= current.storageMb;
  if (!fits) return false;
  return (
    target.cpuMillis !== current.cpuMillis ||
    target.memoryMb !== current.memoryMb ||
    target.storageMb !== current.storageMb ||
    target.monthlyPriceIdr !== current.monthlyPriceIdr ||
    (target.includedCreditNano ?? 0n) !== (current.includedCreditNano ?? 0n)
  );
}

/**
 * Prorated Rupiah charge and AI credit for switching plans mid-period. The period end stays unchanged;
 * charges below SumoPod's minimum (including price decreases) apply immediately with no invoice and no credit.
 */
export function quotePlanChange(i: { current: PlanTerms; target: PlanTerms; now: Date; periodEnd: Date }): PlanChangeQuote {
  const remainingMs = Math.max(0, Math.min(PERIOD_MS, Math.trunc(i.periodEnd.getTime() - i.now.getTime())));
  const remainingBig = BigInt(remainingMs);
  const periodBig = BigInt(PERIOD_MS);

  const priceDiff = i.target.monthlyPriceIdr - i.current.monthlyPriceIdr;
  const amountIdr =
    priceDiff <= 0 || remainingMs === 0
      ? 0
      : Number((BigInt(priceDiff) * remainingBig + periodBig - 1n) / periodBig);
  const immediate = amountIdr < SUMOPOD_MIN_AMOUNT_IDR;

  const creditDiff = (i.target.includedCreditNano ?? 0n) - (i.current.includedCreditNano ?? 0n);
  const creditNano = immediate || creditDiff <= 0n ? 0n : (creditDiff * remainingBig) / periodBig;

  return { amountIdr, creditNano, immediate };
}
