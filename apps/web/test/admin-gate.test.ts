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

  it("shows the panel for an admin, at aal1 as well (reads need no second factor)", () => {
    expect(decideAdminGate({ mode: "customer", pending: false, error: false, admin: { email: "boss@nibie.app", aal: "aal1" } })).toBe("panel")
    expect(decideAdminGate({ mode: "customer", pending: false, error: false, admin: ADMIN })).toBe("panel")
  })

  it("treats a backend outage as loading, never as unauthorized", () => {
    // The distinction matters: 'unauthorized' would tell an admin to stop trying.
    const outage = decideAdminGate({ mode: "customer", pending: false, error: true, admin: ADMIN })
    expect(outage).not.toBe("unauthorized")
  })
})
