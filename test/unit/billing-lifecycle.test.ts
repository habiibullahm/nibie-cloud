import { describe, expect, it } from 'vitest';
import { dueNotice, nextTransition, periodAfterPayment, type SubscriptionFacts } from '../../src/modules/billing/lifecycle.js';

const DAY = 86_400_000;
const t0 = new Date('2026-12-01T00:00:00.000Z');
const at = (days: number, from = t0) => new Date(from.getTime() + days * DAY);

const facts = (o: Partial<SubscriptionFacts>): SubscriptionFacts => ({
  status: 'ACTIVE', currentPeriodEnd: at(30), cancelAtPeriodEnd: false, graceEndsAt: null, suspendedAt: null, retentionEndsAt: null, ...o,
});

describe('periodAfterPayment', () => {
  it('first payment: 30 days from now', () => {
    expect(periodAfterPayment({ now: t0, status: 'PENDING_PAYMENT', currentPeriodEnd: null })).toEqual({ start: t0, end: at(30) });
  });
  it('renewal before expiry extends from the current end, so no paid day is lost', () => {
    expect(periodAfterPayment({ now: at(20), status: 'ACTIVE', currentPeriodEnd: at(30) })).toEqual({ start: at(30), end: at(60) });
  });
  it.each(['GRACE', 'SUSPENDED', 'ENDED'] as const)('renewal in %s starts at the payment time', (status) => {
    expect(periodAfterPayment({ now: at(32), status, currentPeriodEnd: at(30) })).toEqual({ start: at(32), end: at(62) });
  });
  it('an ACTIVE row whose end already passed (tick not yet run) starts at the payment time', () => {
    expect(periodAfterPayment({ now: at(31), status: 'ACTIVE', currentPeriodEnd: at(30) })).toEqual({ start: at(31), end: at(61) });
  });
});

describe('nextTransition', () => {
  it('does nothing before the period ends, and exactly at the end moves to GRACE', () => {
    expect(nextTransition(facts({}), at(29.99))).toBeNull();
    expect(nextTransition(facts({}), at(30))).toEqual({ to: 'GRACE', graceEndsAt: at(33) });
  });
  it('a cancelled subscription follows the same path at the period end (PRD 10.4)', () => {
    expect(nextTransition(facts({ cancelAtPeriodEnd: true }), at(30))).toEqual({ to: 'GRACE', graceEndsAt: at(33) });
  });
  it('GRACE becomes SUSPENDED when the grace ends, with 30 days of retention from the suspension', () => {
    const g = facts({ status: 'GRACE', graceEndsAt: at(33) });
    expect(nextTransition(g, at(32.99))).toBeNull();
    expect(nextTransition(g, at(33))).toEqual({ to: 'SUSPENDED', suspendedAt: at(33), retentionEndsAt: at(63) });
  });
  it('SUSPENDED past retention ends the subscription and deletes the instance', () => {
    const s = facts({ status: 'SUSPENDED', suspendedAt: at(33), retentionEndsAt: at(63) });
    expect(nextTransition(s, at(62.99))).toBeNull();
    expect(nextTransition(s, at(63))).toEqual({ to: 'ENDED', deleteInstance: true });
  });
  it.each(['PENDING_PAYMENT', 'ENDED'] as const)('%s never moves by itself', (status) => {
    expect(nextTransition(facts({ status }), at(500))).toBeNull();
  });
});

describe('dueNotice', () => {
  it('sends reminders 7, 3 and 1 day before the end, each once', () => {
    const f = facts({});
    expect(dueNotice(f, at(22.99), [])).toBeNull();
    expect(dueNotice(f, at(23), [])).toBe('renewal_7d');
    expect(dueNotice(f, at(23.5), ['renewal_7d'])).toBeNull();
    expect(dueNotice(f, at(27), ['renewal_7d'])).toBe('renewal_3d');
    expect(dueNotice(f, at(29), ['renewal_7d', 'renewal_3d'])).toBe('renewal_1d');
    expect(dueNotice(f, at(29.9), ['renewal_7d', 'renewal_3d', 'renewal_1d'])).toBeNull();
  });
  it('after downtime sends only the most imminent reminder, not a backlog', () => {
    expect(dueNotice(facts({}), at(29.5), [])).toBe('renewal_1d');
    expect(dueNotice(facts({}), at(29.6), ['renewal_1d'])).toBeNull();
  });
  it('a cancelled subscription gets no renewal reminders', () => {
    expect(dueNotice(facts({ cancelAtPeriodEnd: true }), at(29.5), [])).toBeNull();
  });
  it('grace: one notice at the start, one a day before suspension', () => {
    const g = facts({ status: 'GRACE', graceEndsAt: at(33) });
    expect(dueNotice(g, at(30.1), [])).toBe('grace_started');
    expect(dueNotice(g, at(31), ['grace_started'])).toBeNull();
    expect(dueNotice(g, at(32), ['grace_started'])).toBe('suspension_warning');
    expect(dueNotice(g, at(32.5), ['grace_started', 'suspension_warning'])).toBeNull();
  });
  it('suspended: notice at suspension, deletion warning 7 days before retention ends', () => {
    const s = facts({ status: 'SUSPENDED', suspendedAt: at(33), retentionEndsAt: at(63) });
    expect(dueNotice(s, at(33), [])).toBe('suspended');
    expect(dueNotice(s, at(50), ['suspended'])).toBeNull();
    expect(dueNotice(s, at(56), ['suspended'])).toBe('deletion_warning');
    expect(dueNotice(s, at(60), ['suspended', 'deletion_warning'])).toBeNull();
  });
  it('never sends an earlier notice after a later one was sent', () => {
    expect(dueNotice(facts({ status: 'SUSPENDED', suspendedAt: at(33), retentionEndsAt: at(63) }), at(57), ['deletion_warning'])).toBeNull();
  });
  it('PENDING_PAYMENT and ENDED never get notices', () => {
    expect(dueNotice(facts({ status: 'PENDING_PAYMENT', currentPeriodEnd: null }), at(5), [])).toBeNull();
    expect(dueNotice(facts({ status: 'ENDED' }), at(500), [])).toBeNull();
  });
});
