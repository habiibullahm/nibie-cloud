import { describe, expect, it } from "vitest"
import { BACKEND_STATUSES } from "@/lib/api/types"
import { allowedActions, isTransitional, presentStatus, provisionStepIndex, runtimeReachable } from "@/lib/api/status"

const PRD_LABELS = new Set([
  "Pending",
  "Provisioning",
  "Starting",
  "Active",
  "Degraded",
  "Suspended",
  "Failed",
  "Deleting",
  "Deleted",
])

describe("status presentation", () => {
  it("maps every backend status to a PRD §4.4 label, or Stopping/Stopped from the ADR", () => {
    for (const s of BACKEND_STATUSES) {
      const label = presentStatus(s).label
      expect(PRD_LABELS.has(label) || label === "Stopping" || label === "Stopped").toBe(true)
    }
  })

  it("never shows the internal CONFIGURING state", () => {
    expect(presentStatus("CONFIGURING").label).toBe("Provisioning")
  })

  it("gives failure-like states a reason and a next action", () => {
    for (const s of ["DEGRADED", "FAILED", "SUSPENDED", "STOPPED"] as const) {
      expect(presentStatus(s).defaultReason).toBeTruthy()
      expect(presentStatus(s).nextAction).toBeTruthy()
    }
  })

  it("marks only in-flight states as transitional", () => {
    expect(isTransitional("PROVISIONING")).toBe(true)
    expect(isTransitional("STOPPING")).toBe(true)
    expect(isTransitional("ACTIVE")).toBe(false)
    expect(isTransitional("FAILED")).toBe(false)
  })

  it("orders provisioning steps", () => {
    expect(provisionStepIndex("PENDING")).toBe(0)
    expect(provisionStepIndex("STARTING")).toBe(3)
    expect(provisionStepIndex("ACTIVE")).toBe(4)
    expect(provisionStepIndex("STOPPED")).toBe(-1)
  })
})

describe("allowed actions mirror the backend guards", () => {
  it.each([
    ["ACTIVE", ["delete", "restart", "stop"]],
    ["DEGRADED", ["delete", "restart", "stop"]],
    ["STOPPED", ["delete", "start"]],
    ["FAILED", ["delete"]],
    ["PROVISIONING", []],
    ["DELETING", []],
    ["SUSPENDED", []],
  ] as const)("%s", (status, expected) => {
    expect([...allowedActions(status)].sort()).toEqual([...expected])
  })

  it("only allows shell and files while the runtime is up", () => {
    expect(runtimeReachable("ACTIVE")).toBe(true)
    expect(runtimeReachable("DEGRADED")).toBe(true)
    expect(runtimeReachable("STOPPED")).toBe(false)
  })
})
