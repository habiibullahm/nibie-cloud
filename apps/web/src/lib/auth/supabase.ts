import { createClient, type SupabaseClient } from "@supabase/supabase-js"

let client: SupabaseClient | null | undefined

/** True when both public Supabase variables are set. Without them the auth screens stay a preview. */
export function authConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
}

/** Browser Supabase client, or null when auth is not configured. Uses the publishable key only. */
export function getSupabase(): SupabaseClient | null {
  if (client !== undefined) return client
  client = authConfigured()
    ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
        // The confirm and callback pages handle the URL themselves, so nothing should parse it on its own. PKCE: Google
        // returns a one-time `code` to /auth/callback, never tokens in the URL.
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: "pkce" },
      })
    : null
  return client
}
