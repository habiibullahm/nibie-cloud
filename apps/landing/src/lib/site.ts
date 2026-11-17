/** Public facts about the site. Nothing secret: the repository is public. */

export const SITE = {
  /** Product name (Nash, 2026-11-15: renamed from "Hermes Cloud" to "Nibie Cloud"; Hermes is the agent the product hosts). */
  name: "Nibie Cloud",
  operator: "nibie.app",
  url: "https://cloud.nibie.app",
  dashboardUrl: "/dashboard",
  signInUrl: "/dashboard/sign-in",
  registerUrl: "/dashboard/register",
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
