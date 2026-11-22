import { execFileSync } from "node:child_process"
import { createHmac, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"

const __dirname = dirname(fileURLToPath(import.meta.url))
export const E2E_DIR = resolve(__dirname, "..")
export const LOCAL_DIR = resolve(E2E_DIR, ".local")
const KEYS_PATH = resolve(LOCAL_DIR, "auth-keys.json")
const CADDY_PATH = resolve(LOCAL_DIR, "auth.Caddyfile")

export const AUTH_PROXY_PORT = 54421
export const GOTRUE_PORT = 54422
export const AUTH_URL = `http://127.0.0.1:${AUTH_PROXY_PORT}`
export const GOTRUE_CONTAINER = "hermes-e2e-gotrue"
export const PROXY_CONTAINER = "hermes-e2e-auth-proxy"
export const AUTH_DB_NAME = "hermes_e2e_auth"
export const E2E_DB_NAME = "hermes_e2e"
const PG_ADMIN_URL = process.env.E2E_ADMIN_DATABASE_URL ?? "postgresql://hermes:hermes_dev_only@127.0.0.1:5433/postgres"
const PG_AUTH_URL = process.env.E2E_AUTH_DATABASE_URL ?? `postgresql://hermes:hermes_dev_only@127.0.0.1:5433/${AUTH_DB_NAME}`
const PG_CONTAINER_HOST = "postgres:5432"
const DOCKER_NET = "nibie-cloud_default"

function b64url(input) {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input
  return buf.toString("base64").replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_")
}

function signHs256(payload, secret) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = b64url(JSON.stringify(payload))
  const sig = b64url(createHmac("sha256", secret).update(`${header}.${body}`).digest())
  return `${header}.${body}.${sig}`
}

export function loadOrCreateAuthKeys() {
  mkdirSync(LOCAL_DIR, { recursive: true })
  if (existsSync(KEYS_PATH)) {
    return JSON.parse(readFileSync(KEYS_PATH, "utf8"))
  }
  const jwtSecret = randomBytes(32).toString("hex")
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const jwk = privateKey.export({ format: "jwk" })
  const es256Jwk = {
    ...jwk,
    kid: randomUUID(),
    use: "sig",
    key_ops: ["sign", "verify"],
    alg: "ES256",
    ext: true,
  }
  const now = Math.floor(Date.now() / 1000)
  const exp = now + 10 * 365 * 24 * 60 * 60
  const anonKey = signHs256({ role: "anon", iss: "supabase", iat: now, exp }, jwtSecret)
  const serviceRoleKey = signHs256({ role: "service_role", iss: "supabase", iat: now, exp }, jwtSecret)
  const keys = { jwtSecret, es256Jwk, anonKey, serviceRoleKey }
  writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2), { mode: 0o600 })
  return keys
}

async function ensureDatabases() {
  const client = new pg.Client({ connectionString: PG_ADMIN_URL })
  await client.connect()
  try {
    for (const db of [E2E_DB_NAME, AUTH_DB_NAME]) {
      const res = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [db])
      if (res.rowCount === 0) {
        await client.query(`CREATE DATABASE "${db}"`)
      }
    }
  } finally {
    await client.end()
  }
  const authClient = new pg.Client({ connectionString: PG_AUTH_URL })
  await authClient.connect()
  try {
    await authClient.query("CREATE SCHEMA IF NOT EXISTS auth")
    await authClient.query(`ALTER DATABASE "${AUTH_DB_NAME}" SET search_path TO auth, public`)
    await authClient.query(`
      DO $$
      DECLARE r text;
      BEGIN
        FOREACH r IN ARRAY ARRAY['postgres', 'supabase_auth_admin', 'dashboard_user', 'anon', 'authenticated', 'service_role'] LOOP
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('CREATE ROLE %I NOLOGIN', r);
          END IF;
        END LOOP;
      END $$;
    `)
  } finally {
    await authClient.end()
  }
}

function docker(args, opts = {}) {
  return (execFileSync("docker", args, { encoding: "utf8", ...opts }) ?? "").trim()
}

function containerRunning(name) {
  try {
    return docker(["inspect", "-f", "{{.State.Running}}", name], { stdio: ["pipe", "pipe", "ignore"] }) === "true"
  } catch {
    return false
  }
}

function removeIfExists(name) {
  try {
    docker(["rm", "-f", name], { stdio: "ignore" })
  } catch {
    // ignore missing container
  }
}

