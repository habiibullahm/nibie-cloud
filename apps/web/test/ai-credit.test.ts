import { afterEach, describe, expect, it, vi } from "vitest"
import { formatAiAmount, parseAiThreshold } from "../src/lib/ai-credit"
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
