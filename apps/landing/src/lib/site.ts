/** Public facts about the site. Nothing secret: the repository is public. */

/**
 * Where the dashboard lives. Production serves it on the same origin (`/dashboard`), so the default stays relative. The
 * build variable NEXT_PUBLIC_DASHBOARD_URL points it elsewhere for local development, e.g. `http://localhost:3500/dashboard`,
 * because the landing page then runs on another port. Anything that is not an http(s) URL is ignored.
 */
export function dashboardBase(raw: string | undefined = process.env.NEXT_PUBLIC_DASHBOARD_URL): string {
  const v = raw?.trim().replace(/\/+$/, "") ?? ""
  return /^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(v) ? v : "/dashboard"
}

const DASHBOARD = dashboardBase()

export const SITE = {
  /** Product name (Nash, 2026-11-15: renamed from "Hermes Cloud" to "Nibie Cloud"; Hermes is the agent the product hosts). */
  name: "Nibie Cloud",
  operator: "nibie.app",
  url: "https://cloud.nibie.app",
  dashboardUrl: DASHBOARD,
  signInUrl: `${DASHBOARD}/sign-in`,
  registerUrl: `${DASHBOARD}/register`,
  docsUrl: "/docs",
  telegramHandle: "@abib_mohd",
  telegramUrl: "https://t.me/abib_mohd",
  /** Date shown on the legal pages. Update it whenever their text changes. */
  legalUpdated: "14 November 2026",
} as const

/**
 * Public contact address. It comes from the build variable NEXT_PUBLIC_CONTACT_EMAIL (set in Cloudflare
 * Workers Builds) so the address never sits in the public repository. Empty or malformed means
 * "not configured" and the site falls back to Telegram.
 */
export function contactEmail(raw: string | undefined = process.env.NEXT_PUBLIC_CONTACT_EMAIL): string | null {
  const value = raw?.trim() ?? ""
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null
}

/**
 * Self-service sign-up switch. Open by default (owner decision 2026-11-15): the "Daftar" and "Pilih" buttons
 * link to the dashboard registration. The build variable NEXT_PUBLIC_SIGNUP_OPEN=false closes it again and
 * brings back the invite request (email or Telegram). Changing it needs a rebuild.
 */
export function signupOpen(raw: string | undefined = process.env.NEXT_PUBLIC_SIGNUP_OPEN): boolean {
  return raw?.trim().toLowerCase() !== "false"
}

/**
 * Free beta preview mode: the main buttons send visitors to the dashboard registration and a counter shows how many free
 * slots are left. Build variable NEXT_PUBLIC_FREE_BETA_OPEN=true; needs NEXT_PUBLIC_API_URL for the counter.
 */
export function freeBetaOpen(raw: string | undefined = process.env.NEXT_PUBLIC_FREE_BETA_OPEN): boolean {
  return raw?.trim().toLowerCase() === "true"
}

/** Public counter endpoint, or null when the API address is not configured (the page then shows no number). */
export function betaSlotsUrl(raw: string | undefined = process.env.NEXT_PUBLIC_API_URL): string | null {
  const base = raw?.trim().replace(/\/+$/, "") ?? ""
  return /^https?:\/\/[^\s]+$/.test(base) ? `${base}/api/v1/public/beta-slots` : null
}

export interface BetaSlots {
  total: number
  remaining: number
}

/** Accepts only the exact shape the API sends; anything else is "unknown". */
export function parseBetaSlots(body: unknown): BetaSlots | null {
  if (typeof body !== "object" || body === null) return null
  const { total, remaining } = body as Record<string, unknown>
  if (typeof total !== "number" || typeof remaining !== "number") return null
  if (!Number.isInteger(total) || !Number.isInteger(remaining) || total < 0 || remaining < 0 || remaining > total) return null
  return { total, remaining }
}

/** Pre-filled email body for an access request, so the owner gets what is needed to pick the free beta users. */
export const ACCESS_REQUEST_BODY = [
  "Halo Nibie Cloud, saya mau ikut beta preview gratis.",
  "",
  "Nama:",
  "Email yang mau didaftarkan:",
  "Akun Telegram (opsional):",
  "Agent Hermes mau dipakai untuk apa:",
].join("\n")

/** Where "Minta akses beta" goes: a pre-filled email when configured, otherwise Telegram. */
export function betaAccessHref(subject: string, email: string | null = contactEmail()): string {
  if (!email) return SITE.telegramUrl
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(ACCESS_REQUEST_BODY)}`
}

/**
 * Target of the main call-to-action buttons: the dashboard registration when sign-up is open, the invite
 * request (email or Telegram) otherwise.
 */
export function ctaHref(
  subject: string,
  open: boolean = signupOpen(),
  email: string | null = contactEmail()
): string {
  return open ? SITE.registerUrl : betaAccessHref(subject, email)
}

export const NAV_LINKS = [
  { href: "/#fitur", label: "Fitur" },
  { href: "/#cara-kerja", label: "Cara kerja" },
  { href: "/harga", label: "Harga" },
  { href: "/#faq", label: "FAQ" },
] as const

export const LEGAL_LINKS = [
  { href: "/syarat-layanan", label: "Syarat Layanan" },
  { href: "/kebijakan-refund", label: "Kebijakan Refund" },
  { href: "/kebijakan-privasi", label: "Kebijakan Privasi" },
] as const
