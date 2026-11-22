import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { startLocalAuthStack } from "./local-auth-stack.mjs"
import { DIND_CONTAINER, REPO_DIR, startLocalFleet, writeHostUsageSnapshots } from "./local-fleet.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const E2E_DIR = resolve(__dirname, "..")
const LOCAL_DIR = resolve(E2E_DIR, ".local")
export const RUNTIME_ENV_FILE = resolve(LOCAL_DIR, "fleet-runtime.env.json")

function pnpmBin() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm"
}

function runPnpm(args, env = process.env, cwd = E2E_DIR) {
  execFileSync(pnpmBin(), args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" })
}

function loadOrCreateSecrets() {
  mkdirSync(LOCAL_DIR, { recursive: true })
  if (existsSync(RUNTIME_ENV_FILE)) {
    const prev = JSON.parse(readFileSync(RUNTIME_ENV_FILE, "utf8"))
    if (prev.adminToken && prev.masterKey && prev.secretsKek && prev.customerPassword && prev.adminPassword) {
      return prev
    }
  }
  return {
    adminToken: randomBytes(24).toString("hex"),
    masterKey: randomBytes(32).toString("hex"),
    secretsKek: randomBytes(32).toString("base64"),
    customerEmail: "e2e-customer@hermes.example.test",
    customerPassword: `Cust-${randomBytes(12).toString("hex")}!1`,
    adminEmail: "e2e-admin@hermes.example.test",
    adminPassword: `Admin-${randomBytes(12).toString("hex")}!1`,
  }
}

async function cleanupPreviousDockerInstances(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  let ids = []
  try {
    const reg = await client.query(`SELECT to_regclass('public."Instance"') AS tbl`)
    if (reg.rows[0]?.tbl) {
      const res = await client.query(`SELECT id FROM "Instance"`)
      ids = res.rows.map((r) => r.id)
      await client.query(`
        TRUNCATE TABLE
          "RetiredRuntime",
          "AuditLog",
          "CreditGrant",
          "RouterProvisioning",
          "WalletEntry",
          "WalletTopup",
          "Wallet",
          "Invoice",
          "PaymentEvent",
          "Payment",
          "Subscription",
          "InstanceEvent",
          "Secret",
          "ProviderConfig",
          "TelegramConnection",
          "Instance",
          "WaitlistEntry",
          "BetaInvite",
          "TenantMember",
          "Tenant",
          "User",
          "RuntimeNode"
        CASCADE
      `)
    }
  } finally {
    await client.end()
  }

  for (const id of ids) {
    for (const prefix of ["", `docker exec ${DIND_CONTAINER} `]) {
      const runDocker = (args) => {
        try {
          if (prefix) {
            execFileSync("docker", ["exec", DIND_CONTAINER, "docker", "-H", "unix:///var/run/docker.sock", ...args], { stdio: "ignore" })
          } else {
            execFileSync("docker", args, { stdio: "ignore" })
          }
        } catch {
          // ignore if absent on that node
        }
      }
      runDocker(["rm", "-f", `hermes-${id}`])
      runDocker(["volume", "rm", "-f", `hermes-data-${id}`])
      runDocker(["network", "rm", `hermes-net-${id}`])
    }
  }
}

async function seedPlans(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query(`
      INSERT INTO "Plan" (id, slug, name, active, "cpuMillis", "memoryMb", "storageMb", pids, "monthlyPriceIdr", "includedCreditNano", "stockLimit")
      VALUES
        ('11111111-1111-4111-8111-111111111101', 'free-beta', 'Beta Gratis', true, 1000, 512, 1024, 128, NULL, NULL, NULL),
        ('11111111-1111-4111-8111-111111111102', 'starter', 'Starter', true, 2000, 1024, 4096, 256, 99000, 5000000000, NULL)
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        active = EXCLUDED.active,
        "cpuMillis" = EXCLUDED."cpuMillis",
        "memoryMb" = EXCLUDED."memoryMb",
        "storageMb" = EXCLUDED."storageMb",
        pids = EXCLUDED.pids,
        "monthlyPriceIdr" = EXCLUDED."monthlyPriceIdr",
        "includedCreditNano" = EXCLUDED."includedCreditNano",
        "stockLimit" = EXCLUDED."stockLimit"
    `)
    await client.query(`DELETE FROM "Plan" WHERE slug NOT IN ('free-beta', 'starter')`)
  } finally {
    await client.end()
  }
}

