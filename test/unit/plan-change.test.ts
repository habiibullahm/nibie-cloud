import { describe, expect, it } from 'vitest';
import { PERIOD_DAYS } from '../../src/modules/billing/lifecycle.js';
import { canChangePlan, quotePlanChange, type PlanTerms } from '../../src/modules/billing/plan-change.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const t0 = new Date('2026-12-01T00:00:00.000Z');
const after = (ms: number) => new Date(t0.getTime() + ms);

const hosting: PlanTerms = { monthlyPriceIdr: 25_000, includedCreditNano: null, cpuMillis: 1000, memoryMb: 1024, storageMb: 5120 };
const hostingKredit: PlanTerms = { monthlyPriceIdr: 50_000, includedCreditNano: 2_000_000_000n, cpuMillis: 1000, memoryMb: 1024, storageMb: 10240 };
const pro: PlanTerms = { monthlyPriceIdr: 49_000, includedCreditNano: null, cpuMillis: 2000, memoryMb: 4096, storageMb: 20480 };
const proKredit: PlanTerms = { monthlyPriceIdr: 79_000, includedCreditNano: 3_000_000_000n, cpuMillis: 2000, memoryMb: 4096, storageMb: 20480 };

describe('quotePlanChange', () => {
  it('hosting to pro with 15 of 30 days left costs half the difference', () => {
    const q = quotePlanChange({ current: hosting, target: pro, now: t0, periodEnd: after(15 * DAY) });
    expect(q).toEqual({ amountIdr: 12_000, creditNano: 0n, immediate: false });
  });

  it('hosting to hosting-kredit with 30 days left', () => {
    const q = quotePlanChange({ current: hosting, target: hostingKredit, now: t0, periodEnd: after(PERIOD_DAYS * DAY) });
    expect(q).toEqual({ amountIdr: 25_000, creditNano: 2_000_000_000n, immediate: false });
  });

  it('kredit to pro is immediate and free', () => {
    const q = quotePlanChange({ current: hostingKredit, target: pro, now: t0, periodEnd: after(15 * DAY) });
    expect(q.amountIdr).toBeLessThanOrEqual(0);
    expect(q.immediate).toBe(true);
    expect(q.creditNano).toBe(0n);
  });

  it('tiny remainder is immediate', () => {
    const q = quotePlanChange({ current: hosting, target: pro, now: t0, periodEnd: after(HOUR) });
    expect(q.immediate).toBe(true);
    expect(q.creditNano).toBe(0n);
  });

  it('prorates the credit difference rounded down in nano-USD', () => {
    const q = quotePlanChange({ current: hostingKredit, target: proKredit, now: t0, periodEnd: after(15 * DAY) });
    expect(q).toEqual({ amountIdr: 14_500, creditNano: 500_000_000n, immediate: false });
    const third = quotePlanChange({ current: hostingKredit, target: proKredit, now: t0, periodEnd: after(10 * DAY) });
    expect(third.creditNano).toBe(333_333_333n);
  });

  it('clamps remaining time to [0, PERIOD_DAYS]', () => {
    expect(quotePlanChange({ current: hosting, target: pro, now: t0, periodEnd: after(-DAY) })).toEqual({
      amountIdr: 0, creditNano: 0n, immediate: true,
    });
    expect(quotePlanChange({ current: hosting, target: pro, now: t0, periodEnd: after(45 * DAY) })).toEqual({
      amountIdr: 24_000, creditNano: 0n, immediate: false,
    });
  });
});

describe('canChangePlan', () => {
  it('canChangePlan refuses smaller storage and allows equal-resource credit upgrades', () => {
    expect(canChangePlan(hostingKredit, hosting)).toBe(false);
    expect(canChangePlan(pro, proKredit)).toBe(true);
  });

  it('refuses identical plans and smaller CPU or memory', () => {
    expect(canChangePlan(pro, { ...pro })).toBe(false);
    expect(canChangePlan(pro, { ...pro, cpuMillis: 1000 })).toBe(false);
    expect(canChangePlan(pro, { ...pro, memoryMb: 2048 })).toBe(false);
  });
});
