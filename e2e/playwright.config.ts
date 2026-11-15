import { defineConfig, devices } from "@playwright/test"
import { existsSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { BACKEND_PORT, BETA_USERS, DASHBOARD_URL, LANDING_PORT, LANDING_URL, e2eDatabaseUrl, emailOf, required } from "./support/env"

// Local secrets for tiers T1 and T2 (git-ignored). CI passes them as environment variables instead.
if (existsSync(".env.e2e")) process.loadEnvFile(".env.e2e")

const CI = Boolean(process.env.CI)
const prodUrl = process.env.PROD_BASE_URL ?? "https://cloud.nibie.app"

export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  // One retry in CI only. A test that needs it to pass is reported as flaky, not hidden.
  retries: CI ? 1 : 0,
  reporter: CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { trace: "retain-on-failure", screenshot: "only-on-failure", video: "off" },
  projects: [
    // T0: no backend and no secrets.
    { name: "landing", testDir: "tests/landing", use: { ...devices["Desktop Chrome"], baseURL: LANDING_URL } },
    {
      name: "landing-mobile",
      testDir: "tests/landing",
      testMatch: /layout\.spec\.ts/,
      use: { ...devices["Pixel 7"], baseURL: LANDING_URL },
    },
    { name: "dashboard-mock", testDir: "tests/dashboard-mock", use: { ...devices["Desktop Chrome"], baseURL: DASHBOARD_URL } },
    {
      name: "dashboard-mock-mobile",
      testDir: "tests/dashboard-mock",
      testMatch: /layout\.spec\.ts/,
      use: { ...devices["Pixel 7"], baseURL: DASHBOARD_URL },
    },
    // T1: real backend and a dedicated Supabase test project. The setup project signs in once and saves the
    // session. It records nothing (no trace, video or screenshot) because it types a password.
    {
      name: "setup-customer",
      testDir: "tests/dashboard-customer",
      testMatch: /auth\.setup\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: DASHBOARD_URL, trace: "off", video: "off", screenshot: "off" },
    },
    {
      name: "dashboard-customer",
      testDir: "tests/dashboard-customer",
      testIgnore: /auth\.setup\.ts/,
      dependencies: ["setup-customer"],
      // No trace, video or screenshot: the repository is public and CI artifacts are downloadable.
      use: { ...devices["Desktop Chrome"], baseURL: DASHBOARD_URL, trace: "off", video: "off", screenshot: "off" },
    },
    // T2: read-only checks against production.
    {
      name: "prod-smoke",
      testDir: "tests/prod-smoke",
      use: { ...devices["Desktop Chrome"], baseURL: prodUrl, trace: "off", video: "off", screenshot: "off" },
    },
  ],
  webServer: webServers(),
})

/** Starts only what the requested tier needs. `E2E_TIER` is t0 (default), t1, or none (T2 and manual servers). */
function webServers() {
  const tier = process.env.E2E_TIER ?? "t0"
  if (tier === "none") return []
  const landing = {
    command: `node support/static-server.mjs ../apps/landing/out ${LANDING_PORT}`,
    url: `${LANDING_URL}/harga`,
    reuseExistingServer: !CI,
    timeout: 30_000,
  }
  // The dashboard must be built first: T0 with the default (mock) build, T1 with the customer-mode variables.
  const dashboard = {
    command: "pnpm --dir ../apps/web start",
    url: `${DASHBOARD_URL}/dashboard/sign-in`,
    reuseExistingServer: !CI,
    timeout: 60_000,
  }
  if (tier === "t0") return [landing, dashboard]
  if (tier === "t1") {
    return [
      { command: "pnpm --dir .. dev", url: `http://127.0.0.1:${BACKEND_PORT}/healthz`, reuseExistingServer: !CI, timeout: 90_000, env: backendEnv() },
      dashboard,
    ]
  }
  throw new Error(`Unknown E2E_TIER "${tier}"`)
}

/**
 * Backend settings for T1: a development backend on loopback with the stub image, no disk quota and no egress
 * rules (both are refused in production), the dedicated Supabase test project, and no billing or router.
 * Secrets the backend only needs for itself (admin token, master key, KEK) are random per run.
 */
function backendEnv(): Record<string, string> {
  const rnd = (bytes: number, enc: "hex" | "base64") => randomBytes(bytes).toString(enc)
  return {
    ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>),
    NODE_ENV: "development",
    PORT: String(BACKEND_PORT),
    DATABASE_URL: e2eDatabaseUrl(),
    HERMES_IMAGE: "hermes-stub:0.2.0",
    ADMIN_TOKEN: rnd(24, "hex"),
    HERMES_MASTER_KEY: rnd(32, "hex"),
    SECRETS_KEK: rnd(32, "base64"),
    HERMES_RUNTIME: "runc",
    HERMES_DISK_QUOTA: "off",
    HERMES_EGRESS_POLICY: "off",
    REDIS_URL: process.env.E2E_REDIS_URL ?? "redis://:hermes_dev_only@127.0.0.1:6380",
    SUPABASE_URL: required("E2E_SUPABASE_URL"),
    DASHBOARD_ORIGIN: DASHBOARD_URL,
    BETA_ALLOWED_EMAILS: BETA_USERS.map(emailOf).join(","),
    MAX_INSTANCES_PER_TENANT: "1",
  }
}
