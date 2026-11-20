/**
 * Wire types for the Nibie Cloud API.
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
  planId: string
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
  /** null when the backend does not report it yet. */
  backupRetentionDays: number | null
  customDomain: boolean | null
  /** null until pricing is approved. */
  monthlyPriceIdr: number | null
  /** One-time AI credit (US$) that comes with the first payment; null when the plan has none. */
  includedCreditUsd: number | null
  /** Whether this account can take the plan now; the deploy page shows the others as out of stock. */
  available: boolean
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

/** One chat model NibieRouter offers (backend `GET /instances/:id/models`). Prices are US$ per 1 million tokens. */
export interface RouterModel {
  id: string
  name: string
  contextLength: number | null
  promptUsdPerM: number
  completionUsdPerM: number
  free: boolean
}
export interface RouterModels {
  /** The instance is on a free plan: only free models are listed and allowed. */
  freeOnly: boolean
  models: RouterModel[]
}

export interface ProviderConfig {
  /** Empty while nothing is configured yet (`configured` is false). */
  id: string
  configured: boolean
  kind: ProviderKind
  /** BYOK preset the base URL matches (see providers.ts); "custom" for any other URL. */
  providerName: string | null
  baseUrl: string | null
  /** Model name Hermes uses; the backend requires it. */
  model: string | null
  /** Never the key itself: last four characters only (PRD §7.4). Null for the NibieRouter key. */
  keyHint: string | null
  status: "connected" | "untested" | "error"
  statusMessage: string | null
  /** When the connection was last tested; null until the first test. */
  lastTestedAt: string | null
  /** The running container was not recreated since the last change (backend `restartRequired`). */
  restartRequired: boolean
}

export interface TelegramConfig {
  configured: boolean
  botUsername: string | null
  tokenHint: string | null
  /** The last test message was delivered. */
  verified: boolean
  statusMessage: string | null
  /** Numeric Telegram user IDs; the backend denies everyone else. */
  allowlist: string[]
  verifiedAt: string | null
  restartRequired: boolean
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
  /** On the backend's admin allowlist. Only decides whether the dashboard asks `/admin/me`; the backend guards the rest. */
  admin?: boolean
}

// ── Billing (backend milestone D: src/modules/billing, src/http/billing-routes.ts) ────────────────────

export type BillingStatus = "PENDING_PAYMENT" | "ACTIVE" | "GRACE" | "SUSPENDED" | "ENDED"
export type PaymentStatus = "PENDING" | "PAID" | "FAILED" | "EXPIRED"
export type PaymentPurpose = "NEW" | "RENEWAL"

/** Mirrors PaymentView. `paymentUrl` is only set while the SumoPod invoice can still be paid. */
export interface BillingPayment {
  id: string
  subscriptionId: string
  status: PaymentStatus
  purpose: PaymentPurpose
  /** QRIS through SumoPod, or WALLET when paid from the Nibie Cloud balance. */
  method: PaymentMethod
  amountIdr: number
  paymentUrl: string | null
  expiresAt: string
  paidAt: string | null
}

export type PaymentMethod = "QRIS" | "WALLET"

/** Mirrors SubscriptionView. `instanceId` is null until the first payment is verified. */
export interface BillingSubscription {
  id: string
  planId: string
  planName: string
  instanceId: string | null
  name: string
  status: BillingStatus
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  /** Renew from the wallet near the end of the period (when the backend has auto-renew on). */
  autoRenew: boolean
  graceEndsAt: string | null
  retentionEndsAt: string | null
  createdAt: string
  latestPayment: BillingPayment | null
}

export interface CheckoutResult {
  subscription: BillingSubscription
  payment: BillingPayment
}

/** Mirrors TopupView: one QRIS top-up of the Nibie Cloud wallet. `paymentUrl` only while it can still be paid. */
export interface WalletTopup {
  id: string
  amountIdr: number
  status: PaymentStatus
  paymentUrl: string | null
  expiresAt: string
  paidAt: string | null
  createdAt: string
}

export type WalletEntryKind = "TOPUP" | "HOSTING" | "AUTO_RENEW" | "AI_CREDIT" | "ADMIN_CREDIT" | "ADMIN_DEBIT"

/** One ledger row. `amountIdr` is signed: positive adds, negative takes. */
export interface WalletEntry {
  id: string
  amountIdr: number
  kind: WalletEntryKind
  balanceAfterIdr: number
  note: string | null
  createdAt: string
}

/** Mirrors WalletView: the balance (saldo, whole rupiah), its limits, and recent history. */
export interface Wallet {
  balanceIdr: number
  /** The backend renews subscriptions from this balance (WALLET_AUTO_RENEW). */
  autoRenew: boolean
  limits: { topupMinIdr: number; topupMaxIdr: number; maxBalanceIdr: number }
  entries: WalletEntry[]
  topups: WalletTopup[]
}

export type InvoiceKind = "HOSTING_NEW" | "HOSTING_RENEWAL" | "TOPUP"

/** A paid hosting payment or top-up (`GET /invoices`). Plan and instance names are as they were when it was paid. */
export interface Invoice {
  id: string
  /** INV/<year>/<month>/<seq>, numbered per month in Asia/Jakarta time. */
  number: string
  kind: InvoiceKind
  planName: string | null
  instanceName: string | null
  amountIdr: number
  paidAt: string
  /** SumoPod's payment reference, when it sent one. */
  reference: string | null
  method: PaymentMethod
  /** Only on `GET /invoices/:id`: the account owner's email. */
  billedTo?: string | null
}
