/**
 * Reads test settings from the environment. Values come from `e2e/.env.e2e` (git-ignored, loaded by
 * `playwright.config.ts`) or from GitHub Actions secrets. Nothing here is ever printed.
 */
export function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing ${name}. See e2e/.env.e2e.example and e2e/README.md.`)
  return v
}

export function optional(name: string): string | undefined {
  return process.env[name] || undefined
}

/** Ports used by the local servers. Kept in one place so config and tests agree. */
export const LANDING_PORT = 3300
export const DASHBOARD_PORT = 3100
export const BACKEND_PORT = 3000

export const LANDING_URL = `http://127.0.0.1:${LANDING_PORT}`
export const DASHBOARD_URL = `http://127.0.0.1:${DASHBOARD_PORT}`
export const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`

/**
 * The dashboard defaults to Bahasa Indonesia; these specs assert the English text, so they start with the language
 * switch on English (apps/web lib/prefs-core.ts LANG_KEY). The Indonesian texts are covered by apps/web/test/i18n.test.ts.
 */
export function englishState(origin: string) {
  return { cookies: [], origins: [{ origin, localStorage: [{ name: "nibie.lang", value: "en" }] }] }
}

/** Test users for T1. All share one password from the environment; the Supabase test project holds nothing else. */
export const USER_PASSWORD_VAR = "E2E_USER_PASSWORD"

export type UserKey = "lifecycle" | "outsider" | "login"
/**
 * Address of a test user. `E2E_EMAIL_TEMPLATE` holds `{key}` (for example `name+{key}@gmail.com`, so any mail that
 * were ever sent reaches a real inbox); the real address stays in the environment, never in the repository.
 */
export const emailOf = (key: UserKey): string => (process.env.E2E_EMAIL_TEMPLATE ?? "e2e-{key}@example.com").replace("{key}", `e2e-${key}`)
/** Only these may create instances in the beta gate (BETA_ALLOWED_EMAILS). `outsider` and `login` must not. */
export const BETA_USERS: UserKey[] = ["lifecycle"]
export const authFile = (key: UserKey): string => `.auth/${key}.json`

/** Own database so the tests never touch `hermes` (development) or `hermes_test` (backend tests). */
export const e2eDatabaseUrl = (): string =>
  process.env.E2E_DATABASE_URL ?? "postgresql://hermes:hermes_dev_only@127.0.0.1:5433/hermes_e2e"
