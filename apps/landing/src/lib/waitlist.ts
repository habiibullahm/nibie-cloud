/** Waiting list form: where it posts, what it checks before posting, and how each answer is explained to the visitor. */

export const WAITLIST_LIMITS = { name: 100, email: 254, useCase: 500, useCaseMin: 3 } as const

/** Public waiting-list endpoint, or null when the API address is not configured (the form is then not offered). */
export function waitlistUrl(raw: string | undefined = process.env.NEXT_PUBLIC_API_URL): string | null {
  const base = raw?.trim().replace(/\/+$/, "") ?? ""
  return /^https?:\/\/[^\s]+$/.test(base) ? `${base}/api/v1/public/waitlist` : null
}

export interface WaitlistInput {
  name: string
  email: string
  useCase: string
  /** Honeypot: a person never sees this field, so it stays empty. */
  website?: string
}

export type WaitlistField = "name" | "email" | "useCase"

/** First problem found, as a field plus an Indonesian message; null when the input can be sent. */
export function validateWaitlist(i: WaitlistInput): { field: WaitlistField; message: string } | null {
  const name = i.name.trim()
  const email = i.email.trim()
  const useCase = i.useCase.trim()
  if (name.length === 0) return { field: "name", message: "Isi namamu." }
  if (name.length > WAITLIST_LIMITS.name || /[\u0000-\u001f\u007f]/.test(name)) return { field: "name", message: `Nama maksimal ${WAITLIST_LIMITS.name} karakter, satu baris.` }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > WAITLIST_LIMITS.email) return { field: "email", message: "Isi alamat email yang benar." }
  if (useCase.length < WAITLIST_LIMITS.useCaseMin) return { field: "useCase", message: "Ceritakan singkat agent-mu mau dipakai untuk apa." }
  if (useCase.length > WAITLIST_LIMITS.useCase) return { field: "useCase", message: `Maksimal ${WAITLIST_LIMITS.useCase} karakter.` }
  return null
}

export type WaitlistResult =
  | { ok: true }
  | { ok: false; kind: "invalid" | "rate_limited" | "full" | "unavailable"; message: string }

const MESSAGES = {
  invalid: "Isianmu belum sesuai. Periksa lagi lalu kirim ulang.",
  rate_limited: "Terlalu banyak percobaan dari jaringan ini. Coba lagi beberapa menit lagi.",
  full: "Daftar tunggu sedang penuh. Coba lagi nanti.",
  unavailable: "Formulir belum bisa terkirim. Coba lagi sebentar lagi.",
} as const

/** Posts the form. The same success answer comes back for a new address and one already on the list. */
export async function submitWaitlist(url: string, input: WaitlistInput, fetchImpl: typeof fetch = fetch): Promise<WaitlistResult> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: input.name, email: input.email, useCase: input.useCase, website: input.website ?? "" }),
    })
    if (res.ok) return { ok: true }
    const kind = res.status === 400 ? "invalid" : res.status === 429 ? "rate_limited" : res.status === 503 ? "full" : "unavailable"
    return { ok: false, kind, message: MESSAGES[kind] }
  } catch {
    return { ok: false, kind: "unavailable", message: MESSAGES.unavailable }
  }
}
