import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api/client"
import { createMockApi, PLANS, STEP_MS } from "@/lib/api/mock"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const fresh = () => createMockApi({ empty: true, latencyMs: 0 })

describe("mock instances API", () => {
  it("provisions through the lifecycle to ACTIVE with events", async () => {
    const api = fresh()
    const created = await api.instances.create({ name: "demo", planId: PLANS[0]!.id }, "k1")
    expect(created.status).toBe("PENDING")
    expect(created.accessUrl).toBeNull()

    const seen: string[] = []
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(STEP_MS)
      seen.push((await api.instances.get(created.id)).status)
    }
    expect(seen).toEqual(["PROVISIONING", "CONFIGURING", "STARTING", "ACTIVE"])
    expect((await api.instances.get(created.id)).accessUrl).toMatch(/^https:\/\//)
    expect((await api.instances.events(created.id)).map((e) => e.type)).toContain("active")
  })

  it("is idempotent on the idempotency key", async () => {
    const api = fresh()
    const a = await api.instances.create({ name: "demo", planId: PLANS[0]!.id }, "same")
    const b = await api.instances.create({ name: "other", planId: PLANS[1]!.id }, "same")
    expect(b.id).toBe(a.id)
    expect(await api.instances.list()).toHaveLength(1)
  })

  it("validates names like the backend", async () => {
    const api = fresh()
    await expect(api.instances.create({ name: "", planId: PLANS[0]!.id }, "k")).rejects.toBeInstanceOf(ApiError)
    await expect(api.instances.create({ name: "x".repeat(64), planId: PLANS[0]!.id }, "k")).rejects.toThrow(/63/)
    await expect(api.instances.create({ name: "a\u0007b", planId: PLANS[0]!.id }, "k")).rejects.toThrow()
  })

  it("rejects actions the backend would reject with 409", async () => {
    const api = fresh()
    const i = await api.instances.create({ name: "demo", planId: PLANS[0]!.id }, "k")
    await expect(api.instances.stop(i.id)).rejects.toMatchObject({ status: 409 })
    await expect(api.instances.start(i.id)).rejects.toMatchObject({ status: 409 })
  })

  it("stops, starts and deletes", async () => {
    const api = fresh()
    const i = await api.instances.create({ name: "demo", planId: PLANS[0]!.id }, "k")
    await vi.advanceTimersByTimeAsync(STEP_MS * 4)

    expect((await api.instances.stop(i.id)).status).toBe("STOPPING")
    await vi.advanceTimersByTimeAsync(STEP_MS)
    expect((await api.instances.get(i.id)).status).toBe("STOPPED")

    expect((await api.instances.start(i.id)).status).toBe("STARTING")
    await vi.advanceTimersByTimeAsync(STEP_MS)
    expect((await api.instances.get(i.id)).status).toBe("ACTIVE")

    expect((await api.instances.remove(i.id)).status).toBe("DELETING")
    await vi.advanceTimersByTimeAsync(STEP_MS)
    await expect(api.instances.get(i.id)).rejects.toMatchObject({ status: 404 })
    expect(await api.instances.list()).toHaveLength(0)
  })

  it("seeds a demo workspace by default", async () => {
    const api = createMockApi({ latencyMs: 0 })
    const statuses = (await api.instances.list()).map((i) => i.status)
    // Oldest first, like the backend's list().
    expect(statuses).toEqual(["STOPPED", "ACTIVE", "DEGRADED"])
  })
})

describe("mock preview API", () => {
  it("never returns a stored secret, only a hint", async () => {
    const api = fresh()
    const i = await api.instances.create({ name: "demo", planId: PLANS[0]!.id }, "k")
    const saved = await api.preview.saveProvider(i.id, { kind: "byok", providerName: "openai", apiKey: "sk-test-1234567890abcd" })
    expect(JSON.stringify(saved)).not.toContain("sk-test")
    expect(saved.keyHint).toBe("…abcd")
  })

  it("rejects non-https BYOK base URLs", async () => {
    const api = fresh()
    const i = await api.instances.create({ name: "demo", planId: PLANS[0]!.id }, "k")
    await expect(
      api.preview.saveProvider(i.id, { kind: "byok", providerName: "custom", apiKey: "k-1234", baseUrl: "http://10.0.0.1" })
    ).rejects.toThrow(/https/)
  })

  it("rejects malformed Telegram tokens and stores only a hint", async () => {
    const api = fresh()
    const i = await api.instances.create({ name: "demo", planId: PLANS[0]!.id }, "k")
    await expect(api.preview.saveTelegram(i.id, { token: "nope", mode: "polling", allowlist: [] })).rejects.toThrow()
    const token = "123456789:AAEexampleexampleexampleexample_12"
    const saved = await api.preview.saveTelegram(i.id, { token, mode: "polling", allowlist: ["@me"] })
    expect(JSON.stringify(saved)).not.toContain(token)
    expect(saved.verified).toBe(false)
  })

  it("synthesizes rows for unknown ids only in live mode", async () => {
    await expect(fresh().preview.usage("11111111-1111-4111-8111-111111111111", "1h")).rejects.toMatchObject({ status: 404 })
    const live = createMockApi({ empty: true, latencyMs: 0, synthesizeUnknown: true })
    const usage = await live.preview.usage("11111111-1111-4111-8111-111111111111", "1h")
    expect(usage.points).toHaveLength(60)
  })
})
