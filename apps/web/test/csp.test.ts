import { describe, expect, it } from "vitest"
import { dashboardCsp, originOf } from "../src/lib/csp"

const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? null

describe("dashboard CSP", () => {
  const prod = dashboardCsp({ apiUrl: "https://api.cloud.nibie.app/", supabaseUrl: "https://abc.supabase.co", dev: false })

  it("lets the page call only itself, the API, Supabase and Turnstile", () => {
    expect(directive(prod, "connect-src")).toBe("connect-src 'self' https://api.cloud.nibie.app https://abc.supabase.co https://challenges.cloudflare.com")
  })

  it("loads scripts and frames only from itself and Turnstile, with no eval in production", () => {
    expect(directive(prod, "script-src")).toBe("script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com")
    expect(directive(prod, "frame-src")).toBe("frame-src https://challenges.cloudflare.com")
  })

  it("blocks framing, plugins, <base> and foreign form targets, and upgrades http in production", () => {
    for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "upgrade-insecure-requests"]) {
      expect(prod.split("; ")).toContain(d)
    }
  })

  it("allows eval and plain http only in development", () => {
    const dev = dashboardCsp({ apiUrl: "http://127.0.0.1:3000", dev: true })
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'")
    expect(dev).not.toContain("upgrade-insecure-requests")
    expect(directive(dev, "connect-src")).toContain("http://127.0.0.1:3000")
  })

  it("never widens the policy for a missing or malformed variable", () => {
    const none = dashboardCsp({ apiUrl: "", supabaseUrl: "javascript:alert(1)", dev: false })
    expect(directive(none, "connect-src")).toBe("connect-src 'self' https://challenges.cloudflare.com")
    expect(none).not.toContain("*")
  })
})

describe("originOf", () => {
  it("keeps only the origin of an http(s) URL", () => {
    expect(originOf("https://api.example.test/api/v1/")).toBe("https://api.example.test")
    expect(originOf("ftp://x.test")).toBeNull()
    expect(originOf("not a url")).toBeNull()
    expect(originOf(undefined)).toBeNull()
  })
})
