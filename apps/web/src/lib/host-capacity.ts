import type { AdminHostUsage } from "@/lib/api/admin-types"

/** Grow the server when the instances' memory reaches 70 % of host RAM (docs/capacity.md). */
export const RAM_BUDGET = 0.7
/** Idle instance as measured on jkt-1 (240-395 MB), used until running tenants give a real average. */
export const DEFAULT_INSTANCE_MB = 400
/** The timer writes every 5 minutes; three missed runs means the numbers are old. */
export const STALE_AFTER_MS = 15 * 60_000

export function percent(used: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
}

/** How many more instances fit under the 70 % RAM rule, at the current average per instance. */
export function hostRoom(h: AdminHostUsage): { perInstanceMb: number; room: number } {
  const perInstanceMb = h.tenants > 0 ? Math.max(1, Math.round(h.tenantMemMb / h.tenants)) : DEFAULT_INSTANCE_MB
  const room = Math.max(0, Math.floor((h.memTotalMb * RAM_BUDGET - h.memUsedMb) / perInstanceMb))
  return { perInstanceMb, room }
}

export function isStale(ts: string, now: number): boolean {
  return now - Date.parse(ts) > STALE_AFTER_MS
}
