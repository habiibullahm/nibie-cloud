import { ApiError, type BillingApi, type HermesApi, type InstancesApi, type PreviewApi } from "./client"
import { MODEL_FORMAT, TELEGRAM_TOKEN_FORMAT, TELEGRAM_USER_ID_FORMAT } from "./providers"
import { createMockTicketsApi } from "./tickets"
import type {
  Backup,
  BillingPayment,
  BillingStatus,
  BillingSubscription,
  FileEntry,
  Instance,
  InstanceEvent,
  InstanceMeta,
  InstanceStatus,
  Invoice,
  LogLine,
  Plan,
  ProviderConfig,
  Region,
  RouterModel,
  TelegramConfig,
  UsagePoint,
  Wallet,
  AiAccount,
  AiPurchase,
  AiKey,
} from "./types"

/**
 * In-memory stand-in for the Nibie Cloud API. Lives in the browser for the lifetime of the
 * page, simulates lifecycle transitions with timers, and enforces the same action guards as the
 * backend's InstanceService so the UI behaves the same against either.
 */

/** Stand-in for the SumoPod invoice URL: mock mode has no payment page, the UI shows a notice instead. */
export const MOCK_PAYMENT_URL = "mock://payment"

export const MOCK_TENANT_ID = "00000000-0000-4000-8000-000000000001"

/** Sample NibieRouter catalogue: the default free model plus a few priced ones (US$ per 1M tokens). */
export const MOCK_ROUTER_MODELS: RouterModel[] = [
  { id: "nibierouter-free", name: "NibieRouter Free", contextLength: 131072, promptUsdPerM: 0, completionUsdPerM: 0, free: true },
  { id: "qwen4-max:free", name: "Qwen4 Max (free)", contextLength: 131072, promptUsdPerM: 0, completionUsdPerM: 0, free: true },
  { id: "sample-fast", name: "Sample Fast", contextLength: 262144, promptUsdPerM: 0.3, completionUsdPerM: 2.16, free: false },
  { id: "sample-pro", name: "Sample Pro", contextLength: 200000, promptUsdPerM: 3, completionUsdPerM: 15, free: false },
]

export const PLANS: Plan[] = [
  {
    id: "5b0c6a2e-1f1d-4c55-9a7e-0d1f3a000001",
    slug: "starter",
    name: "Starter",
    cpuMillis: 500,
    memoryMb: 1024,
    storageMb: 5120,
    pids: 256,
    backupRetentionDays: 7,
    customDomain: false,
    monthlyPriceIdr: null,
    includedCreditUsd: null,
    available: true,
  },
  {
    id: "5b0c6a2e-1f1d-4c55-9a7e-0d1f3a000002",
    slug: "standard",
    name: "Standard",
    cpuMillis: 1000,
    memoryMb: 2048,
    storageMb: 10240,
    pids: 512,
    backupRetentionDays: 14,
    customDomain: true,
    monthlyPriceIdr: null,
    includedCreditUsd: null,
    available: true,
  },
  {
    id: "5b0c6a2e-1f1d-4c55-9a7e-0d1f3a000003",
    slug: "pro",
    name: "Pro",
    cpuMillis: 2000,
    memoryMb: 4096,
    storageMb: 20480,
    pids: 1024,
    backupRetentionDays: 30,
    customDomain: true,
    monthlyPriceIdr: null,
    includedCreditUsd: null,
    available: true,
  },
]

export const REGIONS: Region[] = [
  { id: "jkt-1", name: "Jakarta", code: "id-jkt-1", hasCapacity: true },
  { id: "sgp-1", name: "Singapore", code: "sg-sin-1", hasCapacity: false },
]

export const SEED_IDS = {
  active: "4f2a91c8-6b1e-4c1a-9d3e-0a7c5e2b1f01",
  degraded: "7d0e33b2-91aa-4f6c-8e21-5c4b2a1d9e02",
  stopped: "b81c4d07-2e5f-4a39-b6d8-3f1e0c9a7b03",
} as const

/** Lifecycle step durations in ms. Exported so tests can advance fake timers precisely. */
export const STEP_MS = 1500

interface Row {
  instance: Instance
  meta: InstanceMeta
  events: InstanceEvent[]
  idempotencyKey: string | null
}

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString()
const HOUR = 3_600_000
const DAY = 24 * HOUR

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  return "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16)
  )
}

/** Small deterministic PRNG so charts are stable between renders. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

function seedHash(id: string): number {
  let h = 2166136261
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return h >>> 0
}

const delay = (ms = 120) => new Promise<void>((r) => setTimeout(r, ms))

export interface MockOptions {
  /** Start with no instances (empty-state demo). */
  empty?: boolean
  /** Artificial latency per call; 0 in tests. */
  latencyMs?: number
  /**
   * Live mode: instances come from the real backend, so preview endpoints get ids the mock has
   * never seen. Synthesize a row for them instead of answering 404.
   */
  synthesizeUnknown?: boolean
}

