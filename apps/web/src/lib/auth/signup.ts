/** Pure helpers for the sign-up and sign-in screens (email code, Google return, error texts). No Supabase import, so they are testable. */

/** Must match Supabase's "Email OTP length" setting. */
export const DEFAULT_CODE_LENGTH = 6
/** Seconds before "Send a new code" may be pressed again; Supabase also rate-limits resends on its side. */
export const RESEND_COOLDOWN_S = 60

/**
 * Digits in the email code: exactly what Supabase sends, so a wrong length is caught on the screen, not by the server.
 * NEXT_PUBLIC_EMAIL_CODE_LENGTH must follow Supabase's "Email OTP length" (6 to 10) if that setting changes.
 */
export function codeLength(raw: string | undefined = process.env.NEXT_PUBLIC_EMAIL_CODE_LENGTH): number {
  const n = Number(raw)
  return raw && Number.isInteger(n) && n >= 6 && n <= 10 ? n : DEFAULT_CODE_LENGTH
}

/** Keeps the digits a person typed or pasted ("1234 5678", "1234-5678"), at most `length` of them. */
export function normalizeCode(raw: string, length: number = codeLength()): string {
  return raw.replace(/\D/g, "").slice(0, length)
}

export function isCompleteCode(code: string, length: number = codeLength()): boolean {
  return code.length === length && /^\d+$/.test(code)
}

/** What a Supabase auth error looks like to us; only the machine code and HTTP status are used, never the text. */
export interface AuthErrorLike {
  code?: string | null
  status?: number | null
}

export type AuthStep = "sign-up" | "sign-in" | "verify" | "resend" | "google"

/** True when the account exists but its email was never confirmed: the screen should ask for the code. */
export function isEmailNotConfirmed(err: AuthErrorLike | null | undefined): boolean {
  return err?.code === "email_not_confirmed"
}

/** A message a person can act on. Unknown codes fall back to a text per step instead of showing Supabase's wording. */
export function authErrorMessage(err: AuthErrorLike | null | undefined, step: AuthStep): string {
  const code = err?.code ?? ""
  if (err?.status === 429 || code.startsWith("over_")) return "Too many attempts. Wait a minute and try again."
  switch (code) {
    case "user_already_exists":
    case "email_exists":
      return "An account with this email already exists. Sign in instead."
    case "weak_password":
      return "Choose a stronger password: longer, mixing letters and numbers."
    case "email_address_invalid":
    case "validation_failed":
      return "Enter a valid email address."
    case "invalid_credentials":
      return "Email or password is not correct."
    case "otp_expired":
      // Supabase answers a wrong code and an expired one with the same code, so the text must cover both.
      return "That code is wrong or has expired. Check the newest email, or send a new code."
    case "captcha_failed":
      return "The security check did not pass. Complete it again and retry."
    case "signup_disabled":
    case "email_provider_disabled":
      return "Sign-up with email is closed right now."
    case "provider_disabled":
      return "Google sign-in is not available right now. Use email instead."
  }
  switch (step) {
    case "sign-up":
      return "Could not create the account. Check the details and try again."
    case "sign-in":
      return "Email or password is not correct."
    case "verify":
      return "That code is not correct. Check the latest email and try again."
    case "resend":
      return "Could not send a new code. Try again in a minute."
    case "google":
      return "Google sign-in did not finish. Try again."
  }
}

/** Where Google sends the person back: this app's callback page, on whatever origin the dashboard runs. */
export function oauthRedirectUrl(origin: string, basePath: string): string {
  return `${origin.replace(/\/+$/, "")}${basePath.replace(/\/+$/, "")}/auth/callback`
}

/** A user created in the last two minutes has just signed up through Google: send them to create an agent. */
export function isFreshUser(createdAt: string | undefined, now: Date = new Date()): boolean {
  const t = createdAt ? Date.parse(createdAt) : NaN
  return Number.isFinite(t) && now.getTime() - t < 2 * 60_000
}
