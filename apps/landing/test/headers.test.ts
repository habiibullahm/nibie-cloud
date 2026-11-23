import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// public/_headers is copied into the static export and applied by Cloudflare to every response.
const file = readFileSync(join(__dirname, "..", "public", "_headers"), "utf8")
const csp = /Content-Security-Policy: (.+)/.exec(file)?.[1] ?? ""
const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? null

describe("landing response headers", () => {
  it("apply to every path", () => {
    expect(file).toMatch(/^\/\*$/m)
  })

  it("let the page call only itself, the public API and Turnstile", () => {
    expect(directive("connect-src")).toBe("connect-src 'self' https://api.cloud.nibie.app https://challenges.cloudflare.com")
  })

  it("load scripts and frames only from the site and Turnstile, without eval or 'unsafe-inline'", () => {
    // The build replaces the placeholder with the hashes of the inline scripts (scripts/csp-hashes.mjs).
    expect(directive("script-src")).toBe("script-src 'self' 'inline-script-hashes' https://challenges.cloudflare.com")
    expect(directive("script-src")).not.toContain("unsafe-inline")
    expect(directive("frame-src")).toBe("frame-src https://challenges.cloudflare.com")
    expect(csp).not.toContain("unsafe-eval")
  })

  it("block framing, plugins, <base> and foreign form targets", () => {
    for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) expect(csp.split("; ")).toContain(d)
    expect(file).toContain("X-Frame-Options: DENY")
    expect(file).toContain("X-Content-Type-Options: nosniff")
  })
})
