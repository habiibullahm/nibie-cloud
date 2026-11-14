/** Link types Supabase puts in `type=` of an email link built from `{{ .TokenHash }}`. */
export const CONFIRM_TYPES = ["signup", "invite", "recovery", "magiclink", "email_change", "email"] as const
export type ConfirmType = (typeof CONFIRM_TYPES)[number]

export interface ConfirmParams {
  tokenHash: string
  type: ConfirmType
}

/** Reads `token_hash` and `type` from the query string; null when either is missing or unknown. */
export function parseConfirmParams(search: URLSearchParams): ConfirmParams | null {
  const tokenHash = search.get("token_hash")?.trim() ?? ""
  const type = search.get("type") ?? ""
  if (tokenHash === "" || !(CONFIRM_TYPES as readonly string[]).includes(type)) return null
  return { tokenHash, type: type as ConfirmType }
}

/** Where a verified link lands. Invited and recovering users have no password yet, so they set one. */
export function destinationFor(type: ConfirmType): string {
  switch (type) {
    case "invite":
    case "recovery":
      return "/set-password"
    case "signup":
      return "/deploy"
    default:
      return "/instances"
  }
}
