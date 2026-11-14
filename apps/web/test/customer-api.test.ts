import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "../src/lib/api/client"
import { createCustomerApi, toAccount, toPlan } from "../src/lib/api/customer"
import { createMockApi } from "../src/lib/api/mock"

const ID = "5b0c6a2e-1f1d-4c55-9a7e-0d1f3a000001"

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function setup(token: string | null = "tok") {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
  vi.stubGlobal("fetch", fetchMock)
  const preview = createMockApi({ empty: true, synthesizeUnknown: true }).preview
  const api = createCustomerApi({ baseUrl: "https://api.example.test/", getToken: async () => token, preview })
  return { api, fetchMock }
}

afterEach(() => vi.unstubAllGlobals())

describe("customer API client", () => {
  it("sends the Supabase token as a bearer header to /api/v1", async () => {
    const { api, fetchMock } = setup("abc")
    fetchMock.mockResolvedValue(json({ instances: [] }))
    await api.instances.list()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://api.example.test/api/v1/instances")
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer abc")
  })

  it("rejects with 401 and sends nothing when nobody is signed in", async () => {
    const { api, fetchMock } = setup(null)
    await expect(api.instances.list()).rejects.toMatchObject({ status: 401, code: "unauthorized" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("creates an instance with the idempotency key and returns the instance", async () => {
    const { api, fetchMock } = setup()
    const instance = { id: ID, name: "a", status: "PENDING" }
    fetchMock.mockResolvedValue(json({ instance, jobId: null }, 202))
    const out = await api.instances.create({ name: "a", planId: ID }, "key-1")
    expect(out).toEqual(instance)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://api.example.test/api/v1/instances")
    expect(init!.method).toBe("POST")
    expect((init!.headers as Record<string, string>)["idempotency-key"]).toBe("key-1")
    expect(JSON.parse(init!.body as string)).toEqual({ name: "a", planId: ID })
  })

  it("surfaces the backend error code and message", async () => {
    const { api, fetchMock } = setup()
    fetchMock.mockResolvedValue(
      json({ error: { code: "provisioning_not_enabled", message: "Instance creation is not enabled for this account yet" } }, 403)
    )
    const err = await api.instances.create({ name: "a", planId: ID }, "k").catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 403, code: "provisioning_not_enabled" })
  })

  it("reads plans from the API without inventing backups or domain flags", async () => {
    const { api, fetchMock } = setup()
    fetchMock.mockResolvedValue(
      json({ plans: [{ id: ID, slug: "starter", name: "Starter", cpuMillis: 500, memoryMb: 1024, storageMb: 5120, pids: 256, monthlyPriceIdr: null }] })
    )
    const plans = await api.preview.plans()
    expect(plans[0]).toMatchObject({ id: ID, backupRetentionDays: null, customDomain: null, monthlyPriceIdr: null })
  })

  it("maps /me to an account", async () => {
    const { api, fetchMock } = setup()
    fetchMock.mockResolvedValue(json({ id: "u", email: "nash@example.test", tenantId: "t" }))
    expect(await api.preview.me()).toEqual({ name: "nash", email: "nash@example.test" })
  })

  it("points preview metadata at a real plan id", async () => {
    const { api, fetchMock } = setup()
    fetchMock.mockImplementation(async (url) =>
      String(url).endsWith("/plans")
        ? json({ plans: [{ id: ID, slug: "starter", name: "Starter", cpuMillis: 500, memoryMb: 1024, storageMb: 5120, pids: 256, monthlyPriceIdr: null }] })
        : json({})
    )
    const meta = await api.preview.meta("11111111-1111-4111-8111-111111111111")
    expect(meta?.planId).toBe(ID)
  })

  it("pure mappers keep fields", () => {
    expect(toAccount({ id: "u", email: "a@b.c", tenantId: "t" }).name).toBe("a")
    expect(toPlan({ id: ID, slug: "s", name: "S", cpuMillis: 1, memoryMb: 2, storageMb: 3, pids: 4, monthlyPriceIdr: null }).pids).toBe(4)
  })
})
