import type { SubscriptionStatus } from '@prisma/client';

/** PRD 10.1: approved policy. Billing period is a fixed 30 days (decided in the milestone D plan). */
export const PERIOD_DAYS = 30;
export const GRACE_DAYS = 3;
export const RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;
const addDays = (d: Date, days: number): Date => new Date(d.getTime() + days * DAY_MS);

export interface SubscriptionFacts {
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  graceEndsAt: Date | null;
  suspendedAt: Date | null;
  retentionEndsAt: Date | null;
}

/**
 * The period a verified payment buys. Paying while the current period is still running extends from its
 * end (no paid day is lost); paying late (grace, suspended, or a row the tick has not moved yet) starts now.
 */
export function periodAfterPayment(i: { now: Date; status: SubscriptionStatus; currentPeriodEnd: Date | null }): { start: Date; end: Date } {
  const running = i.status === 'ACTIVE' && i.currentPeriodEnd !== null && i.currentPeriodEnd.getTime() > i.now.getTime();
  const start = running ? (i.currentPeriodEnd as Date) : i.now;
  return { start, end: addDays(start, PERIOD_DAYS) };
}

export type Transition =
  | { to: 'GRACE'; graceEndsAt: Date }
  | { to: 'SUSPENDED'; suspendedAt: Date; retentionEndsAt: Date }
  | { to: 'ENDED'; deleteInstance: true };

/** One step of the PRD 10.2 lifecycle that is due at `now`, or null. Callers loop until null. */
export function nextTransition(s: SubscriptionFacts, now: Date): Transition | null {
  const t = now.getTime();
  if (s.status === 'ACTIVE' && s.currentPeriodEnd && s.currentPeriodEnd.getTime() <= t) {
    return { to: 'GRACE', graceEndsAt: addDays(s.currentPeriodEnd, GRACE_DAYS) };
  }
  if (s.status === 'GRACE' && s.graceEndsAt && s.graceEndsAt.getTime() <= t) {
    return { to: 'SUSPENDED', suspendedAt: now, retentionEndsAt: addDays(now, RETENTION_DAYS) };
  }
  if (s.status === 'SUSPENDED' && s.retentionEndsAt && s.retentionEndsAt.getTime() <= t) {
    return { to: 'ENDED', deleteInstance: true };
  }
  return null;
}

export type NoticeKind =
  | 'renewal_7d' | 'renewal_3d' | 'renewal_1d'
  | 'grace_started' | 'suspension_warning'
  | 'suspended' | 'deletion_warning'
  | 'deleted';

/** Order matters: a notice is never sent after a later one was. `deleted` is sent by the tick itself. */
const CHAIN: NoticeKind[] = ['renewal_7d', 'renewal_3d', 'renewal_1d', 'grace_started', 'suspension_warning', 'suspended', 'deletion_warning', 'deleted'];

function holds(kind: NoticeKind, s: SubscriptionFacts, now: Date): boolean {
  const t = now.getTime();
  const before = (end: Date | null, days: number): boolean => end !== null && t >= end.getTime() - days * DAY_MS;
  switch (kind) {
    case 'renewal_7d': return s.status === 'ACTIVE' && !s.cancelAtPeriodEnd && s.currentPeriodEnd !== null && s.currentPeriodEnd.getTime() > t && before(s.currentPeriodEnd, 7);
    case 'renewal_3d': return s.status === 'ACTIVE' && !s.cancelAtPeriodEnd && s.currentPeriodEnd !== null && s.currentPeriodEnd.getTime() > t && before(s.currentPeriodEnd, 3);
    case 'renewal_1d': return s.status === 'ACTIVE' && !s.cancelAtPeriodEnd && s.currentPeriodEnd !== null && s.currentPeriodEnd.getTime() > t && before(s.currentPeriodEnd, 1);
    case 'grace_started': return s.status === 'GRACE';
    case 'suspension_warning': return s.status === 'GRACE' && before(s.graceEndsAt, 1);
    case 'suspended': return s.status === 'SUSPENDED';
    case 'deletion_warning': return s.status === 'SUSPENDED' && before(s.retentionEndsAt, 7);
    case 'deleted': return false;
  }
}

/**
 * The one notice to send now, or null. `alreadySent` are the kinds recorded for the current period end.
 * Only the most advanced applicable kind is considered, and nothing is sent when that kind or a later
 * one was already sent: after downtime a customer gets the current reminder, not a backlog.
 */
export function dueNotice(s: SubscriptionFacts, now: Date, alreadySent: string[]): NoticeKind | null {
  let latest: NoticeKind | null = null;
  for (const k of CHAIN) if (holds(k, s, now)) latest = k;
  if (latest === null) return null;
  const idx = CHAIN.indexOf(latest);
  return alreadySent.some((k) => CHAIN.indexOf(k as NoticeKind) >= idx) ? null : latest;
}
