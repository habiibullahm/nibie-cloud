import { ApiError, type HermesApi, type InstancesApi, type PreviewApi } from "./client"
import type {
  Backup,
  FileEntry,
  Instance,
  InstanceEvent,
  InstanceMeta,
  InstanceStatus,
  LogLine,
  Plan,
  ProviderConfig,
  Region,
  TelegramConfig,
  UsagePoint,
} from "./types"

/**
 * In-memory stand-in for the Hermes Cloud API. Lives in the browser for the lifetime of the
 * page, simulates lifecycle transitions with timers, and enforces the same action guards as the
 * backend's InstanceService so the UI behaves the same against either.
 */

export const MOCK_TENANT_ID = "00000000-0000-4000-8000-000000000001"

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
      kind: "nibierouter",
      providerName: null,
      baseUrl: null,
      keyHint: null,
      status: status === "STOPPED" ? "untested" : "connected",
      statusMessage: null,
      updatedAt: iso(ageMs - 60_000),
    })
    telegrams.set(id, {
      configured: status === "ACTIVE",
      botUsername: status === "ACTIVE" ? `${name.replace(/-/g, "_")}_bot` : null,
      tokenHint: status === "ACTIVE" ? "…x9Qa" : null,
      mode: "polling",
      verified: status === "ACTIVE",
      allowlist: status === "ACTIVE" ? ["@owner"] : [],
      updatedAt: status === "ACTIVE" ? iso(ageMs - 120_000) : null,
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
        kind: "nibierouter",
        providerName: null,
        baseUrl: null,
        keyHint: null,
        status: "untested",
        statusMessage: null,
        updatedAt: iso(),
      })
      telegrams.set(id, {
        configured: false,
        botUsername: null,
        tokenHint: null,
        mode: "polling",
        verified: false,
        allowlist: [],
        updatedAt: null,
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
          "Sign in with your Hermes Cloud account; the gateway API key is managed for you and never shown.",
          "To chat from your phone, connect a Telegram bot under Configuration.",
        ],
      }
    },
    async subscription(id) {
      await wait()
      const row = previewRow(id)
      const start = new Date(row.instance.createdAt)
      const end = new Date(start.getTime() + 30 * DAY)
      return {
        planId: row.meta.planId,
        state: "active",
        billingCycle: "monthly",
        currentPeriodStart: start.toISOString(),
        currentPeriodEnd: end.toISOString(),
        graceEndsAt: null,
        retentionEndsAt: null,
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
      if (input.kind === "byok") {
        if (!input.providerName) throw new ApiError(400, "validation_error", "Choose a provider")
        const prev = providers.get(id)
        if (!input.apiKey && !(prev?.kind === "byok" && prev.keyHint)) {
          throw new ApiError(400, "validation_error", "Enter an API key")
        }
        if (input.baseUrl) {
          let u: URL
          try {
            u = new URL(input.baseUrl)
          } catch {
            throw new ApiError(400, "validation_error", "Base URL must be a valid https URL")
          }
          if (u.protocol !== "https:") throw new ApiError(400, "validation_error", "Base URL must use https")
        }
      }
      const prev = providers.get(id)
      const next: ProviderConfig = {
        id: prev?.id ?? uuid(),
        kind: input.kind,
        providerName: input.kind === "byok" ? input.providerName ?? null : null,
        baseUrl: input.kind === "byok" ? input.baseUrl || null : null,
        keyHint:
          input.kind === "byok"
            ? input.apiKey
              ? `…${input.apiKey.slice(-4)}`
              : prev?.keyHint ?? null
            : null,
        status: "untested",
        statusMessage: null,
        updatedAt: iso(),
      }
      providers.set(id, next)
      return next
    },
    async testProvider(id) {
      await wait()
      await delay(latency > 0 ? 600 : 0)
      const prev = providers.get(id)!
      const next: ProviderConfig = { ...prev, status: "connected", statusMessage: "Test request succeeded", updatedAt: iso() }
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
      const prev = telegrams.get(id)!
      if (input.token !== undefined && input.token !== "" && !/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(input.token)) {
        throw new ApiError(400, "validation_error", "That does not look like a BotFather token")
      }
      if (!input.token && !prev.configured) throw new ApiError(400, "validation_error", "Enter your bot token")
      const next: TelegramConfig = {
        configured: true,
        botUsername: input.token ? "your_hermes_bot" : prev.botUsername,
        tokenHint: input.token ? `…${input.token.slice(-4)}` : prev.tokenHint,
        mode: input.mode,
        verified: input.token ? false : prev.verified,
        allowlist: input.allowlist,
        updatedAt: iso(),
      }
      telegrams.set(id, next)
      return next
    },
    async verifyTelegram(id) {
      await wait()
      await delay(latency > 0 ? 600 : 0)
      const next = { ...telegrams.get(id)!, verified: true, updatedAt: iso() }
      telegrams.set(id, next)
      return next
    },
    async removeTelegram(id) {
      await wait()
      const next: TelegramConfig = {
        configured: false,
        botUsername: null,
        tokenHint: null,
        mode: "polling",
        verified: false,
        allowlist: [],
        updatedAt: iso(),
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

  return { mode: "mock", instances, preview }
}

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
