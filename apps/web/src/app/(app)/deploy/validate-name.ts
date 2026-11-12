/** Mirrors validateName() in the backend's InstanceService. */
export function validateInstanceName(name: string): string | null {
  const n = name.trim()
  if (n.length === 0) return "Enter a name for your instance."
  if (n.length > 63) return "Use 63 characters or fewer."
  if (/\p{Cc}/u.test(n)) return "Remove control characters."
  return null
}
