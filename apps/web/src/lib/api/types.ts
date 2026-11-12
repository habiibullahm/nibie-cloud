/**
 * Wire types for the Hermes Cloud API.
 *
 * "Backed" types mirror what the backend returns today (src/http/server.ts, InstanceView in
 * src/modules/instances/instance-service.ts). "Preview" types describe PRD §15 endpoints that do
 * not exist yet; the dashboard serves them from the in-memory mock and labels them as preview data.
 */

/** Backend InstanceStatus (prisma/schema.prisma). */
export const BACKEND_STATUSES = [
  "PENDING",
  "PROVISIONING",
  "CONFIGURING",
  "STARTING",
  "ACTIVE",
  "DEGRADED",
  "STOPPING",
  "STOPPED",
  "FAILED",
  "DELETING",
  "DELETED",
] as const
export type BackendStatus = (typeof BACKEND_STATUSES)[number]

/** Subscription-driven state from PRD §4.4; not produced by the backend yet. */
export type InstanceStatus = BackendStatus | "SUSPENDED"

/** Mirrors InstanceView. Dates arrive as ISO strings over JSON. */
export interface Instance {
  id: string
  tenantId: string
  name: string
  status: InstanceStatus
  statusReason: string | null
  accessUrl: string | null
  createdAt: string
}

export interface InstanceStatusView {
  status: InstanceStatus
  statusReason: string | null
  accessUrl: string | null
}

export interface InstanceEvent {
  type: string
  message: string
  createdAt: string
}

export interface CreateInstanceInput {
  name: string
  planId: string
}

export interface ApiErrorBody {
  error: { code: string; message: string }
}

// ── Preview-only types (PRD §15, no backend endpoint yet) ────────────────────

/** Resource limits only; pricing is not approved (PRD §5.2). Mirrors the Plan model. */
export interface Plan {
  id: string
  slug: string
  name: string
  cpuMillis: number
  memoryMb: number
  storageMb: number
  pids: number
  backupRetentionDays: number
  customDomain: boolean
  /** null until pricing is approved. */
  monthlyPriceIdr: number | null
}

export interface Region {
  id: string
  name: string
  code: string
  /** Scheduler can place a new instance here (PRD §4.2: do not advertise otherwise). */
  hasCapacity: boolean
}

/** Preview metadata the dashboard needs that InstanceView does not carry yet. */
export interface InstanceMeta {
  planId: string
  regionId: string
  runtime: "runc" | "runsc"
  image: string
}

export type SubscriptionState =
  | "active"
  | "cancel_scheduled"
  | "grace"
  | "suspended"
  | "expired"

export interface Subscription {
  planId: string
  state: SubscriptionState
  billingCycle: "monthly"
  currentPeriodStart: string
  currentPeriodEnd: string
  graceEndsAt: string | null
  retentionEndsAt: string | null
}

export interface UsagePoint {
  t: string
  cpuPct: number
  memoryMb: number
  diskMb: number
  netInKbps: number
  netOutKbps: number
}

export interface Usage {
  uptimeSeconds: number
  points: UsagePoint[]
}

export type LogLevel = "debug" | "info" | "warn" | "error"
export interface LogLine {
  t: string
  level: LogLevel
  source: "hermes" | "gateway" | "runtime"
  message: string
}

export type ProviderKind = "nibierouter" | "byok"
export interface ProviderConfig {
  id: string
  kind: ProviderKind
  /** BYOK only. */
  providerName: string | null
  baseUrl: string | null
  /** Never the key itself: last four characters only (PRD §7.4). */
  keyHint: string | null
  status: "connected" | "untested" | "error"
  statusMessage: string | null
  updatedAt: string
}

export interface TelegramConfig {
  configured: boolean
  botUsername: string | null
  tokenHint: string | null
  mode: "polling" | "webhook"
  verified: boolean
  allowlist: string[]
  updatedAt: string | null
}

export interface FileEntry {
  name: string
  /** Path relative to the tenant volume root; never a host path. */
  path: string
  type: "file" | "dir"
  size: number
  modifiedAt: string
}

export interface Backup {
  id: string
  createdAt: string
  sizeMb: number
  status: "completed" | "running" | "failed"
  kind: "scheduled" | "manual" | "pre-upgrade"
  checksum: string
}

export interface AccessInfo {
  url: string | null
  instructions: string[]
}

export interface Account {
  name: string
  email: string
}
