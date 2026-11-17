import { describe, expect, it, vi } from "vitest"
import { readConfirmToken, submitConfirm, submitWaitlist, validateWaitlist, waitlistConfirmUrl, waitlistUrl } from "@/lib/waitlist"

const ok = { name: "Siti", email: "siti@example.com", useCase: "Asisten pribadi di Telegram" }

describe("waitlistUrl", () => {
  it("builds the public endpoint from the API address", () => {
    expect(waitlistUrl("https://api.cloud.nibie.app/")).toBe("https://api.cloud.nibie.app/api/v1/public/waitlist")
  })
  it.each([undefined, "", "   ", "not a url", "ftp://x"])("is null for %j", (raw) => {
    expect(waitlistUrl(raw)).toBeNull()
  })
})

describe("validateWaitlist", () => {
  it("accepts a good form and trims", () => {
    expect(validateWaitlist({ name: " Siti ", email: " siti@example.com ", useCase: "  bot  " })).toBeNull()
    expect(validateWaitlist(ok)).toBeNull()
  })
  it.each([
    [{ ...ok, name: "  " }, "name"],
    [{ ...ok, name: "a\nb" }, "name"],
    [{ ...ok, name: "x".repeat(101) }, "name"],
    [{ ...ok, email: "siti" }, "email"],
    [{ ...ok, email: "a b@c.de" }, "email"],
    [{ ...ok, useCase: "ab" }, "useCase"],
    [{ ...ok, useCase: "x".repeat(501) }, "useCase"],
  ])("names the field for %j", (input, field) => {
    expect(validateWaitlist(input)?.field).toBe(field)
  })
  it("accepts a use case of exactly 500 characters", () => {
    expect(validateWaitlist({ ...ok, useCase: "x".repeat(500) })).toBeNull()
  })
})

describe("submitWaitlist", () => {
  const post = (status: number) => vi.fn(async () => new Response("{}", { status })) as unknown as typeof fetch

  it("posts JSON with an empty honeypot", async () => {
    const f = post(200)
    expect(await submitWaitlist("https://api.test/p", ok, f)).toEqual({ ok: true })
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.test/p")
    expect(init.method).toBe("POST")
    expect(JSON.parse(String(init.body))).toEqual({ ...ok, website: "" })
  })

  it.each([
    [400, "{}", "invalid"],
    [429, "{}", "rate_limited"],
    [503, JSON.stringify({ error: { code: "waitlist_full" } }), "full"],
    [503, JSON.stringify({ error: { code: "waitlist_unavailable" } }), "unavailable"],
    [503, "not json", "unavailable"],
    [500, "{}", "unavailable"],
  ])("explains status %i with body %s", async (status, body, kind) => {
    const f = vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch
    const r = await submitWaitlist("https://api.test/p", ok, f)
    expect(r).toMatchObject({ ok: false, kind })
    expect((r as { message: string }).message.length).toBeGreaterThan(10)
  })

  it("treats a network failure as unavailable", async () => {
    const f = vi.fn(async () => { throw new TypeError("offline") }) as unknown as typeof fetch
    expect(await submitWaitlist("https://api.test/p", ok, f)).toMatchObject({ ok: false, kind: "unavailable" })
  })
})

describe("confirmation link", () => {
  const token = "A".repeat(21) + "_-" + "b".repeat(20)

  it("builds the confirm endpoint from the API address", () => {
    expect(waitlistConfirmUrl("https://api.cloud.nibie.app/")).toBe("https://api.cloud.nibie.app/api/v1/public/waitlist/confirm")
    expect(waitlistConfirmUrl("")).toBeNull()
  })

  it("reads the token only from an exact #t= fragment", () => {
    expect(token).toHaveLength(43)
    expect(readConfirmToken(`#t=${token}`)).toBe(token)
    expect(readConfirmToken(`t=${token}`)).toBe(token)
    expect(readConfirmToken("")).toBeNull()
    expect(readConfirmToken("#t=short")).toBeNull()
    expect(readConfirmToken(`#t=${token}x`)).toBeNull()
    expect(readConfirmToken(`#x=${token}`)).toBeNull()
  })

  it("posts the token and maps the answers", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch
    expect(await submitConfirm("https://api.test/c", token, f)).toEqual({ ok: true })
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ token })
    for (const [status, kind] of [[400, "invalid"], [429, "rate_limited"], [500, "unavailable"]] as const) {
      const g = vi.fn(async () => new Response("{}", { status })) as unknown as typeof fetch
      expect(await submitConfirm("https://api.test/c", token, g)).toMatchObject({ ok: false, kind })
    }
    const offline = vi.fn(async () => { throw new TypeError("offline") }) as unknown as typeof fetch
    expect(await submitConfirm("https://api.test/c", token, offline)).toMatchObject({ ok: false, kind: "unavailable" })
  })
})