export function createMockApi(opts: MockOptions = {}): HermesApi {
  const latency = opts.latencyMs ?? 120
  const rows = new Map<string, Row>()
  const providers = new Map<string, ProviderConfig>()
  const telegrams = new Map<string, TelegramConfig>()
  const backups = new Map<string, Backup[]>()

  const wait = () => (latency > 0 ? delay(latency) : Promise.resolve())

  function seed(
    name: string,
    status: InstanceStatus,
    planIdx: number,
    ageMs: number,
    reason: string | null = null,
    fixedId?: string
  ) {
    const id = fixedId ?? uuid()
    const running = status === "ACTIVE" || status === "DEGRADED"
    const instance: Instance = {
      id,
      tenantId: MOCK_TENANT_ID,
      name,
      planId: PLANS[planIdx]!.id,
      status,
      statusReason: reason,
      accessUrl: running ? `https://${name}.hermes.example` : null,
      createdAt: iso(ageMs),
    }
    const events: InstanceEvent[] = [
      { type: "provision_requested", message: "Deployment requested", createdAt: iso(ageMs) },
      { type: "provisioning", message: "Runtime and volume created", createdAt: iso(ageMs - 20_000) },
      { type: "starting", message: "Hermes starting", createdAt: iso(ageMs - 40_000) },
      { type: "active", message: "Health check passed", createdAt: iso(ageMs - 60_000) },
    ]
    if (status === "DEGRADED") {
      events.push(
        { type: "health_failed", message: "Gateway health check failed", createdAt: iso(25 * 60_000) },
        { type: "recovery_attempt", message: "Automatic restart attempt 1 of 3", createdAt: iso(24 * 60_000) },
        { type: "degraded", message: "Marked degraded after repeated health check failures", createdAt: iso(20 * 60_000) }
      )
    }
    if (status === "STOPPED") {
      events.push({ type: "stopped", message: "Stopped by customer", createdAt: iso(2 * DAY) })
    }
    rows.set(id, {
      instance,
      meta: {
        planId: PLANS[planIdx]!.id,
        regionId: "jkt-1",
        runtime: planIdx === 2 ? "runsc" : "runc",
        image: "hermes-agent:2026.11",
      },
      events,
      idempotencyKey: null,
    })
    providers.set(id, {
      id: uuid(),
      configured: true,
      kind: "nibierouter",
      providerName: null,
      baseUrl: "https://router.nibie.app/v1",
      model: "nibierouter-free",
      keyHint: null,
      status: status === "STOPPED" ? "untested" : "connected",
      statusMessage: null,
      lastTestedAt: iso(ageMs - 60_000),
      restartRequired: false,
    })
    telegrams.set(id, {
      configured: status === "ACTIVE",
      botUsername: status === "ACTIVE" ? `${name.replace(/-/g, "_")}_bot` : null,
      tokenHint: status === "ACTIVE" ? "…x9Qa" : null,
      verified: status === "ACTIVE",
      statusMessage: null,
      allowlist: status === "ACTIVE" ? ["123456789"] : [],
      verifiedAt: status === "ACTIVE" ? iso(ageMs - 120_000) : null,
      restartRequired: false,
    })
    backups.set(id, [
      { id: uuid(), createdAt: iso(6 * HOUR), sizeMb: 412, status: "completed", kind: "scheduled", checksum: "sha256:9f2c…a41e" },
      { id: uuid(), createdAt: iso(30 * HOUR), sizeMb: 398, status: "completed", kind: "scheduled", checksum: "sha256:1be0…77c2" },
      { id: uuid(), createdAt: iso(3 * DAY), sizeMb: 377, status: "completed", kind: "pre-upgrade", checksum: "sha256:c03a…0d19" },
    ])
  }

  if (!opts.empty) {
    // Fixed ids so deep links to seeded instances survive a page reload.
    seed("atlas-assistant", "ACTIVE", 1, 12 * DAY, null, SEED_IDS.active)
    seed(
      "research-bot",
      "DEGRADED",
      0,
      5 * DAY,
      "Gateway health check failed 3 times. Automatic recovery is in progress.",
      SEED_IDS.degraded
    )
    seed("weekend-sandbox", "STOPPED", 0, 20 * DAY, null, SEED_IDS.stopped)
  }

  function find(id: string): Row {
    const row = rows.get(id)
    if (!row || row.instance.status === "DELETED") throw new ApiError(404, "not_found", "Instance not found")
    return row
  }

  function transition(row: Row, status: InstanceStatus, type: string, message: string, reason: string | null = null) {
    row.instance = {
      ...row.instance,
      status,
      statusReason: reason,
      accessUrl:
        status === "ACTIVE" || status === "DEGRADED" ? `https://${row.instance.name}.hermes.example` : null,
    }
    row.events = [...row.events, { type, message, createdAt: iso() }]
  }

  function schedule(row: Row, steps: [InstanceStatus, string, string][]) {
    steps.forEach(([status, type, message], i) => {
      setTimeout(() => {
        if (!rows.has(row.instance.id)) return
        transition(row, status, type, message)
        if (status === "DELETED") rows.delete(row.instance.id)
      }, STEP_MS * (i + 1))
    })
  }

  /** Lookup for preview endpoints. */
  /** A start or restart recreates the container with the saved configuration (backend `appliedRevision`). */
  function markConfigApplied(id: string) {
    const p = providers.get(id)
    if (p) providers.set(id, { ...p, restartRequired: false })
    const t = telegrams.get(id)
    if (t) telegrams.set(id, { ...t, restartRequired: false })
  }

  function previewRow(id: string): Row {
    const row = rows.get(id)
    if (row) return row
    if (!opts.synthesizeUnknown) throw new ApiError(404, "not_found", "Instance not found")
    seedWithId(id)
    return rows.get(id)!
  }

  function seedWithId(id: string) {
    const before = new Set(rows.keys())
    seed("instance", "ACTIVE", 1, DAY)
    const created = [...rows.keys()].find((k) => !before.has(k))!
    const row = rows.get(created)!
    rows.delete(created)
    row.instance = { ...row.instance, id }
    rows.set(id, row)
    for (const m of [providers, telegrams, backups] as Map<string, unknown>[]) {
      m.set(id, m.get(created))
      m.delete(created)
    }
  }

  const conflict = (row: Row, action: string) =>
    new ApiError(409, "conflict", `Cannot ${action} an instance in state ${row.instance.status}`)

  const snapshot = (r: Row): Instance => ({ ...r.instance })

  const instances: InstancesApi = {
    async list() {
      await wait()
      return [...rows.values()]
        .filter((r) => r.instance.status !== "DELETED")
        .sort((a, b) => a.instance.createdAt.localeCompare(b.instance.createdAt))
        .map(snapshot)
    },
    async get(id) {
      await wait()
      return snapshot(find(id))
    },
    async status(id) {
      await wait()
      const { status, statusReason, accessUrl } = find(id).instance
      return { status, statusReason, accessUrl }
    },
    async events(id) {
      await wait()
      return [...find(id).events]
    },
    async create(input, idempotencyKey) {
      await wait()
      const name = input.name.trim()
      if (name.length < 1 || name.length > 63 || /\p{Cc}/u.test(name)) {
        throw new ApiError(400, "validation_error", "Name must be 1–63 characters without control characters")
      }
      const plan = PLANS.find((p) => p.id === input.planId)
      if (!plan) throw new ApiError(400, "validation_error", "Unknown plan")
      const existing = [...rows.values()].find((r) => r.idempotencyKey === idempotencyKey)
      if (existing) return snapshot(existing)
      const id = uuid()
      const row: Row = {
        instance: {
          id,
          tenantId: MOCK_TENANT_ID,
          name,
          planId: plan.id,
          status: "PENDING",
          statusReason: null,
          accessUrl: null,
          createdAt: iso(),
        },
        meta: { planId: plan.id, regionId: "jkt-1", runtime: "runc", image: "hermes-agent:2026.11" },
        events: [{ type: "provision_requested", message: "Deployment requested", createdAt: iso() }],
        idempotencyKey,
      }
      rows.set(id, row)
      providers.set(id, {
        id: uuid(),
        configured: true,
        kind: "nibierouter",
        providerName: null,
        baseUrl: "https://router.nibie.app/v1",
        model: "nibierouter-free",
        keyHint: null,
        status: "untested",
        statusMessage: null,
        lastTestedAt: null,
        restartRequired: false,
      })
      telegrams.set(id, {
        configured: false,
        botUsername: null,
        tokenHint: null,
        verified: false,
        statusMessage: null,
        allowlist: [],
        verifiedAt: null,
        restartRequired: false,
      })
      backups.set(id, [])
      schedule(row, [
        ["PROVISIONING", "provisioning", "Creating runtime and persistent volume"],
        ["CONFIGURING", "configuring", "Applying configuration"],
        ["STARTING", "starting", "Hermes starting"],
        ["ACTIVE", "active", "Health check passed"],
      ])
      return snapshot(row)
    },
    async start(id) {
      await wait()
      const row = find(id)
      if (row.instance.status === "ACTIVE" || row.instance.status === "DEGRADED") return snapshot(row)
      if (row.instance.status !== "STOPPED") throw conflict(row, "start")
      transition(row, "STARTING", "start_requested", "Start requested")
      schedule(row, [["ACTIVE", "active", "Health check passed"]])
      markConfigApplied(id)
      return snapshot(row)
    },
    async stop(id) {
      await wait()
      const row = find(id)
      if (row.instance.status === "STOPPED") return snapshot(row)
      if (row.instance.status !== "ACTIVE" && row.instance.status !== "DEGRADED") throw conflict(row, "stop")
      transition(row, "STOPPING", "stop_requested", "Stop requested")
      schedule(row, [["STOPPED", "stopped", "Stopped by customer"]])
      return snapshot(row)
    },
    async restart(id) {
      await wait()
      const row = find(id)
      const s = row.instance.status
      if (s !== "ACTIVE" && s !== "DEGRADED" && s !== "STOPPED") throw conflict(row, "restart")
      transition(row, "STARTING", "restart_requested", "Restart requested")
      schedule(row, [["ACTIVE", "active", "Health check passed"]])
      markConfigApplied(id)
      return snapshot(row)
    },
    async remove(id) {
      await wait()
      const row = find(id)
      const s = row.instance.status
      if (s === "DELETING") return snapshot(row)
      if (!["ACTIVE", "DEGRADED", "STOPPED", "FAILED"].includes(s)) throw conflict(row, "delete")
      transition(row, "DELETING", "delete_requested", "Deletion requested")
      schedule(row, [["DELETED", "deleted", "Instance deleted"]])
      return snapshot(row)
    },
  }

  const preview: PreviewApi = {
    async me() {
      await wait()
      return { name: "Preview user", email: "you@example.com" }
    },
    async plans() {
      await wait()
      return PLANS
    },
    async regions() {
      await wait()
      return REGIONS
    },
    async meta(id) {
      await wait()
      return (opts.synthesizeUnknown ? previewRow(id) : rows.get(id))?.meta ?? null
    },
    async access(id) {
      await wait()
      const { instance } = previewRow(id)
      return {
        url: instance.accessUrl,
        instructions: [
          "Open the instance URL to reach the Hermes web interface.",
          "Sign in with your Nibie Cloud account; the gateway API key is managed for you and never shown.",
          "To chat from your phone, connect a Telegram bot under Configuration.",
        ],
      }
    },
    async usage(id, range) {
      await wait()
      const row = previewRow(id)
      const plan = PLANS.find((p) => p.id === row.meta.planId) ?? PLANS[0]!
      const n = range === "1h" ? 60 : range === "24h" ? 96 : 84
      const stepMs = range === "1h" ? 60_000 : range === "24h" ? 15 * 60_000 : 2 * HOUR
      const r = rng(seedHash(id + range))
      const running = row.instance.status === "ACTIVE" || row.instance.status === "DEGRADED"
      const points: UsagePoint[] = []
      let cpu = 8
      let netIn = 90
      let netOut = 45
      let mem = plan.memoryMb * 0.34
      const disk = plan.storageMb * 0.18
      for (let i = n - 1; i >= 0; i--) {
        cpu = Math.max(1, Math.min(96, cpu + (r() - 0.48) * 10))
        netIn = Math.max(10, Math.min(240, netIn + (r() - 0.5) * 30))
        netOut = Math.max(5, Math.min(120, netOut + (r() - 0.5) * 16))
        mem = Math.max(plan.memoryMb * 0.2, Math.min(plan.memoryMb * 0.9, mem + (r() - 0.5) * plan.memoryMb * 0.03))
        points.push({
          t: new Date(Date.now() - i * stepMs).toISOString(),
          cpuPct: running ? Math.round(cpu * 10) / 10 : 0,
          memoryMb: running ? Math.round(mem) : 0,
          diskMb: Math.round(disk + (n - i) * 0.4),
          netInKbps: running ? Math.round(netIn) : 0,
          netOutKbps: running ? Math.round(netOut) : 0,
        })
      }
      const age = Date.now() - new Date(row.instance.createdAt).getTime()
      return { uptimeSeconds: running ? Math.floor(Math.min(age, 4 * DAY) / 1000) : 0, points }
    },
    async logs(id, filter) {
      await wait()
      previewRow(id)
      const base: Omit<LogLine, "t">[] = [
        { level: "info", source: "runtime", message: "s6-rc: service hermes-gateway successfully started" },
        { level: "info", source: "gateway", message: "API server ready" },
        { level: "info", source: "hermes", message: "Loaded 14 built-in skills, 2 custom skills" },
        { level: "info", source: "hermes", message: "Provider nibierouter ready (model: default)" },
        { level: "debug", source: "hermes", message: "Session 7f3a opened via telegram" },
        { level: "info", source: "hermes", message: "Tool call web.search completed in 812 ms" },
        { level: "warn", source: "gateway", message: "Slow upstream response from provider (4.2 s)" },
        { level: "info", source: "hermes", message: "Skill daily-digest scheduled for 07:00 Asia/Jakarta" },
        { level: "error", source: "gateway", message: "Health probe timed out after 5 s" },
        { level: "info", source: "hermes", message: "Telegram update processed (authorization: [REDACTED])" },
        { level: "info", source: "runtime", message: "Memory usage 712 MiB of 2048 MiB" },
        { level: "debug", source: "hermes", message: "Cache hit ratio 0.82" },
      ]
      const lines: LogLine[] = []
      for (let i = 0; i < 48; i++) {
        const l = base[i % base.length]!
        lines.push({ ...l, t: iso((48 - i) * 47_000) })
      }
      const q = filter.query?.trim().toLowerCase()
      return lines.filter(
        (l) =>
          (!filter.level || filter.level === "all" || l.level === filter.level) &&
          (!q || l.message.toLowerCase().includes(q) || l.source.includes(q))
      )
    },
    async provider(id) {
      await wait()
      previewRow(id)
      return providers.get(id)!
    },
    async saveProvider(id, input) {
      await wait()
      previewRow(id)
      const prev = providers.get(id)
      if (input.kind === "byok") {
        if (!input.apiKey) throw new ApiError(400, "validation_error", "Enter your API key")
        if (!input.model || !MODEL_FORMAT.test(input.model)) {
          throw new ApiError(400, "validation_error", "Enter the model name")
        }
        let u: URL
        try {
          u = new URL(input.baseUrl ?? "")
        } catch {
          throw new ApiError(400, "validation_error", "Base URL must be a valid https URL")
        }
        if (u.protocol !== "https:") throw new ApiError(400, "validation_error", "Base URL must use https")
      }
      const router = input.kind === "nibierouter"
      const next: ProviderConfig = {
        id: prev?.id || uuid(),
        configured: true,
        kind: input.kind,
        providerName: router ? null : (input.providerName ?? "custom"),
        baseUrl: router ? "https://router.nibie.app/v1" : (input.baseUrl ?? null),
        model: router ? "nibierouter-free" : (input.model ?? null),
        keyHint: router ? null : `…${input.apiKey!.slice(-4)}`,
        status: "untested",
        statusMessage: null,
        lastTestedAt: null,
        restartRequired: true,
      }
      providers.set(id, next)
      return next
    },
    async testProvider(id) {
      await wait()
      await delay(latency > 0 ? 600 : 0)
      const prev = providers.get(id)!
      const next: ProviderConfig = { ...prev, status: "connected", statusMessage: null, lastTestedAt: iso() }
      providers.set(id, next)
      return next
    },
    async routerModels(id) {
      await wait()
      previewRow(id)
      return { freeOnly: false, models: MOCK_ROUTER_MODELS }
    },
    async setRouterModel(id, model) {
      await wait()
      previewRow(id)
      const prev = providers.get(id)!
      if (prev.kind !== "nibierouter" || !prev.configured) {
        throw new ApiError(409, "not_nibierouter", "Only the NibieRouter provider has a model to choose here")
      }
      if (!MOCK_ROUTER_MODELS.some((m) => m.id === model)) {
        throw new ApiError(400, "validation_error", "NibieRouter does not offer this model")
      }
      if (prev.model === model) return prev
      const next: ProviderConfig = { ...prev, model, restartRequired: true }
      providers.set(id, next)
      return next
    },
    async telegram(id) {
      await wait()
      previewRow(id)
      return telegrams.get(id)!
    },
    async saveTelegram(id, input) {
      await wait()
      previewRow(id)
      if (!TELEGRAM_TOKEN_FORMAT.test(input.token)) {
        throw new ApiError(400, "validation_error", "That does not look like a BotFather token")
      }
      if (input.allowlist.length === 0 || !input.allowlist.every((u) => TELEGRAM_USER_ID_FORMAT.test(u))) {
        throw new ApiError(400, "validation_error", "Allowed users must be numeric Telegram user IDs")
      }
      const next: TelegramConfig = {
        configured: true,
        botUsername: "your_hermes_bot",
        tokenHint: `…${input.token.slice(-4)}`,
        verified: false,
        statusMessage: null,
        allowlist: [...new Set(input.allowlist)],
        verifiedAt: null,
        restartRequired: true,
      }
      telegrams.set(id, next)
      return next
    },
    async verifyTelegram(id) {
      await wait()
      await delay(latency > 0 ? 600 : 0)
      const next = { ...telegrams.get(id)!, verified: true, statusMessage: null, verifiedAt: iso() }
      telegrams.set(id, next)
      return next
    },
    async removeTelegram(id) {
      await wait()
      const next: TelegramConfig = {
        configured: false,
        botUsername: null,
        tokenHint: null,
        verified: false,
        statusMessage: null,
        allowlist: [],
        verifiedAt: null,
        restartRequired: true,
      }
      telegrams.set(id, next)
      return next
    },
    async files(id, path) {
      await wait()
      previewRow(id)
      return mockFiles(path)
    },
    async fileContent(id, path) {
      await wait()
      previewRow(id)
      if (path.endsWith("config.yaml")) {
        return "# Hermes configuration\nmodel:\n  provider: nibierouter\n  default: auto\ngateway:\n  telegram: enabled\nskills:\n  - daily-digest\n  - notes\n"
      }
      if (path.endsWith(".md")) return "# Notes\n\nThings Hermes should remember.\n"
      return `Preview of ${path}\n`
    },
    async backups(id) {
      await wait()
      previewRow(id)
      return backups.get(id) ?? []
    },
    async createBackup(id) {
      await wait()
      previewRow(id)
      const b: Backup = {
        id: uuid(),
        createdAt: iso(),
        sizeMb: 420,
        status: "running",
        kind: "manual",
        checksum: "pending",
      }
      backups.set(id, [b, ...(backups.get(id) ?? [])])
      setTimeout(() => {
        const list = backups.get(id)
        if (!list) return
        backups.set(
          id,
          list.map((x) => (x.id === b.id ? { ...x, status: "completed", checksum: "sha256:4ad1…e3b0" } : x))
        )
      }, STEP_MS * 2)
      return b
    },
  }

  /**
   * In-memory billing. Every sample instance gets a subscription so the Billing page has something to show:
   * active ones are paid, the degraded sample is in grace, the stopped sample is suspended. There is no
   * payment page in mock mode, so invoices carry MOCK_PAYMENT_URL and the UI says so.
   */
  const subs = new Map<string, BillingSubscription>()
  function paymentFor(subscriptionId: string, purpose: BillingPayment["purpose"], amountIdr: number): BillingPayment {
    return {
      id: uuid(),
      subscriptionId,
      status: "PENDING",
      purpose,
      method: "QRIS",
      amountIdr,
      paymentUrl: MOCK_PAYMENT_URL,
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
      paidAt: null,
    }
  }
  function billingFor(row: Row): BillingSubscription {
    const existing = [...subs.values()].find((x) => x.instanceId === row.instance.id)
    if (existing) return existing
    const plan = PLANS.find((p) => p.id === row.meta.planId) ?? PLANS[0]!
    const status: BillingStatus =
      row.instance.status === "STOPPED" ? "SUSPENDED" : row.instance.status === "DEGRADED" ? "GRACE" : "ACTIVE"
    const created = new Date(row.instance.createdAt).getTime()
    const sub: BillingSubscription = {
      id: uuid(),
      planId: plan.id,
      planName: plan.name,
      instanceId: row.instance.id,
      name: row.instance.name,
      status,
      currentPeriodEnd: new Date(status === "ACTIVE" ? created + 30 * DAY : Date.now() - 2 * DAY).toISOString(),
      cancelAtPeriodEnd: false,
      autoRenew: true,
      graceEndsAt: status === "GRACE" ? new Date(Date.now() + DAY).toISOString() : null,
      retentionEndsAt: status === "SUSPENDED" ? new Date(Date.now() + 20 * DAY).toISOString() : null,
      createdAt: row.instance.createdAt,
      latestPayment: null,
    }
    subs.set(sub.id, sub)
    return sub
  }
  const billing: BillingApi = {
    async list() {
      await wait()
      for (const row of rows.values()) billingFor(row)
      return [...subs.values()]
    },
    async checkout() {
      await wait()
      throw new ApiError(404, "plan_not_for_sale", "Plans have no price in preview mode, so there is nothing to buy.")
    },
    async upgrade() {
      await wait()
      throw new ApiError(404, "plan_not_for_sale", "Plans have no price in preview mode, so there is nothing to buy.")
    },
    async renew(subscriptionId) {
      await wait()
      const sub = subs.get(subscriptionId)
      if (!sub || sub.status === "ENDED" || sub.status === "PENDING_PAYMENT") {
        throw new ApiError(409, "subscription_not_renewable", "This subscription cannot be renewed.")
      }
      const payment = paymentFor(sub.id, "RENEWAL", PLANS.find((p) => p.id === sub.planId)?.monthlyPriceIdr ?? 0)
      const next = { ...sub, latestPayment: payment }
      subs.set(sub.id, next)
      return { subscription: next, payment }
    },
    async cancel(subscriptionId) {
      await wait()
      const sub = subs.get(subscriptionId)
      if (!sub || sub.status === "ENDED" || sub.status === "PENDING_PAYMENT") {
        throw new ApiError(409, "subscription_not_cancellable", "This subscription cannot be cancelled.")
      }
      const next = { ...sub, cancelAtPeriodEnd: true }
      subs.set(sub.id, next)
      return next
    },
    // A top-up gets an invoice with no payment page, like renewals.
    async wallet() {
      await wait()
      return { ...wallet, topups: [...wallet.topups] }
    },
    async topup(amountIdr) {
      await wait()
      const { topupMinIdr, topupMaxIdr } = wallet.limits
      if (!Number.isInteger(amountIdr) || amountIdr < topupMinIdr || amountIdr > topupMaxIdr) {
        throw new ApiError(400, "validation_error", "Top-up amount is out of range.")
      }
      const t = {
        id: uuid(), amountIdr, status: "PENDING" as const, paymentUrl: MOCK_PAYMENT_URL,
        expiresAt: new Date(Date.now() + HOUR).toISOString(), paidAt: null, createdAt: new Date().toISOString(),
      }
      wallet.topups.unshift(t)
      return t
    },
    // Pays a renewal invoice from the sample wallet, like the backend: refused when the balance is short.
    async payWithWallet(paymentId) {
      await wait()
      const sub = [...subs.values()].find((x) => x.latestPayment?.id === paymentId)
      const payment = sub?.latestPayment
      if (!sub || !payment || payment.status !== "PENDING") throw new ApiError(409, "payment_not_payable", "This invoice can no longer be paid.")
      if (wallet.balanceIdr < payment.amountIdr) throw new ApiError(409, "insufficient_balance", "Not enough balance")
      const now = new Date().toISOString()
      wallet.balanceIdr -= payment.amountIdr
      wallet.entries.unshift({ id: uuid(), amountIdr: -payment.amountIdr, kind: "HOSTING", balanceAfterIdr: wallet.balanceIdr, note: null, createdAt: now })
      const paid = { ...payment, status: "PAID" as const, method: "WALLET" as const, paymentUrl: null, paidAt: now }
      const from = sub.status === "ACTIVE" && sub.currentPeriodEnd ? Date.parse(sub.currentPeriodEnd) : Date.now()
      const next = {
        ...sub, status: "ACTIVE" as const, currentPeriodEnd: new Date(from + 30 * DAY).toISOString(),
        graceEndsAt: null, retentionEndsAt: null, latestPayment: paid,
      }
      subs.set(sub.id, next)
      return { subscription: next, payment: paid }
    },
    async setAutoRenew(subscriptionId, enabled) {
      await wait()
      const sub = subs.get(subscriptionId)
      if (!sub) throw new ApiError(404, "not_found", "Subscription not found")
      const next = { ...sub, autoRenew: enabled }
      subs.set(sub.id, next)
      return next
    },
    async ai() {
      await wait()
      return { ...aiAccount, alert: { ...aiAccount.alert } }
    },
    async setAiAlert(alert) {
      await wait()
      if (!Number.isInteger(alert.thresholdIdr) || alert.thresholdIdr < 1_000 || alert.thresholdIdr > 1_000_000) {
        throw new ApiError(400, "validation_error", "Reminder amount is out of range.")
      }
      aiAccount.alert = { ...alert }
      return { ...alert }
    },
    // Like the backend: Rupiah from the sample wallet to the sample AI balance at the rate, refused when short.
    async buyAiCredit(amountIdr) {
      await wait()
      const buy = aiAccount.buy
      const rate = aiAccount.rate.idrPerUsd
      if (!buy || !rate) throw new ApiError(404, "not_found", "Not found")
      if (!Number.isInteger(amountIdr) || amountIdr < buy.minIdr || amountIdr > buy.maxIdr) {
        throw new ApiError(400, "validation_error", "Amount is out of range.")
      }
      if (wallet.balanceIdr < amountIdr) throw new ApiError(409, "insufficient_balance", "Not enough balance")
      const amountUsd = Math.floor((amountIdr / rate) * 1e9) / 1e9
      const createdAt = new Date().toISOString()
      wallet.balanceIdr -= amountIdr
      wallet.entries.unshift({
        id: uuid(), amountIdr: -amountIdr, kind: "AI_CREDIT", balanceAfterIdr: wallet.balanceIdr,
        note: `Kredit AI US$${amountUsd.toFixed(2)}`, createdAt,
      })
      aiAccount.balanceUsd += amountUsd
      aiAccount.balanceIdr = Math.floor(aiAccount.balanceUsd * rate)
      const purchase: AiPurchase = { id: uuid(), amountIdr, amountUsd, status: "DONE", createdAt }
      return purchase
    },
    async aiKeys() {
      await wait()
      return { baseUrl: "https://router.nibie.app/v1", hasAccount: true, keys: aiKeys.map((k) => ({ ...k })) }
    },
    async createAiKey(name) {
      await wait()
      const clean = name.trim()
      if (!/^[A-Za-z0-9 _.-]{1,40}$/.test(clean)) throw new ApiError(400, "validation_error", "Use 1 to 40 letters, digits, spaces, dots, dashes or underscores.")
      if (aiKeys.filter((k) => !k.revoked).length >= 5) throw new ApiError(409, "key_limit", "At most 5 active keys")
      const key: AiKey = { id: uuid(), name: clean, createdAt: new Date().toISOString(), revoked: false }
      aiKeys.push(key)
      return { key: { ...key }, secret: `sk-preview-${uuid().replace(/-/g, "")}`, baseUrl: "https://router.nibie.app/v1" }
    },
    async revokeAiKey(id) {
      await wait()
      const key = aiKeys.find((k) => k.id === id && !k.revoked)
      if (!key) throw new ApiError(404, "not_found", "Key not found")
      key.revoked = true
    },
    async aiModels() {
      await wait()
      return { baseUrl: "https://router.nibie.app/v1", freeOnly: false, models: MOCK_ROUTER_MODELS.map((m) => ({ ...m })) }
    },
    async invoices() {
      await wait()
      return [...MOCK_INVOICES]
    },
    async invoice(id) {
      await wait()
      const inv = MOCK_INVOICES.find((i) => i.id === id)
      if (!inv) throw new ApiError(404, "not_found", "Invoice not found")
      return { ...inv, billedTo: "you@example.com" }
    },
  }
  // A sample balance, so paying from the wallet can be tried in preview mode.
  const wallet: Wallet = {
    balanceIdr: 150_000,
    autoRenew: true,
    limits: { topupMinIdr: 10_000, topupMaxIdr: 2_000_000, maxBalanceIdr: 5_000_000 },
    entries: [
      { id: uuid(), amountIdr: 150_000, kind: "TOPUP", balanceAfterIdr: 150_000, note: null, createdAt: new Date(Date.now() - DAY).toISOString() },
    ],
    topups: [],
  }

  // A sample NibieRouter balance at the router's rate, with a week of usage.
  const aiDay = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10)
  const aiAccount: AiAccount = {
    rate: { idrPerUsd: 18_600, source: "router" },
    hasAccount: true,
    balanceUsd: 1.62, balanceIdr: 30_132, spend30dUsd: 0.38, spend30dIdr: 7_068,
    daily: [6, 5, 4, 3, 2, 1, 0].map((n, i) => ({ day: aiDay(n), requests: 4 + i * 3, costUsd: 0.02 + i * 0.01, costIdr: Math.floor((0.02 + i * 0.01) * 18_600) })),
    models: [
      { model: "paid-model", requests: 41, costUsd: 0.38, costIdr: 7_068 },
      { model: "nibierouter-free", requests: 12, costUsd: 0, costIdr: 0 },
    ],
    alert: { enabled: true, thresholdIdr: 10_000 },
    buy: { minIdr: 10_000, maxIdr: 1_000_000 },
  }

  // One sample key, so the API keys page has a row in preview mode.
  const aiKeys: AiKey[] = [{ id: uuid(), name: "my-script", createdAt: new Date(Date.now() - 3 * DAY).toISOString(), revoked: false }]

  return { mode: "mock", instances, billing, tickets: createMockTicketsApi(), preview }
}