async function waitHealthy() {
  const deadline = Date.now() + 30_000
  let lastErr = ""
  while (Date.now() < deadline) {
    try {
      const [h, j] = await Promise.all([
        fetch(`${AUTH_URL}/auth/v1/health`, { signal: AbortSignal.timeout(2_000) }),
        fetch(`${AUTH_URL}/auth/v1/.well-known/jwks.json`, { signal: AbortSignal.timeout(2_000) }),
      ])
      if (h.ok && j.ok) {
        const jwks = await j.json()
        if (Array.isArray(jwks.keys) && jwks.keys.length > 0) return
        lastErr = "empty jwks"
      } else {
        lastErr = `health=${h.status} jwks=${j.status}`
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`Local GoTrue auth proxy not healthy at ${AUTH_URL}: ${lastErr}`)
}

export async function startLocalAuthStack() {
  await ensureDatabases()
  const keys = loadOrCreateAuthKeys()
  writeFileSync(
    CADDY_PATH,
    [
      ":80 {",
      "  @preflight method OPTIONS",
      "  handle @preflight {",
      "    header Access-Control-Allow-Origin *",
      '    header Access-Control-Allow-Methods "GET, POST, PUT, PATCH, DELETE, OPTIONS"',
      '    header Access-Control-Allow-Headers "apikey, authorization, content-type, x-client-info, x-supabase-api-version"',
      '    respond "" 204',
      "  }",
      "  handle_path /auth/v1* {",
      "    header >Access-Control-Allow-Origin *",
      `    reverse_proxy ${GOTRUE_CONTAINER}:9999`,
      "  }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  )

  if (!containerRunning(GOTRUE_CONTAINER)) {
    removeIfExists(GOTRUE_CONTAINER)
    docker([
      "run", "-d", "--name", GOTRUE_CONTAINER,
      "--network", DOCKER_NET,
      "-p", `127.0.0.1:${GOTRUE_PORT}:9999`,
      "-e", `API_EXTERNAL_URL=${AUTH_URL}/auth/v1`,
      "-e", "GOTRUE_API_HOST=0.0.0.0",
      "-e", "GOTRUE_API_PORT=9999",
      "-e", "GOTRUE_DB_DRIVER=postgres",
      "-e", "GOTRUE_DB_NAMESPACE=auth",
      "-e", `GOTRUE_DB_DATABASE_URL=postgresql://hermes:hermes_dev_only@${PG_CONTAINER_HOST}/${AUTH_DB_NAME}`,
      "-e", "GOTRUE_SITE_URL=http://127.0.0.1:3410/dashboard",
      "-e", "GOTRUE_URI_ALLOW_LIST=http://127.0.0.1:3410/*",
      "-e", "GOTRUE_DISABLE_SIGNUP=false",
      "-e", "GOTRUE_JWT_ADMIN_ROLES=service_role",
      "-e", "GOTRUE_JWT_AUD=authenticated",
      "-e", "GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated",
      "-e", "GOTRUE_JWT_EXP=3600",
      "-e", `GOTRUE_JWT_ISSUER=${AUTH_URL}/auth/v1`,
      "-e", `GOTRUE_JWT_SECRET=${keys.jwtSecret}`,
      "-e", `GOTRUE_JWT_KEYS=${JSON.stringify([keys.es256Jwk])}`,
      "-e", "GOTRUE_JWT_VALID_METHODS=HS256,ES256",
      "-e", "GOTRUE_MAILER_AUTOCONFIRM=true",
      "-e", "GOTRUE_SECURITY_CAPTCHA_ENABLED=false",
      "-e", "GOTRUE_MFA_TOTP_ENROLL_ENABLED=true",
      "-e", "GOTRUE_MFA_TOTP_VERIFY_ENABLED=true",
      "-e", "GOTRUE_MFA_MAX_ENROLLED_FACTORS=10",
      "public.ecr.aws/supabase/gotrue:v2.197.0",
    ])
  }

  if (!containerRunning(PROXY_CONTAINER)) {
    removeIfExists(PROXY_CONTAINER)
    docker([
      "run", "-d", "--name", PROXY_CONTAINER,
      "--network", DOCKER_NET,
      "-p", `127.0.0.1:${AUTH_PROXY_PORT}:80`,
      "-v", `${CADDY_PATH}:/etc/caddy/Caddyfile:ro`,
      "caddy:2.10",
    ])
  }

  await waitHealthy()
  return {
    url: AUTH_URL,
    publishableKey: keys.anonKey,
    secretKey: keys.serviceRoleKey,
    databaseUrl: `postgresql://hermes:hermes_dev_only@127.0.0.1:5433/${E2E_DB_NAME}`,
  }
}

export function stopLocalAuthStack() {
  removeIfExists(PROXY_CONTAINER)
  removeIfExists(GOTRUE_CONTAINER)
}

async function main() {
  const cmd = process.argv[2] ?? "up"
  if (cmd === "up") {
    const info = await startLocalAuthStack()
    console.log(JSON.stringify(info, null, 2))
  } else if (cmd === "down") {
    stopLocalAuthStack()
    console.log("Stopped local E2E auth stack")
  } else if (cmd === "status") {
    console.log(JSON.stringify({
      gotrue: containerRunning(GOTRUE_CONTAINER),
      proxy: containerRunning(PROXY_CONTAINER),
      url: AUTH_URL,
    }, null, 2))
  } else {
    console.error(`Unknown command: ${cmd}. Use: up | down | status`)
    process.exit(1)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
