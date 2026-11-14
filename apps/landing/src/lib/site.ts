/** Public facts about the site. Nothing secret: the repository is public. */

export const SITE = {
  /** Product name (Nash, 2026-11-14: the product stays "Hermes Cloud", published by Nibie). */
  name: "Hermes Cloud",
  operator: "nibie.app",
  url: "https://cloud.nibie.app",
  dashboardUrl: "/dashboard",
  signInUrl: "/dashboard/sign-in",
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

/** Where "Minta akses beta" goes: a pre-filled email when configured, otherwise Telegram. */
export function betaAccessHref(subject: string, email: string | null = contactEmail()): string {
  if (!email) return SITE.telegramUrl
  return `mailto:${email}?subject=${encodeURIComponent(subject)}`
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
