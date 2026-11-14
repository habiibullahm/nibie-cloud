export const MIN_PASSWORD_LENGTH = 8

/** Returns a user-facing message, or null when the password pair is acceptable. */
export function validateNewPassword(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  if (password !== confirm) return "The two passwords do not match."
  return null
}
