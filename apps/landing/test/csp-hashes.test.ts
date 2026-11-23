import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { applyHashes, inlineScriptHashes, MAX_LINE, PLACEHOLDER } from "../scripts/csp-hashes.mjs"

const sha = (s: string) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`
const headers = `/*\n  Content-Security-Policy: default-src 'self'; script-src 'self' ${PLACEHOLDER} https://challenges.cloudflare.com; object-src 'none'\n`

describe("inline script hashes for the CSP", () => {
  it("hashes inline scripts exactly as written and skips external ones", () => {
    const html = `<head><script src="/_next/a.js" async></script><script id="_R_">self.__next_f=[]</script></head><body><script>\n  x()\n</script></body>`
    expect(inlineScriptHashes(html)).toEqual([sha("self.__next_f=[]"), sha("\n  x()\n")])
  })

  it("refuses markup a hash cannot allow", () => {
    expect(() => inlineScriptHashes(`<button onclick="go()">x</button>`, "a.html")).toThrow(/a\.html: inline event handler/)
    expect(() => inlineScriptHashes(`<a href="javascript:go()">x</a>`)).toThrow(/javascript: URL/)
  })

  it("replaces the placeholder with sorted, unique hashes and keeps the rest of the policy", () => {
    const out = applyHashes(headers, ["'sha256-b'", "'sha256-a'", "'sha256-b'"])
    expect(out).toContain("script-src 'self' 'sha256-a' 'sha256-b' https://challenges.cloudflare.com;")
    expect(out).not.toContain(PLACEHOLDER)
    expect(out).not.toContain("unsafe-inline")
  })

  it("drops the placeholder when there is no inline script", () => {
    expect(applyHashes(headers, [])).toContain("script-src 'self' https://challenges.cloudflare.com;")
  })

  it("fails without the placeholder or when the header line would be too long for Cloudflare", () => {
    expect(() => applyHashes("/*\n  X-Frame-Options: DENY\n", [])).toThrow(/placeholder/)
    const many = Array.from({ length: MAX_LINE / 20 }, (_, i) => sha(String(i)))
    expect(() => applyHashes(headers, many)).toThrow(/Cloudflare ignores/)
  })
})
