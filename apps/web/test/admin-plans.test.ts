import { describe, expect, it, vi } from "vitest"
import { createAdminApi } from "../src/lib/api/admin"
import { parseStock, stockErrorMessage, stockLabel } from "../src/lib/admin-plans"

const BASE = "https://api.cloud.nibie.app"

describe("admin plan stock", () => {
  it("labels each kind of stock in words", () => {
    expect(stockLabel({ monthlyPriceIdr: null, stockLimit: null, stockUsed: 4, stockLeft: null })).toBe("Slot beta (4 terpakai)")
    expect(stockLabel({ monthlyPriceIdr: 50000, stockLimit: null, stockUsed: 2, stockLeft: null })).toBe("Tanpa batas (2 terpakai)")
    expect(stockLabel({ monthlyPriceIdr: 50000, stockLimit: 5, stockUsed: 2, stockLeft: 3 })).toBe("Sisa 3 dari 5")
    expect(stockLabel({ monthlyPriceIdr: 50000, stockLimit: 2, stockUsed: 3, stockLeft: 0 })).toBe("Habis (3/2)")
  })

  it("parses the form: empty is no limit, only whole numbers up to the cap", () => {
    expect(parseStock("  ")).toEqual({ ok: true, value: null })
    expect(parseStock(" 0 ")).toEqual({ ok: true, value: 0 })
    expect(parseStock("100000")).toEqual({ ok: true, value: 100000 })
    for (const bad of ["-1", "1.5", "1e3", "abc", "100001"]) expect(parseStock(bad)).toEqual({ ok: false })
  })

  it("maps errors to Indonesian text", () => {
    expect(stockErrorMessage({ status: 409, code: "free_plan_stock" })).toMatch(/FREE_BETA_SLOTS/)
    expect(stockErrorMessage({ status: 403, code: "mfa_required" })).toMatch(/verifikasi 2 langkah/)
    expect(stockErrorMessage(new Error("x"))).toBe("Gagal menyimpan. Coba lagi.")
  })

  it("sends a JSON POST with the stock and reason, and an encoded id", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ plan: { id: "p1", slug: "pro", stockLimit: null } }), { status: 200 }))
    const out = await createAdminApi({ baseUrl: BASE, getToken: async () => "tok", fetchImpl: f as unknown as typeof fetch }).setPlanStock("../x", null, "no limit")
    expect(out).toEqual({ id: "p1", slug: "pro", stockLimit: null })
    const [url, init] = (f as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [string, RequestInit]
    expect(url).toBe(`${BASE}/api/v1/admin/plans/..%2Fx/stock`)
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body as string)).toEqual({ stockLimit: null, reason: "no limit" })
  })
})
