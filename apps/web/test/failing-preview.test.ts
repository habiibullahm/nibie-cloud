import { describe, expect, it } from "vitest"
import { ApiError } from "@/lib/api/client"
import { failingPreview } from "@/lib/api"
import { createMockApi } from "@/lib/api/mock"

describe("failingPreview", () => {
  it("keeps every preview method and makes each one reject with a 503", async () => {
    const { preview } = createMockApi({ empty: true, latencyMs: 0 })
    const failing = failingPreview(preview)
    expect(Object.keys(failing).sort()).toEqual(Object.keys(preview).sort())
    const call = failing.plans as () => Promise<unknown>
    await expect(call()).rejects.toBeInstanceOf(ApiError)
    await expect(call()).rejects.toMatchObject({ status: 503 })
  })
})
