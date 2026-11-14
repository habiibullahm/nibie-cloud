import { describe, expect, it } from "vitest"
import { destinationFor, parseConfirmParams } from "@/lib/auth/confirm"
import { validateNewPassword } from "@/lib/auth/password"

const q = (s: string) => new URLSearchParams(s)

describe("parseConfirmParams", () => {
  it("accepts a token hash with a known type", () => {
    expect(parseConfirmParams(q("token_hash=abc&type=invite"))).toEqual({ tokenHash: "abc", type: "invite" })
  })
  it.each(["", "token_hash=&type=invite", "token_hash=abc", "token_hash=abc&type=admin", "type=invite"])(
    "rejects %j",
    (s) => expect(parseConfirmParams(q(s))).toBeNull()
  )
})

describe("destinationFor", () => {
  it("sends invited and recovering users to set a password", () => {
    expect(destinationFor("invite")).toBe("/set-password")
    expect(destinationFor("recovery")).toBe("/set-password")
  })
  it("sends confirmed sign-ups to deploy and everything else to the instance list", () => {
    expect(destinationFor("signup")).toBe("/deploy")
    expect(destinationFor("magiclink")).toBe("/instances")
    expect(destinationFor("email_change")).toBe("/instances")
  })
})

describe("validateNewPassword", () => {
  it("requires 8 characters and a matching pair", () => {
    expect(validateNewPassword("short", "short")).toMatch(/at least 8/)
    expect(validateNewPassword("longenough", "different1")).toMatch(/do not match/)
    expect(validateNewPassword("longenough", "longenough")).toBeNull()
  })
})
