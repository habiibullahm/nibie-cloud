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
        // The confirm page verifies the token itself, so nothing should parse the URL on its own.
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      })
    : null
  return client
}
