import { describe, expect, it } from "vitest"
import type { Instance, InstanceStatus } from "../src/lib/api/types"
import { arrangeInstances, countByGroup, groupOf } from "../src/lib/instance-list"

const inst = (name: string, status: InstanceStatus, createdAt: string) => ({ id: name, name, status, createdAt }) as Instance

const list = [
  inst("old-stopped", "STOPPED", "2026-11-01T00:00:00Z"),
  inst("b-active", "ACTIVE", "2026-11-02T00:00:00Z"),
  inst("failed", "FAILED", "2026-11-05T00:00:00Z"),
  inst("a-active", "ACTIVE", "2026-11-04T00:00:00Z"),
  inst("starting", "STARTING", "2026-11-06T00:00:00Z"),
]

describe("arrangeInstances", () => {
  it("puts active instances first by default, newest first within a group", () => {
    expect(arrangeInstances(list, "all", "active").map((i) => i.name)).toEqual([
      "a-active",
      "b-active",
      "failed",
      "starting",
      "old-stopped",
    ])
  })
  it("sorts by newest or by name", () => {
    expect(arrangeInstances(list, "all", "newest")[0]!.name).toBe("starting")
    expect(arrangeInstances(list, "all", "name").map((i) => i.name)[0]).toBe("a-active")
  })
  it("filters by group without changing the input", () => {
    expect(arrangeInstances(list, "running", "active").map((i) => i.name)).toEqual(["a-active", "b-active"])
    expect(list[0]!.name).toBe("old-stopped")
  })
})

describe("groups", () => {
  it("maps every status to a group and counts them", () => {
    expect(groupOf("DEGRADED")).toBe("problem")
    expect(groupOf("SUSPENDED")).toBe("stopped")
    expect(groupOf("PENDING")).toBe("busy")
    expect(countByGroup(list)).toEqual({ all: 5, running: 2, busy: 1, stopped: 1, problem: 1 })
  })
})