async function authAdminFetch(supabaseUrl, serviceKey, path, init = {}) {
  const res = await fetch(`${supabaseUrl}/auth/v1${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  return { status: res.status, ok: res.ok, data: text ? JSON.parse(text) : null, text }
}

async function ensureAuthUser({ supabaseUrl, serviceKey, email, password, clearMfa }) {
  const listed = await authAdminFetch(supabaseUrl, serviceKey, `/admin/users?page=1&per_page=100`)
  if (!listed.ok) throw new Error(`GoTrue list users failed (${listed.status}): ${listed.text}`)
  const existing = (listed.data?.users ?? []).find((u) => (u.email ?? "").toLowerCase() === email.toLowerCase())
  let userId = existing?.id
  if (!userId) {
    const created = await authAdminFetch(supabaseUrl, serviceKey, `/admin/users`, {
      method: "POST",
      body: JSON.stringify({ email, password, email_confirm: true }),
    })
    if (!created.ok) throw new Error(`GoTrue create user ${email} failed (${created.status}): ${created.text}`)
    userId = created.data.id
  } else {
    const updated = await authAdminFetch(supabaseUrl, serviceKey, `/admin/users/${userId}`, {
      method: "PUT",
      body: JSON.stringify({ password, email_confirm: true }),
    })
    if (!updated.ok) throw new Error(`GoTrue update user ${email} failed (${updated.status}): ${updated.text}`)
  }

  if (clearMfa) {
    const factors = await authAdminFetch(supabaseUrl, serviceKey, `/admin/users/${userId}/factors`)
    if (factors.ok && Array.isArray(factors.data)) {
      for (const f of factors.data) {
        await authAdminFetch(supabaseUrl, serviceKey, `/admin/users/${userId}/factors/${f.id}`, { method: "DELETE" })
      }
    }
  }
  return userId
}

async function main() {
  const auth = await startLocalAuthStack()
  const fleet = await startLocalFleet()
  writeHostUsageSnapshots({ jkt1: 0, jkt2: 0 })

  const base = loadOrCreateSecrets()
  const runtimeEnv = {
    adminToken: base.adminToken,
    masterKey: base.masterKey,
    secretsKek: base.secretsKek,
    customerEmail: base.customerEmail,
    customerPassword: base.customerPassword,
    adminEmail: base.adminEmail,
    adminPassword: base.adminPassword,
    databaseUrl: auth.databaseUrl,
    redisUrl: process.env.E2E_REDIS_URL ?? "redis://:hermes_dev_only@127.0.0.1:6380/4",
    supabaseUrl: auth.url,
    publishableKey: auth.publishableKey,
    secretKey: auth.secretKey,
    dashboardOrigin: "http://127.0.0.1:3410",
    apiOrigin: "http://127.0.0.1:3400",
    fleetFile: fleet.fleetFile,
    jkt1UsageFile: fleet.jkt1UsageFile,
    jkt2UsageFile: fleet.jkt2UsageFile,
    agentOrigin: fleet.agentOrigin,
    clientTlsDir: fleet.clientTlsDir,
    dindContainer: fleet.dindContainer,
    agentContainer: fleet.agentContainer,
    hermesImage: process.env.HERMES_E2E_IMAGE ?? "hermes-stub:0.2.0",
  }
  writeFileSync(RUNTIME_ENV_FILE, JSON.stringify(runtimeEnv, null, 2), { mode: 0o600 })

  runPnpm(["--dir", "..", "db:migrate"], { ...process.env, DATABASE_URL: runtimeEnv.databaseUrl })
  await cleanupPreviousDockerInstances(runtimeEnv.databaseUrl)
  await seedPlans(runtimeEnv.databaseUrl)
  await ensureAuthUser({
    supabaseUrl: runtimeEnv.supabaseUrl,
    serviceKey: runtimeEnv.secretKey,
    email: runtimeEnv.customerEmail,
    password: runtimeEnv.customerPassword,
    clearMfa: false,
  })
  await ensureAuthUser({
    supabaseUrl: runtimeEnv.supabaseUrl,
    serviceKey: runtimeEnv.secretKey,
    email: runtimeEnv.adminEmail,
    password: runtimeEnv.adminPassword,
    clearMfa: true,
  })
  console.log("Fleet E2E environment prepared:", {
    supabaseUrl: runtimeEnv.supabaseUrl,
    apiOrigin: runtimeEnv.apiOrigin,
    dashboardOrigin: runtimeEnv.dashboardOrigin,
    fleetFile: runtimeEnv.fleetFile,
    runtimeEnvFile: RUNTIME_ENV_FILE,
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
