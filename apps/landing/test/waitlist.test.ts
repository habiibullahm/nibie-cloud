import { describe, expect, it, vi } from "vitest"
import { submitWaitlist, validateWaitlist, waitlistUrl } from "@/lib/waitlist"

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
    [400, "invalid"],
    [429, "rate_limited"],
    [503, "full"],
    [500, "unavailable"],
  ])("explains status %i", async (status, kind) => {
    const r = await submitWaitlist("https://api.test/p", ok, post(status))
    expect(r).toMatchObject({ ok: false, kind })
    expect((r as { message: string }).message.length).toBeGreaterThan(10)
  })

  it("treats a network failure as unavailable", async () => {
    const f = vi.fn(async () => { throw new TypeError("offline") }) as unknown as typeof fetch
    expect(await submitWaitlist("https://api.test/p", ok, f)).toMatchObject({ ok: false, kind: "unavailable" })
  })
})
