import { ApiError, apiMode } from "./api"

/**
 * Links next to the support contacts. The docs and the contact page live on the same origin as the dashboard in
 * production (`/docs`, `/kontak`), so plain root paths are enough.
 * shortcut: in local development those paths hit the dashboard's own port and 404; add a site-URL variable if that matters.
 */
export const SUPPORT = {
  docsUrl: "/docs",
  contactUrl: "/kontak",
} as const

/** Set by an admin on the Pengaturan page; served by `GET /api/v1/public/support-contact`. Null: not offered. */
export interface SupportContact {
  /** Digits with the country code, e.g. 6281234567890. */
  whatsapp: string | null
  email: string | null
  /** WhatsApp group invite, https://chat.whatsapp.com/<code>. */
  groupUrl: string | null
}

const NONE: SupportContact = { whatsapp: null, email: null, groupUrl: null }

/** The backend accepts only this shape; checked again here because the value becomes a link for every customer. */
export function safeGroupUrl(v: unknown): string | null {
  return typeof v === "string" && /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]{10,60}$/.test(v) ? v : null
}

/**
 * The public support contacts. No token: the footer shows them on the sign-in screens too. Mock and live (dev bridge)
 * modes have no backend for this, so they get none rather than invented sample contacts.
 */
export async function fetchSupportContact(
  baseUrl = process.env.NEXT_PUBLIC_HERMES_API_URL ?? "",
  mode = apiMode(),
  fetchImpl: typeof fetch = fetch
): Promise<SupportContact> {
  if (mode !== "customer" || !baseUrl) return NONE
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/api/v1/public/support-contact`, { headers: { accept: "application/json" } })
  if (!res.ok) throw new ApiError(res.status, "http_error", `Request failed (${res.status})`)
  const body = (await res.json()) as Partial<SupportContact>
  return { whatsapp: body.whatsapp ?? null, email: body.email ?? null, groupUrl: safeGroupUrl(body.groupUrl) }
}

/** wa.me chat link for a number stored as digits with the country code. */
export function whatsappUrl(digits: string): string {
  return `https://wa.me/${digits}`
}

/** How the number is shown: "+62 812 3456 7890" for Indonesian numbers, "+<digits>" otherwise. */
export function formatWhatsapp(digits: string): string {
  const id = /^62(\d{3})(\d{4})(\d{1,5})$/.exec(digits)
  return id ? `+62 ${id[1]} ${id[2]} ${id[3]}` : `+${digits}`
}
