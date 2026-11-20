import { afterEach, describe, expect, it, vi } from "vitest"
import { aiCreditUsd, formatAiAmount, parseAiThreshold } from "../src/lib/ai-credit"
import { createCustomerApi } from "../src/lib/api/customer"
import { createMockApi } from "../src/lib/api/mock"

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("AI credit helpers", () => {
  it("reads the reminder amount as whole rupiah within the backend's bounds", () => {
    expect(parseAiThreshold("10.000")).toBe(10_000)
    expect(parseAiThreshold("Rp 25000")).toBe(25_000)
    expect(parseAiThreshold("999")).toBeNull()
    expect(parseAiThreshold("1.000.001")).toBeNull()
    expect(parseAiThreshold("")).toBeNull()
    expect(parseAiThreshold("abc")).toBeNull()
  })

  it("shows Rupiah when a rate is known, US$ otherwise", () => {
    expect(formatAiAmount(37_200, 2, "id")).toMatch(/^Rp\s?37\.200$/)
    expect(formatAiAmount(null, 1.5)).toBe("US$1.50")
  })
})

describe("customer API: AI balance", () => {
  it("GET /ai, null when the backend has no NibieRouter (404); PUT /ai/alert returns the saved alert", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
    vi.stubGlobal("fetch", fetchMock)
    const api = createCustomerApi({ baseUrl: "https://api.example.test/", getToken: async () => "tok" })

    fetchMock.mockResolvedValueOnce(json({ error: { code: "not_found", message: "Route not found" } }, 404))
    expect(await api.billing.ai()).toBeNull()

    const view = { rate: { idrPerUsd: 18_600, source: "router" }, hasAccount: true, balanceUsd: 2, balanceIdr: 37_200, spend30dUsd: 0, spend30dIdr: 0, daily: [], models: [], alert: { enabled: true, thresholdIdr: 10_000 } }
    fetchMock.mockResolvedValueOnce(json(view))
    expect(await api.billing.ai()).toEqual(view)
    expect(fetchMock.mock.calls[1]![0]).toBe("https://api.example.test/api/v1/ai")

    fetchMock.mockResolvedValueOnce(json({ alert: { enabled: false, thresholdIdr: 25_000 } }))
    expect(await api.billing.setAiAlert({ enabled: false, thresholdIdr: 25_000 })).toEqual({ enabled: false, thresholdIdr: 25_000 })
    const [url, init] = fetchMock.mock.calls[2]!
    expect(url).toBe("https://api.example.test/api/v1/ai/alert")
    expect(init!.method).toBe("PUT")
    expect(JSON.parse(init!.body as string)).toEqual({ enabled: false, thresholdIdr: 25_000 })
  })

  it("mock mode has a sample balance and keeps the reminder, refusing an amount out of range", async () => {
    const api = createMockApi()
    const ai = await api.billing.ai()
    expect(ai?.balanceIdr).toBeGreaterThan(0)
    await api.billing.setAiAlert({ enabled: false, thresholdIdr: 50_000 })
    expect((await api.billing.ai())?.alert).toEqual({ enabled: false, thresholdIdr: 50_000 })
    await expect(api.billing.setAiAlert({ enabled: true, thresholdIdr: 10 })).rejects.toMatchObject({ status: 400 })
  })
})

describe("buying AI credit from the wallet", () => {
  it("shows the US$ credit rounded down to the cent", () => {
    expect(aiCreditUsd(50_000, 16_000)).toBe(3.12)
    expect(aiCreditUsd(16_000, 16_000)).toBe(1)
  })

  it("customer API posts the Rupiah amount with the Idempotency-Key and the Turnstile token", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
    vi.stubGlobal("fetch", fetchMock)
    const api = createCustomerApi({ baseUrl: "https://api.example.test/", getToken: async () => "tok" })
    const purchase = { id: "p1", amountIdr: 50_000, amountUsd: 3.125, status: "DONE", createdAt: "2026-11-20T00:00:00.000Z" }
    fetchMock.mockResolvedValueOnce(json({ purchase }, 201))
    expect(await api.billing.buyAiCredit(50_000, "key-1", "tok-1")).toEqual(purchase)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://api.example.test/api/v1/ai/credit")
    expect(init!.method).toBe("POST")
    expect(new Headers(init!.headers).get("idempotency-key")).toBe("key-1")
    expect(JSON.parse(init!.body as string)).toEqual({ amountIdr: 50_000, captchaToken: "tok-1" })
  })

  it("mock mode moves Rupiah from the sample wallet to the AI balance, refusing more than the balance", async () => {
    const api = createMockApi()
    const before = (await api.billing.wallet())!.balanceIdr
    const aiBefore = (await api.billing.ai())!.balanceIdr!
    expect((await api.billing.buyAiCredit(50_000, "k")).status).toBe("DONE")
    expect((await api.billing.wallet())!.balanceIdr).toBe(before - 50_000)
    expect((await api.billing.ai())!.balanceIdr).toBeGreaterThanOrEqual(aiBefore + 49_999)
    await expect(api.billing.buyAiCredit(1_000_000, "k2")).rejects.toMatchObject({ status: 409 })
  })
})
