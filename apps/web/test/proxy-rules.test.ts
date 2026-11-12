import { describe, expect, it } from "vitest"
import { backendPath, isForwardable } from "@/lib/api/proxy-rules"

const ID = "4f2a91c8-1b2c-4d3e-8f90-123456789abc"

describe("dev bridge allowlist", () => {
  it.each([
    ["GET", ["instances"]],
    ["POST", ["instances"]],
    ["GET", ["instances", ID]],
    ["GET", ["instances", ID, "status"]],
    ["GET", ["instances", ID, "events"]],
    ["POST", ["instances", ID, "start"]],
    ["POST", ["instances", ID, "stop"]],
    ["POST", ["instances", ID, "restart"]],
    ["DELETE", ["instances", ID]],
  ])("forwards %s %j", (method, segs) => {
    expect(isForwardable(method, segs)).toBe(true)
  })

  it.each([
    ["DELETE", ["instances"]],
    ["PUT", ["instances", ID]],
    ["GET", ["instances", "not-a-uuid"]],
    ["GET", ["instances", "..", "..", "healthz"]],
    ["GET", ["instances", `${ID}/../../x`]],
    ["POST", ["instances", ID, "exec"]],
    ["GET", ["tenants", ID, "instances"]],
    ["GET", ["instances", ID, "logs"]],
    ["GET", []],
  ])("refuses %s %j", (method, segs) => {
    expect(isForwardable(method, segs)).toBe(false)
  })

  it("builds the tenant-scoped backend path", () => {
    expect(backendPath("t-1", ["instances", ID, "status"])).toBe(`/api/v1/tenants/t-1/instances/${ID}/status`)
  })
})
