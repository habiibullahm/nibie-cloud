import { describe, expect, it } from "vitest"
import { BETA_USERS, PLANS, discountPercent, formatIdr } from "@/lib/plans"
import { betaAccessHref, contactEmail, ctaHref, signupOpen, SITE } from "@/lib/site"

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
      "mailto:hello@example.com?subject=Minta%20akses%3A%20Hosting%20%2B%20Kredit"
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
    expect(ctaHref("Halo", false, "hello@example.com")).toBe("mailto:hello@example.com?subject=Halo")
    expect(ctaHref("Halo", false, null)).toBe(SITE.telegramUrl)
  })
})
