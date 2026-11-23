// Post-build step: replaces the inline-script placeholder in out/_headers with the SHA-256 hashes of every inline
// <script> in the static export, so the Content-Security-Policy needs no 'unsafe-inline' for scripts. A static export
// has no request, so a nonce is impossible; hashes are fixed at build time like the pages themselves.
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export const PLACEHOLDER = "'inline-script-hashes'"
/** Cloudflare ignores a `_headers` line longer than this. */
export const MAX_LINE = 2000

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
// Hashes cover <script> elements only: an inline handler or a javascript: URL would need 'unsafe-hashes' or 'unsafe-inline'.
const INLINE_HANDLER = /<[^>]+\son[a-z]+\s*=/i
const JS_URL = /\s(?:href|src|action|formaction)\s*=\s*["']?\s*javascript:/i

/**
 * The CSP hash sources of the inline scripts in one HTML page, in order of appearance. Throws on markup that a hash
 * cannot allow, so the build fails instead of shipping a page the policy breaks.
 * @param {string} html
 * @param {string} [name]
 * @returns {string[]}
 */
export function inlineScriptHashes(html, name = "page") {
  if (INLINE_HANDLER.test(html)) throw new Error(`${name}: inline event handler found; move it into a script file`)
  if (JS_URL.test(html)) throw new Error(`${name}: javascript: URL found`)
  const out = []
  for (const m of html.matchAll(SCRIPT)) {
    if (/\ssrc\s*=/i.test(` ${m[1]}`)) continue
    out.push(`'sha256-${createHash("sha256").update(m[2], "utf8").digest("base64")}'`)
  }
  return out
}

/**
 * The `_headers` text with the placeholder replaced by the hash sources (sorted, without duplicates).
 * @param {string} headers
 * @param {string[]} hashes
 * @returns {string}
 */
export function applyHashes(headers, hashes) {
  if (!headers.includes(PLACEHOLDER)) throw new Error(`_headers has no ${PLACEHOLDER} placeholder in script-src`)
  const sources = [...new Set(hashes)].sort().join(" ")
  // No inline scripts at all: the placeholder simply goes away.
  const out = headers.replaceAll(sources ? PLACEHOLDER : ` ${PLACEHOLDER}`, sources)
  for (const line of out.split("\n")) {
    if (line.length > MAX_LINE) throw new Error(`_headers line is ${line.length} characters; Cloudflare ignores lines over ${MAX_LINE}`)
  }
  return out
}

/** @param {string} dir @returns {string[]} */
function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? htmlFiles(join(dir, e.name)) : e.name.endsWith(".html") ? [join(dir, e.name)] : [],
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outDir = process.argv[2] ?? "out"
  const files = htmlFiles(outDir)
  if (files.length === 0) throw new Error(`no HTML pages in ${outDir}; run next build first`)
  const hashes = files.flatMap((f) => inlineScriptHashes(readFileSync(f, "utf8"), f))
  const path = join(outDir, "_headers")
  writeFileSync(path, applyHashes(readFileSync(path, "utf8"), hashes))
  console.log(`CSP: ${new Set(hashes).size} inline script hashes from ${files.length} pages written to ${path}`)
}
