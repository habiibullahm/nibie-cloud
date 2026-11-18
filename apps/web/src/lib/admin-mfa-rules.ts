/**
 * Pure helpers for the admin second-factor screen (TOTP through Supabase Auth MFA). Kept apart from the component so
 * they can be tested without a DOM.
 */

export const TOTP_DIGITS = 6

/** Digits only, at most six: what an authenticator app shows. */
export function normalizeTotp(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, TOTP_DIGITS)
}

export function isCompleteTotp(code: string): boolean {
  return new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(code)
}

/**
 * An `<img>` source for the QR code Supabase returns from `mfa.enroll`. Depending on the version it is either raw SVG
 * markup or already a data URL. Raw SVG is URL-encoded into a data URL (an SVG inside `<img>` cannot run scripts);
 * anything that is neither an image data URL nor SVG markup is refused, and the screen falls back to the manual key.
 */
export function totpQrSrc(qr: string | null | undefined): string | null {
  const v = (qr ?? "").trim()
  if (/^data:image\/(svg\+xml|png)[;,]/i.test(v)) return v
  if (/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(v)) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(v)}`
  return null
}

interface FactorLike {
  id: string
  factor_type: string
  status: string
}

/** The factor to challenge (a verified TOTP), and the unfinished TOTP enrolments to clear before a fresh one. */
export function sortFactors(all: readonly FactorLike[]): { verified: FactorLike | null; unfinished: FactorLike[] } {
  const totp = all.filter((f) => f.factor_type === "totp")
  return {
    verified: totp.find((f) => f.status === "verified") ?? null,
    unfinished: totp.filter((f) => f.status !== "verified"),
  }
}
