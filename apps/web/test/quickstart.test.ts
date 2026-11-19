import { describe, expect, it } from "vitest"
import type { Instance, InstanceStatus, ProviderConfig, TelegramConfig } from "../src/lib/api/types"
import { quickstartDone, quickstartInstance } from "../src/lib/quickstart"

const inst = (id: string, status: InstanceStatus): Instance => ({
  id,
  tenantId: "t",
  name: id,
  planId: "p",
  status,
  statusReason: null,
  accessUrl: null,
  createdAt: "2026-11-19T00:00:00Z",
})

describe("quickstartInstance", () => {
  it("prefers a running instance and skips deleted ones", () => {
    expect(quickstartInstance([inst("a", "DELETED"), inst("b", "STOPPED"), inst("c", "ACTIVE")])?.id).toBe("c")
    expect(quickstartInstance([inst("a", "DELETING"), inst("b", "STOPPED")])?.id).toBe("b")
    expect(quickstartInstance([inst("a", "DELETED")])).toBeNull()
  })
})

describe("quickstartDone", () => {
  const provider = { configured: true } as ProviderConfig
  const tg = (configured: boolean, verified: boolean) => ({ configured, verified }) as TelegramConfig

  it("marks nothing done without an instance", () => {
    expect(quickstartDone(null, provider, tg(true, true))).toEqual({ deploy: false, provider: false, telegram: false })
  })

  it("counts Telegram only once a test message was delivered", () => {
    const i = inst("a", "ACTIVE")
    expect(quickstartDone(i, undefined, undefined)).toEqual({ deploy: true, provider: false, telegram: false })
    expect(quickstartDone(i, provider, tg(true, false)).telegram).toBe(false)
    expect(quickstartDone(i, provider, tg(true, true))).toEqual({ deploy: true, provider: true, telegram: true })
  })
})
