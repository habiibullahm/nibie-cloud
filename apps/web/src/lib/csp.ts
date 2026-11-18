/**
 * Content-Security-Policy for the dashboard, built from the public build variables. Next.js's "without nonces" policy:
 * the pages are prerendered, so a per-request nonce is not possible and inline scripts stay allowed. What it still
 * does: scripts only from this origin and Cloudflare Turnstile, network calls only to this origin, the backend API,
 * Supabase and Turnstile (so a stolen session token has nowhere to be sent), no framing, no plugins, no <base> or
 * form hijacking.
 */

const TURNSTILE = "https://challenges.cloudflare.com"

/** The origin of an http(s) URL, or null for anything else (a malformed variable must not widen the policy). */
export function originOf(raw: string | undefined): string | null {
  if (!raw?.trim()) return null
  try {
    const u = new URL(raw.trim())
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null
  } catch {
    return null
  }
}

export function dashboardCsp(o: { apiUrl?: string; supabaseUrl?: string; dev: boolean }): string {
  const connect = ["'self'", originOf(o.apiUrl), originOf(o.supabaseUrl), TURNSTILE].filter((v): v is string => v !== null)
  const directives = [
    "default-src 'self'",
    // React needs eval only in development (error stacks); production never uses it.
    `script-src 'self' 'unsafe-inline' ${TURNSTILE}${o.dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    // data: for the authenticator QR code (admin MFA); blob: for generated images.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${[...new Set(connect)].join(" ")}`,
    `frame-src ${TURNSTILE}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Not in development: it would upgrade calls to a local http backend and break them.
    ...(o.dev ? [] : ["upgrade-insecure-requests"]),
  ]
  return directives.join("; ")
}