/** Sample invoices for preview mode. */
const MOCK_INVOICES: Invoice[] = [
  {
    id: "7a1c2e9e-3c1d-4f0a-9b51-2f7f0c6d8e01", number: "INV/2026/11/0002", kind: "HOSTING_NEW", planName: "Hosting",
    instanceName: "support-bot", amountIdr: 49_000, paidAt: "2026-11-20T03:12:00.000Z", reference: "SP-PREVIEW-2", method: "QRIS",
  },
  {
    id: "7a1c2e9e-3c1d-4f0a-9b51-2f7f0c6d8e00", number: "INV/2026/11/0001", kind: "TOPUP", planName: null,
    instanceName: null, amountIdr: 50_000, paidAt: "2026-11-19T09:40:00.000Z", reference: "SP-PREVIEW-1", method: "QRIS",
  },
]

/** A fixed tree rooted at the tenant volume. Paths are volume-relative by construction. */
function mockFiles(path: string): FileEntry[] {
  const now = Date.now()
  const at = (h: number) => new Date(now - h * HOUR).toISOString()
  const tree: Record<string, FileEntry[]> = {
    "/": [
      { name: "skills", path: "/skills", type: "dir", size: 0, modifiedAt: at(30) },
      { name: "memory", path: "/memory", type: "dir", size: 0, modifiedAt: at(2) },
      { name: "logs", path: "/logs", type: "dir", size: 0, modifiedAt: at(0.2) },
      { name: "config.yaml", path: "/config.yaml", type: "file", size: 1843, modifiedAt: at(50) },
      { name: "SOUL.md", path: "/SOUL.md", type: "file", size: 912, modifiedAt: at(120) },
    ],
    "/skills": [
      { name: "daily-digest", path: "/skills/daily-digest", type: "dir", size: 0, modifiedAt: at(30) },
      { name: "notes", path: "/skills/notes", type: "dir", size: 0, modifiedAt: at(90) },
    ],
    "/memory": [
      { name: "MEMORY.md", path: "/memory/MEMORY.md", type: "file", size: 6620, modifiedAt: at(2) },
      { name: "USER.md", path: "/memory/USER.md", type: "file", size: 1204, modifiedAt: at(26) },
    ],
    "/logs": [
      { name: "gateway.log", path: "/logs/gateway.log", type: "file", size: 284_112, modifiedAt: at(0.2) },
      { name: "agent.log", path: "/logs/agent.log", type: "file", size: 1_204_331, modifiedAt: at(0.2) },
    ],
  }
  return tree[path] ?? []
}
