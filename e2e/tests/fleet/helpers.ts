import { execFileSync } from "node:child_process"
import { createHmac } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Page } from "@playwright/test"
import pg from "pg"

const __dirname = dirname(fileURLToPath(import.meta.url))
export const E2E_DIR = resolve(__dirname, "../..")
export const REPO_DIR = resolve(E2E_DIR, "..")
export const RUNTIME_ENV_FILE = resolve(E2E_DIR, ".local/fleet-runtime.env.json")

export interface FleetRuntimeEnv {
  adminToken: string
  masterKey: string
  secretsKek: string
  customerEmail: string
  customerPassword: string
  adminEmail: string
  adminPassword: string
  databaseUrl: string
  redisUrl: string
  supabaseUrl: string
  publishableKey: string
  secretKey: string
  dashboardOrigin: string
  apiOrigin: string
  fleetFile: string
  jkt1UsageFile: string
  jkt2UsageFile: string
  agentOrigin: string
  clientTlsDir: string
  dindContainer: string
  agentContainer: string
  hermesImage: string
}

export function loadRuntimeEnv(): FleetRuntimeEnv {
  return JSON.parse(readFileSync(RUNTIME_ENV_FILE, "utf8")) as FleetRuntimeEnv
}

export async function signInUi(page: Page, email: string, password: string) {
  await page.goto("/dashboard/sign-in")
  await page.locator("#email").fill(email)
  await page.locator("#password").fill(password)
  await page.locator('button[type="submit"]').click()
  await page.waitForURL(/\/dashboard\/instances/)
}

export function totpCode(secretBase32: string, timestampMs = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  const clean = secretBase32.toUpperCase().replace(/[^A-Z2-7]/g, "")
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  const key = Buffer.from(bytes)
  const counter = BigInt(Math.floor(timestampMs / 30_000))
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(counter)
  const digest = createHmac("sha1", key).update(buf).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const code = ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff)
  return String(code % 1_000_000).padStart(6, "0")
}

export async function operatorApi(
  env: FleetRuntimeEnv,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
  method = body === undefined ? "GET" : "POST",
): Promise<Response> {
  return fetch(`${env.apiOrigin}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.adminToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
}

export async function withPg<T>(env: FleetRuntimeEnv, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: env.databaseUrl })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

export function inspectNodeDocker(env: FleetRuntimeEnv, nodeName: string, instanceId: string): {
  state: "running" | "exited" | "absent"
  volumePresent: boolean
} {
  const runDocker = (args: string[]) =>
    execFileSync("docker", nodeName === "jkt-2" ? ["exec", env.dindContainer, "docker", "-H", "unix:///var/run/docker.sock", ...args] : args, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim()

  let state: "running" | "exited" | "absent" = "absent"
  try {
    const raw = runDocker(["inspect", "-f", "{{.State.Running}}", `hermes-${instanceId}`])
    state = raw === "true" ? "running" : "exited"
  } catch {
    state = "absent"
  }

  let volumePresent = false
  try {
    runDocker(["volume", "inspect", `hermes-data-${instanceId}`])
    volumePresent = true
  } catch {
    volumePresent = false
  }
  return { state, volumePresent }
}

export function writeFreshHostUsage(env: FleetRuntimeEnv, counts = { jkt1: 0, jkt2: 0 }): void {
  const ts = new Date().toISOString()
  const snap = (count: number) => ({
    ts,
    cpus: 4,
    load1: 0.35,
    memTotalMb: 4096,
    memUsedMb: 1024 + count * 128,
    memAvailableMb: 3072 - count * 128,
    diskTotalMb: 32768,
    diskUsedMb: 6144,
    volumesTotalMb: 32768,
    volumesUsedMb: count * 64,
    tenants: count,
    tenantMemMb: count * 128,
  })
  writeFileSync(env.jkt1UsageFile, JSON.stringify(snap(counts.jkt1), null, 2), "utf8")
  writeFileSync(env.jkt2UsageFile, JSON.stringify(snap(counts.jkt2), null, 2), "utf8")
}
