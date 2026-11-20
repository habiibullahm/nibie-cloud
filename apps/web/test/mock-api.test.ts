import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api/client"
import { createMockApi, MOCK_PAYMENT_URL, PLANS, STEP_MS } from "@/lib/api/mock"

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
    const saved = await api.preview.saveProvider(i.id, {
      kind: "byok",
      providerName: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-test-1234567890abcd",
    })
    expect(JSON.stringify(saved)).not.toContain("sk-test")
    expect(saved.keyHint).toBe("…abcd")
  })

  it("rejects non-https BYOK base URLs", async () => {
    const api = fresh()
    const i = await api.instances.create({ name: "demo", planId: PLANS[0]!.id }, "k")
    await expect(
      api.preview.saveProvider(i.id, { kind: "byok", providerName: "custom", model: "m", apiKey: "k-1234", baseUrl: "http://10.0.0.1" })
    ).rejects.toThrow(/https/)
  })

  it("changes the NibieRouter model only on a NibieRouter provider and only to a listed model", async () => {
    const api = fresh()
    const i = await api.instances.create({ name: "demo", planId: PLANS[0]!.id }, "k")
    await api.preview.saveProvider(i.id, { kind: "byok", providerName: "openai", baseUrl: "https://api.openai.com/v1", model: "m", apiKey: "sk-test-1234567890abcd" })
    await expect(api.preview.setRouterModel(i.id, "sample-fast")).rejects.toMatchObject({ code: "not_nibierouter" })
    await api.preview.saveProvider(i.id, { kind: "nibierouter" })
    await expect(api.preview.setRouterModel(i.id, "not-listed")).rejects.toMatchObject({ status: 400 })
    expect(await api.preview.setRouterModel(i.id, "sample-fast")).toMatchObject({ model: "sample-fast", restartRequired: true })
    expect((await api.preview.routerModels(i.id)).models.some((m) => m.free)).toBe(true)
  })

  it("rejects malformed Telegram tokens and stores only a hint", async () => {
    const api = fresh()
    const i = await api.instances.create({ name: "demo", planId: PLANS[0]!.id }, "k")
    await expect(api.preview.saveTelegram(i.id, { token: "nope", allowlist: ["1"] })).rejects.toThrow()
    const token = "123456789:AAEexampleexampleexampleexample_12"
    const saved = await api.preview.saveTelegram(i.id, { token, allowlist: ["123456789"] })
    expect(JSON.stringify(saved)).not.toContain(token)
    expect(saved.verified).toBe(false)
    expect(saved.restartRequired).toBe(true)
  })

  it("requires numeric Telegram user IDs, like the backend allowlist", async () => {
    const api = fresh()
    const i = await api.instances.create({ name: "demo", planId: PLANS[0]!.id }, "k")
    const token = "123456789:AAEexampleexampleexampleexample_12"
    await expect(api.preview.saveTelegram(i.id, { token, allowlist: [] })).rejects.toThrow(/numeric/)
    await expect(api.preview.saveTelegram(i.id, { token, allowlist: ["@me"] })).rejects.toThrow(/numeric/)
  })

  it("synthesizes rows for unknown ids only in live mode", async () => {
    await expect(fresh().preview.usage("11111111-1111-4111-8111-111111111111", "1h")).rejects.toMatchObject({ status: 404 })
    const live = createMockApi({ empty: true, latencyMs: 0, synthesizeUnknown: true })
    const usage = await live.preview.usage("11111111-1111-4111-8111-111111111111", "1h")
    expect(usage.points).toHaveLength(60)
  })
})

describe("mock billing", () => {
  it("gives every sample instance a subscription: active, grace and suspended", async () => {
    const api = createMockApi({ latencyMs: 0 })
    const subs = await api.billing.list()
    const instances = await api.instances.list()
    expect(subs).toHaveLength(instances.length)
    const statuses = new Set(subs.map((s) => s.status))
    expect(statuses).toEqual(new Set(["ACTIVE", "GRACE", "SUSPENDED"]))
    const suspended = subs.find((s) => s.status === "SUSPENDED")!
    expect(suspended.retentionEndsAt).not.toBeNull()
  })

  it("renews with a mock payment URL and cancels renewal", async () => {
    const api = createMockApi({ latencyMs: 0 })
    const sub = (await api.billing.list()).find((s) => s.status === "ACTIVE")!
    const renewed = await api.billing.renew(sub.id)
    expect(renewed.payment.paymentUrl).toBe(MOCK_PAYMENT_URL)
    const cancelled = await api.billing.cancel(sub.id)
    expect(cancelled.cancelAtPeriodEnd).toBe(true)
    expect((await api.billing.list()).find((s) => s.id === sub.id)!.cancelAtPeriodEnd).toBe(true)
  })

  it("refuses checkout because mock plans have no price", async () => {
    const api = createMockApi({ latencyMs: 0 })
    await expect(api.billing.checkout({ name: "a", planId: "x" }, "k")).rejects.toMatchObject({ code: "plan_not_for_sale" })
  })
})
