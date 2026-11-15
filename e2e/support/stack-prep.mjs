// Prepares the T1 stack before `playwright test`: database, seed rows, stub image, customer-mode dashboard build.
// Usage: node support/stack-prep.mjs        (reads .env.e2e or the environment; prints no secret)
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import pg from "pg"

if (existsSync(".env.e2e")) process.loadEnvFile(".env.e2e")

const need = (n) => {
  const v = process.env[n]
  if (!v) { console.error(`Missing ${n}. See e2e/.env.e2e.example.`); process.exit(1) }
  return v
}
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts })
const adminUrl = process.env.E2E_ADMIN_DATABASE_URL ?? "postgresql://hermes:hermes_dev_only@127.0.0.1:5433/hermes"
const dbUrl = process.env.E2E_DATABASE_URL ?? "postgresql://hermes:hermes_dev_only@127.0.0.1:5433/hermes_e2e"
const supabaseUrl = need("E2E_SUPABASE_URL")
const publishableKey = need("E2E_SUPABASE_PUBLISHABLE_KEY")
need("E2E_SUPABASE_SECRET_KEY")
need("E2E_USER_PASSWORD")

// 1. Postgres and Redis. In CI they are workflow services; locally they come from the root compose.yaml.
if (!process.env.CI) run("docker", ["compose", "up", "-d", "postgres", "redis"], { cwd: ".." })

// 2. Own database, migrated.
{
  const admin = new pg.Client({ connectionString: adminUrl })
  for (let i = 0; ; i++) {
    try { await admin.connect(); break } catch (e) {
      if (i > 30) throw e
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'hermes_e2e'")
  if (!rowCount) await admin.query("CREATE DATABASE hermes_e2e")
  await admin.end()
}
run("pnpm", ["--dir", "..", "db:migrate"], { env: { ...process.env, DATABASE_URL: dbUrl } })

// 3. Seed: one free plan (monthlyPriceIdr null, so the dashboard deploys directly) and one node. Same values as scripts/demo.ts.
{
  const db = new pg.Client({ connectionString: dbUrl })
  await db.connect()
  await db.query(
    `INSERT INTO "Plan" (id, slug, name, active, "cpuMillis", "memoryMb", pids, "storageMb")
     VALUES (gen_random_uuid(), 'demo-small', 'Demo small', true, 500, 256, 128, 1024)
     ON CONFLICT (slug) DO UPDATE SET active = true, "monthlyPriceIdr" = NULL`,
  )
  await db.query(
    `INSERT INTO "RuntimeNode" (id, name, region) VALUES (gen_random_uuid(), 'local', 'local') ON CONFLICT (name) DO NOTHING`,
  )
  await db.end()
}

// 4. The Hermes stand-in image (the same Dockerfile the backend integration tests build).
try {
  run("docker", ["image", "inspect", "hermes-stub:0.2.0"], { stdio: "ignore" })
} catch {
  run("docker", ["build", "-t", "hermes-stub:0.2.0", "../test/fixtures/hermes-stub"])
}

// 5. Dashboard in customer mode. NEXT_PUBLIC_* are fixed at build time, so this always rebuilds.
run("pnpm", ["--dir", "../apps/web", "build"], {
  env: {
    ...process.env,
    NEXT_PUBLIC_HERMES_API_MODE: "customer",
    NEXT_PUBLIC_HERMES_API_URL: "http://127.0.0.1:3000",
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
  },
})
console.log("T1 stack is ready. Run: pnpm test:t1")
