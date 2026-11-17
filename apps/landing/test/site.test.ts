import { describe, expect, it } from "vitest"
import { BETA_USERS, PLANS, discountPercent, formatIdr } from "@/lib/plans"
import { ACCESS_REQUEST_BODY, betaAccessHref, betaSlotsUrl, freeBetaOpen, parseBetaSlots, contactEmail, ctaHref, signupOpen, SITE } from "@/lib/site"

describe("formatIdr", () => {
  it("groups thousands with dots", () => {
    expect(formatIdr(25_000)).toBe("Rp 25.000")
    expect(formatIdr(50_000)).toBe("Rp 50.000")
    expect(formatIdr(75_000)).toBe("Rp 75.000")
    expect(formatIdr(1_250_000)).toBe("Rp 1.250.000")
  })
})

describe("plans", () => {
  it("matches the owner's decided prices (2026-11-14)", () => {
    const hosting = PLANS.find((p) => p.id === "hosting")
    const bundle = PLANS.find((p) => p.id === "hosting-kredit")
    expect(hosting).toMatchObject({ normalPriceIdr: 50_000, betaPriceIdr: 25_000, creditUsd: 0 })
    expect(bundle).toMatchObject({ normalPriceIdr: 75_000, betaPriceIdr: 50_000, creditUsd: 2 })
    expect(BETA_USERS).toBe(100)
  })

  it("computes the displayed discount", () => {
    expect(discountPercent(PLANS[0]!)).toBe(50)
    expect(discountPercent(PLANS[1]!)).toBe(33)
  })

  it("never prices a beta plan above its normal price", () => {
    for (const p of PLANS) expect(p.betaPriceIdr).toBeLessThan(p.normalPriceIdr)
  })
})

describe("contact", () => {
  it("accepts a valid address and trims it", () => {
    expect(contactEmail("  hello@example.com ")).toBe("hello@example.com")
  })

  it.each([undefined, "", "   ", "not-an-email", "a@b", "a b@c.de"])("rejects %j", (raw) => {
    expect(contactEmail(raw)).toBeNull()
  })

  it("falls back to Telegram when no email is configured", () => {
    expect(betaAccessHref("Halo", null)).toBe(SITE.telegramUrl)
  })

  it("builds an encoded mailto link when an email is configured", () => {
    expect(betaAccessHref("Minta akses: Hosting + Kredit", "hello@example.com")).toBe(
      `mailto:hello@example.com?subject=Minta%20akses%3A%20Hosting%20%2B%20Kredit&body=${encodeURIComponent(ACCESS_REQUEST_BODY)}`
    )
  })
})

describe("sign-up switch", () => {
  it.each([undefined, "", "true", "1", "yes"])("is open by default and for %j", (raw) => {
    expect(signupOpen(raw)).toBe(true)
  })

  it.each(["false", " FALSE ", "False"])("closes only for %j", (raw) => {
    expect(signupOpen(raw)).toBe(false)
  })

  it("sends the buttons to the dashboard registration when open", () => {
    expect(ctaHref("Halo", true, "hello@example.com")).toBe("/dashboard/register")
    expect(SITE.registerUrl).toBe("/dashboard/register")
  })

  it("keeps the invite request when closed", () => {
    expect(ctaHref("Halo", false, "hello@example.com")).toBe(`mailto:hello@example.com?subject=Halo&body=${encodeURIComponent(ACCESS_REQUEST_BODY)}`)
    expect(ctaHref("Halo", false, null)).toBe(SITE.telegramUrl)
  })
})

describe("free beta mode", () => {
  it("is on only for the exact value true", () => {
    expect(freeBetaOpen("true")).toBe(true)
    expect(freeBetaOpen(" TRUE ")).toBe(true)
    for (const v of [undefined, "", "false", "1", "yes"]) expect(freeBetaOpen(v)).toBe(false)
  })

  it("builds the counter address from the API address, or nothing", () => {
    expect(betaSlotsUrl("https://api.example.test")).toBe("https://api.example.test/api/v1/public/beta-slots")
    expect(betaSlotsUrl("https://api.example.test///")).toBe("https://api.example.test/api/v1/public/beta-slots")
    for (const v of [undefined, "", "api.example.test", "javascript:alert(1)", "https://a b"]) expect(betaSlotsUrl(v)).toBeNull()
  })

  it("accepts only the exact counter shape", () => {
    expect(parseBetaSlots({ total: 10, remaining: 7 })).toEqual({ total: 10, remaining: 7 })
    expect(parseBetaSlots({ total: 10, remaining: 0 })).toEqual({ total: 10, remaining: 0 })
    for (const body of [null, 5, "x", {}, { total: 10 }, { total: "10", remaining: 3 }, { total: 10, remaining: 11 }, { total: 10, remaining: -1 }, { total: 1.5, remaining: 1 }]) {
      expect(parseBetaSlots(body)).toBeNull()
    }
  })
})
