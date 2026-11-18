import { describe, expect, it } from "vitest"
import { isCompleteTotp, normalizeTotp, sortFactors, totpQrSrc } from "../src/lib/admin-mfa-rules"

describe("authenticator code", () => {
  it("keeps digits only, at most six", () => {
    expect(normalizeTotp("12 34-56")).toBe("123456")
    expect(normalizeTotp("1234567")).toBe("123456")
    expect(normalizeTotp("abc")).toBe("")
  })

  it("is complete at exactly six digits", () => {
    expect(isCompleteTotp("123456")).toBe(true)
    expect(isCompleteTotp("12345")).toBe(false)
    expect(isCompleteTotp("12345a")).toBe(false)
  })
})

describe("QR code source", () => {
  it("keeps an image data URL as it is", () => {
    expect(totpQrSrc("data:image/svg+xml;utf-8,<svg/>")).toBe("data:image/svg+xml;utf-8,<svg/>")
    expect(totpQrSrc("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA")
  })

  it("turns raw SVG markup into an encoded data URL", () => {
    const src = totpQrSrc('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect fill="#000"/></svg>')
    expect(src).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)
    expect(src).toContain("%23000")
  })

  it("refuses anything else, so the screen falls back to the manual key", () => {
    expect(totpQrSrc("javascript:alert(1)")).toBeNull()
    expect(totpQrSrc("data:text/html,<script>")).toBeNull()
    expect(totpQrSrc("")).toBeNull()
    expect(totpQrSrc(undefined)).toBeNull()
  })
})

describe("factors", () => {
  it("challenges the verified TOTP factor and clears unfinished TOTP enrolments only", () => {
    const r = sortFactors([
      { id: "a", factor_type: "totp", status: "unverified" },
      { id: "b", factor_type: "totp", status: "verified" },
      { id: "c", factor_type: "phone", status: "unverified" },
    ])
    expect(r.verified?.id).toBe("b")
    expect(r.unfinished.map((f) => f.id)).toEqual(["a"])
  })

  it("has nothing to challenge when no TOTP factor is verified", () => {
    expect(sortFactors([]).verified).toBeNull()
  })
})
