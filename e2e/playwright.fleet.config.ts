import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, devices } from "@playwright/test"

const __dirname = dirname(fileURLToPath(import.meta.url))
const runtimeFile = resolve(__dirname, ".local/fleet-runtime.env.json")

if (!existsSync(runtimeFile)) {
  throw new Error("Missing e2e/.local/fleet-runtime.env.json. Run `node support/fleet-prep.mjs` (or `node run-fleet-e2e.mjs`) in e2e/ first.")
}

const runtimeEnv = JSON.parse(readFileSync(runtimeFile, "utf8"))

export default defineConfig({
  testDir: "./tests/fleet",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-fleet" }]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: runtimeEnv.dashboardOrigin,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "pnpm --dir .. exec tsx src/main.ts",
      url: `${runtimeEnv.apiOrigin}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: "development",
        PORT: "3400",
        DATABASE_URL: runtimeEnv.databaseUrl,
        REDIS_URL: runtimeEnv.redisUrl,
        ...(process.platform === "win32" ? { DOCKER_SOCKET_PATH: "//./pipe/docker_engine" } : {}),
        HERMES_IMAGE: runtimeEnv.hermesImage,
        ADMIN_TOKEN: runtimeEnv.adminToken,
        HERMES_MASTER_KEY: runtimeEnv.masterKey,
        SECRETS_KEK: runtimeEnv.secretsKek,
        HERMES_RUNTIME: "runc",
        HERMES_DISK_QUOTA: "off",
        HERMES_EGRESS_POLICY: "off",
        HERMES_RUNTIME_FLEET_FILE: runtimeEnv.fleetFile,
        HERMES_HOST_USAGE_FILE: runtimeEnv.jkt1UsageFile,
        SUPABASE_URL: runtimeEnv.supabaseUrl,
        DASHBOARD_ORIGIN: runtimeEnv.dashboardOrigin,
        ADMIN_EMAILS: runtimeEnv.adminEmail,
        BETA_ALLOWED_EMAILS: `${runtimeEnv.customerEmail},${runtimeEnv.adminEmail}`,
        MAX_INSTANCES_PER_TENANT: "5",
        FREE_BETA_SLOTS: "0",
        NIBIEROUTER_ADMIN_KEY: "",
        NIBIEROUTER_DEFAULT_MODEL: "",
        SUMOPOD_API_KEY: "",
        SUMOPOD_WEBHOOK_TOKEN: "",
        SUMOPOD_CALLBACK_URL: "",
        SUMOPOD_WEBHOOK_SECRET: "",
        SUMOPOD_SMTP_HOST: "",
        SUMOPOD_SMTP_PORT: "",
        SUMOPOD_SMTP_USER: "",
        SUMOPOD_SMTP_PASS: "",
        MAIL_FROM: "",
        OPS_TELEGRAM_BOT_TOKEN: "",
        OPS_TELEGRAM_CHAT_ID: "",
        TURNSTILE_SECRET_KEY: "",
      },
    },
    {
      command: "pnpm --dir ../apps/web exec next dev -H 127.0.0.1 -p 3410",
      url: `${runtimeEnv.dashboardOrigin}/dashboard/sign-in`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NODE_ENV: "development",
        NEXT_PUBLIC_HERMES_API_MODE: "customer",
        NEXT_PUBLIC_HERMES_API_URL: runtimeEnv.apiOrigin,
        NEXT_PUBLIC_SUPABASE_URL: runtimeEnv.supabaseUrl,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: runtimeEnv.publishableKey,
      },
    },
  ],
})
