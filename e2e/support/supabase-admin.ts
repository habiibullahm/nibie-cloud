import { required } from "./env"

/**
 * Supabase Auth over plain HTTP. The secret (service role) key is used only here, in Node, to create and delete
 * test users in the dedicated test project. It never reaches a browser or a build.
 */
function adminHeaders(): Record<string, string> {
  const key = required("E2E_SUPABASE_SECRET_KEY")
  // Legacy service_role keys are JWTs and go in both headers; new sb_secret_ keys only in `apikey`.
  return key.startsWith("eyJ")
    ? { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" }
    : { apikey: key, "content-type": "application/json" }
}

const base = (): string => required("E2E_SUPABASE_URL").replace(/\/$/, "")

async function findUserId(email: string): Promise<string | null> {
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${base()}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: adminHeaders() })
    if (!res.ok) throw new Error(`Supabase admin list users failed: HTTP ${res.status}`)
    const body = (await res.json()) as { users: Array<{ id: string; email?: string }> }
    const hit = body.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
    if (hit) return hit.id
    if (body.users.length < 200) return null
  }
  return null
}

/** True when the secret key is set, so test users can be created. Without it they must exist already (see README). */
export const canManageUsers = (): boolean => Boolean(process.env.E2E_SUPABASE_SECRET_KEY)

/** Recreates the user with the given password, already confirmed (no email is sent). Needs the secret key. */
export async function recreateUser(email: string, password: string): Promise<void> {
  const existing = await findUserId(email)
  if (existing) await deleteUserById(existing)
  const res = await fetch(`${base()}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  if (!res.ok) throw new Error(`Supabase admin create user failed: HTTP ${res.status}`)
}

async function deleteUserById(id: string): Promise<void> {
  const res = await fetch(`${base()}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: adminHeaders() })
  if (!res.ok) throw new Error(`Supabase admin delete user failed: HTTP ${res.status}`)
}

/** Password sign-in from Node, used by cleanup helpers that talk to the customer API. Returns the access token. */
export async function signInToken(email: string, password: string): Promise<string> {
  const res = await fetch(`${base()}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: required("E2E_SUPABASE_PUBLISHABLE_KEY"), "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(`Supabase sign-in failed: HTTP ${res.status}`)
  return ((await res.json()) as { access_token: string }).access_token
}
