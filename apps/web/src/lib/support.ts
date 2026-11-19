/**
 * Support channels, the same ones the landing page publishes (apps/landing/src/lib/site.ts). The docs and the contact
 * page live on the same origin as the dashboard in production (`/docs`, `/kontak`), so plain root paths are enough.
 * shortcut: in local development those paths hit the dashboard's own port and 404; add a site-URL variable if that matters.
 */
export const SUPPORT = {
  telegramHandle: "@abib_mohd",
  telegramUrl: "https://t.me/abib_mohd",
  docsUrl: "/docs",
  contactUrl: "/kontak",
} as const

/** NEXT_PUBLIC_CONTACT_EMAIL, or null when empty or malformed (the page then offers Telegram only). */
export function supportEmail(raw: string | undefined = process.env.NEXT_PUBLIC_CONTACT_EMAIL): string | null {
  const v = raw?.trim() ?? ""
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null
}
