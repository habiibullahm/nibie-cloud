import { describe, expect, it, vi } from "vitest"
import { createAdminApi, toPage } from "../src/lib/api/admin"

const BASE = "https://api.cloud.nibie.app"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function client(fetchImpl: typeof fetch, token: string | null = "tok") {
  return createAdminApi({ baseUrl: BASE, getToken: async () => token, fetchImpl })
}

describe("admin client", () => {
  it("sends the Supabase token as a bearer header and no cache", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "u1", email: "boss@nibie.app", aal: "aal2" }))
    const me = await client(fetchImpl as unknown as typeof fetch).me()
    expect(me).toEqual({ id: "u1", email: "boss@nibie.app", aal: "aal2" })
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/api/v1/admin/me`)
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok")
    expect(init.cache).toBe("no-store")
  })

  it("refuses to call without a token, before any request goes out", async () => {
    const fetchImpl = vi.fn()
    await expect(client(fetchImpl as unknown as typeof fetch, null).overview()).rejects.toMatchObject({ status: 401, code: "unauthorized" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("turns an error body into an ApiError with its status and code", async () => {
    const fetchImpl = async () => jsonResponse({ error: { code: "mfa_required", message: "Two-factor authentication is required for this action" } }, 403)
    await expect(client(fetchImpl as unknown as typeof fetch).plans()).rejects.toMatchObject({ status: 403, code: "mfa_required" })
  })

  it("still reports a status when the error body is not JSON", async () => {
    const fetchImpl = async () => new Response("<html>502</html>", { status: 502 })
    await expect(client(fetchImpl as unknown as typeof fetch).plans()).rejects.toMatchObject({ status: 502, code: "http_error" })
  })

  it("passes the search term and cursor through the query string", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ customers: [], nextCursor: null }))
    await client(fetchImpl as unknown as typeof fetch).customers("a b", "cur/1")
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    expect(url).toBe(`${BASE}/api/v1/admin/customers?q=a+b&cursor=cur%2F1`)
  })

  it("encodes ids so a path cannot escape the admin prefix", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ instance: {}, events: [] }))
    await client(fetchImpl as unknown as typeof fetch).instance("../../tenants/x")
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    expect(url).toBe(`${BASE}/api/v1/admin/instances/..%2F..%2Ftenants%2Fx`)
  })

  it("unwraps the named array of every paged route", async () => {
    const cases = [
      ["customers", "customers"],
      ["instances", "instances"],
      ["subscriptions", "subscriptions"],
      ["payments", "payments"],
      ["audit", "entries"],
    ] as const
    for (const [method, key] of cases) {
      const fetchImpl = async () => jsonResponse({ [key]: [{ id: "x" }], nextCursor: "c1" })
      const api = client(fetchImpl as unknown as typeof fetch)
      const page = await (method === "customers"
        ? api.customers("")
        : method === "instances"
          ? api.instances(undefined)
          : api[method]())
      expect(page.items).toEqual([{ id: "x" }])
      expect(page.nextCursor).toBe("c1")
    }
  })

  it("unwraps the single-resource routes", async () => {
    const plans = await client((async () => jsonResponse({ plans: [{ slug: "p" }] })) as unknown as typeof fetch).plans()
    expect(plans).toEqual([{ slug: "p" }])
    const nodes = await client((async () => jsonResponse({ nodes: [{ name: "local" }] })) as unknown as typeof fetch).nodes()
    expect(nodes).toEqual([{ name: "local" }])
  })
})

describe("toPage", () => {
  it("renames the cursor and keeps the array", () => {
    expect(toPage({ rows: [1, 2], nextCursor: "c" }, "rows")).toEqual({ items: [1, 2], nextCursor: "c" })
  })
})
