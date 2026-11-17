import { describe, expect, it } from "vitest"
import {
  authErrorMessage,
  codeLength,
  isCompleteCode,
  isEmailNotConfirmed,
  isFreshUser,
  normalizeCode,
  oauthRedirectUrl,
} from "../src/lib/auth/signup"

describe("email code", () => {
  it("uses the project's length, 6 unless a valid override (6 to 10) is set", () => {
    expect(codeLength(undefined)).toBe(6)
    expect(codeLength("8")).toBe(8)
    expect(codeLength("10")).toBe(10)
    expect(codeLength("5")).toBe(6)
    expect(codeLength("11")).toBe(6)
    expect(codeLength("abc")).toBe(6)
  })
  it("keeps only digits, never more than the code length", () => {
    expect(normalizeCode(" 1234 5678 ", 8)).toBe("12345678")
    expect(normalizeCode("1233223123", 8)).toBe("12332231")
    expect(normalizeCode("123-456-789", 6)).toBe("123456")
    expect(normalizeCode("abc", 8)).toBe("")
  })
  it("is complete at exactly the code length", () => {
    expect(isCompleteCode("12345678", 8)).toBe(true)
    expect(isCompleteCode("1234567", 8)).toBe(false)
    expect(isCompleteCode("1234567890", 8)).toBe(false)
    expect(isCompleteCode("1234567a", 8)).toBe(false)
    expect(isCompleteCode("123456", 6)).toBe(true)
  })
})

describe("authErrorMessage", () => {
  it.each([
    [{ code: "user_already_exists" }, "sign-up", /already exists/],
    [{ code: "weak_password" }, "sign-up", /stronger password/],
    [{ code: "invalid_credentials" }, "sign-in", /not correct/],
    [{ code: "otp_expired" }, "verify", /wrong or has expired/],
    [{ code: "captcha_failed" }, "sign-in", /security check/],
    [{ code: "over_email_send_rate_limit" }, "resend", /Too many attempts/],
    [{ code: "anything", status: 429 }, "sign-up", /Too many attempts/],
    [{ code: "provider_disabled" }, "google", /Google sign-in is not available/],
  ] as const)("maps %j for %s", (err, step, expected) => {
    expect(authErrorMessage(err, step)).toMatch(expected)
  })

  it("falls back to a text per step for unknown codes, never echoing Supabase", () => {
    expect(authErrorMessage({ code: "some_new_code" }, "verify")).toMatch(/code is not correct/)
    expect(authErrorMessage(null, "sign-up")).toMatch(/Could not create the account/)
  })

  it("recognises an unconfirmed email", () => {
    expect(isEmailNotConfirmed({ code: "email_not_confirmed" })).toBe(true)
    expect(isEmailNotConfirmed({ code: "invalid_credentials" })).toBe(false)
    expect(isEmailNotConfirmed(null)).toBe(false)
  })
})

describe("Google return", () => {
  it("builds the callback on the dashboard's own origin and base path", () => {
    expect(oauthRedirectUrl("http://localhost:3500", "/dashboard")).toBe("http://localhost:3500/dashboard/auth/callback")
    expect(oauthRedirectUrl("https://cloud.nibie.app/", "/dashboard/")).toBe("https://cloud.nibie.app/dashboard/auth/callback")
  })
  it("treats a user created in the last two minutes as new", () => {
    const now = new Date("2026-11-17T10:00:00Z")
    expect(isFreshUser("2026-11-17T09:59:30Z", now)).toBe(true)
    expect(isFreshUser("2026-11-17T09:50:00Z", now)).toBe(false)
    expect(isFreshUser(undefined, now)).toBe(false)
  })
})
