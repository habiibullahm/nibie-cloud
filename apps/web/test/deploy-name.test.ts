import { describe, expect, it } from "vitest"
import { validateInstanceName } from "@/app/(app)/deploy/validate-name"

describe("instance name validation", () => {
  it("accepts typical names", () => {
    expect(validateInstanceName("my-assistant")).toBeNull()
  })
  it("rejects empty, too long and control characters", () => {
    expect(validateInstanceName("   ")).toMatch(/Enter/)
    expect(validateInstanceName("a".repeat(64))).toMatch(/63/)
    expect(validateInstanceName("a\nb")).toMatch(/control/)
  })
})
