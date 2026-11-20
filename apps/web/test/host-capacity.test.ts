import { describe, expect, it } from "vitest"
import type { AdminHostUsage } from "@/lib/api/admin-types"
import { DEFAULT_INSTANCE_MB, hostRoom, isStale, percent } from "@/lib/host-capacity"

const host = (o: Partial<AdminHostUsage> = {}): AdminHostUsage => ({
  ts: "2026-11-21T00:00:00Z", cpus: 4, load1: 0.1, memTotalMb: 15485, memUsedMb: 1103, memAvailableMb: 14000,
  diskTotalMb: 222000, diskUsedMb: 35000, volumesTotalMb: 102000, volumesUsedMb: 700, tenants: 0, tenantMemMb: 0, ...o,
})

describe("host capacity", () => {
  it("uses the measured idle size when no instance runs", () => {
    // 15485 * 0.7 = 10839.5; minus 1103 used = 9736.5; / 400 = 24
    expect(hostRoom(host())).toEqual({ perInstanceMb: DEFAULT_INSTANCE_MB, room: 24 })
  })

  it("uses the running instances' average once there are some", () => {
    expect(hostRoom(host({ tenants: 4, tenantMemMb: 1000, memUsedMb: 2103 }))).toEqual({ perInstanceMb: 250, room: 34 })
  })

  it("never reports negative room past the 70 % line", () => {
    expect(hostRoom(host({ memUsedMb: 12000, tenants: 30, tenantMemMb: 11000 })).room).toBe(0)
  })

  it("caps percentages and survives a zero total", () => {
    expect(percent(50, 200)).toBe(25)
    expect(percent(300, 200)).toBe(100)
    expect(percent(1, 0)).toBe(0)
  })

  it("marks a snapshot older than 15 minutes as stale", () => {
    const t = Date.parse("2026-11-21T00:00:00Z")
    expect(isStale("2026-11-21T00:00:00Z", t + 10 * 60_000)).toBe(false)
    expect(isStale("2026-11-21T00:00:00Z", t + 16 * 60_000)).toBe(true)
  })
})
