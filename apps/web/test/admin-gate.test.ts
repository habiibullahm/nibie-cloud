import { describe, expect, it } from "vitest"
import { decideAdminGate } from "../src/lib/admin-gate-rules"

const ADMIN = { email: "boss@nibie.app", aal: "aal2" as const }

describe("admin gate decisions", () => {
  it("asks for a backend in mock and live modes, even for an admin", () => {
    expect(decideAdminGate({ mode: "mock", pending: false, error: false, admin: ADMIN })).toBe("needs-backend")
    expect(decideAdminGate({ mode: "live", pending: false, error: false, admin: ADMIN })).toBe("needs-backend")
  })

  it("shows a loading state until /admin/me answers, and on an outage", () => {
    expect(decideAdminGate({ mode: "customer", pending: true, error: false, admin: null })).toBe("loading")
    expect(decideAdminGate({ mode: "customer", pending: false, error: true, admin: null })).toBe("loading")
  })

  it("shows 'unauthorized' for a signed-in non-admin", () => {
    expect(decideAdminGate({ mode: "customer", pending: false, error: false, admin: null })).toBe("unauthorized")
  })

  it("shows the panel once /admin/me answers (the backend only does so at aal2)", () => {
    expect(decideAdminGate({ mode: "customer", pending: false, error: false, admin: ADMIN })).toBe("panel")
  })

  it("asks for the second factor when the backend says mfa_required, never 'unauthorized'", () => {
    expect(decideAdminGate({ mode: "customer", pending: false, error: false, admin: null, mfaRequired: true })).toBe("mfa")
    // Still loading or an outage wins: the MFA screen appears only on a real answer.
    expect(decideAdminGate({ mode: "customer", pending: true, error: false, admin: null, mfaRequired: true })).toBe("loading")
    expect(decideAdminGate({ mode: "mock", pending: false, error: false, admin: null, mfaRequired: true })).toBe("needs-backend")
  })

  it("treats a backend outage as loading, never as unauthorized", () => {
    // The distinction matters: 'unauthorized' would tell an admin to stop trying.
    const outage = decideAdminGate({ mode: "customer", pending: false, error: true, admin: ADMIN })
    expect(outage).not.toBe("unauthorized")
  })
})
