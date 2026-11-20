/**
 * Wire types for the admin API (`src/http/admin-routes.ts`).
 *
 * Read-only in Fase A: every endpoint here is a GET. The panel never sees a credential — the backend
 * never selects a `Secret` column for an admin read (see `test/unit/secrets-boundary.test.ts`).
 */

export interface AdminMe {
  id: string
  email: string
  aal: "aal1" | "aal2"
}

export interface AdminSystem {
  billing: boolean
  /** The payment gateway (`sumopod`), or null when billing is off. */
  billingGateway: "sumopod" | null
  router: boolean
  mail: boolean
  redis: boolean
  customerApi: boolean
  /** `FREE_BETA_SLOTS`: 0 means the free beta (and its waiting list) is off. */
  freeBetaSlots: number
  adminEmails: number
  /** The Pengaturan page: read from the server env. Modes, counts and names only, never a secret. */
  settings: AdminSettings
}

export interface AdminSettings {
  billing: {
    gateway: "sumopod" | null
    paidCheckoutOpen: boolean
    /** WALLET_ENABLED: customer top-ups and the admin wallet adjustment. Absent on an older backend. */
    walletEnabled?: boolean
    sumopod: { env: "sandbox" | "production"; webhookSigned: boolean } | null
  }
  email: { configured: boolean; from: string | null }
  signIn: {
    supabase: boolean
    adminEmails: number
    betaAllowedEmails: number
    freeBetaSlots: number
    turnstile: boolean
    maxInstancesPerTenant: number
    maxTotalInstances: number | null
  }
  ai: {
    configured: boolean
    defaultModel: string | null
    userEmailDomain: string | null
    /** Rupiah per US$1 for AI credit: the admin override (null: none) and the router's own rate. Null without NibieRouter. */
    creditRate?: { adminIdrPerUsd: number | null; routerIdrPerUsd: number | null } | null
  }
  /** Path of the admin MCP endpoint on the API origin. */
  mcpPath: string
}

/** An admin API key as the list shows it. The key itself is only ever in `AdminApiKeyCreated`. */
export interface AdminApiKey {
  id: string
  name: string
  /** First characters of the key, to recognise it. */
  prefix: string
  createdByEmail: string
  createdAt: string
  /** Null: no expiry. */
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
}

export interface AdminApiKeyCreated {
  key: AdminApiKey
  /** Shown once; the backend keeps only a hash. */
  plaintext: string
}

export interface AdminOverview {
  counts: {
    customers: number
    instances: number
    subscriptions: number
    pendingPayments: number
    activeInstances: number
    failedInstances: number
    /** Tickets waiting for the team (status OPEN). */
    openTickets: number
  }
  byStatus: Record<string, number>
  system: { billing: boolean; router: boolean; redis: boolean }
}

export interface AdminCustomer {
  tenantId: string
  name: string
  createdAt: string
  email: string | null
  userId: string | null
  instanceCount: number
}

/** The detail route adds the account row and whether a router user exists — never the router key. */
export interface AdminCustomerDetail {
  tenantId: string
  name: string
  createdAt: string
  email: string | null
  user: { id: string; email: string; createdAt: string } | null
  hasRouterUser: boolean
}

/** A customer's wallet (saldo, IDR) and its latest 50 entries, as the customer detail returns it. */
export interface AdminWallet {
  balanceIdr: number
  entries: { id: string; amountIdr: number; kind: string; balanceAfterIdr: number; note: string | null; createdAt: string }[]
}

/** Instance row as the customer detail returns it: plan and node are nested. */
export interface AdminCustomerInstance {
  id: string
  name: string
  status: string
  statusReason: string | null
  createdAt: string
  diskUsedBytes: string | number | null
  diskLevel: string
  plan: { slug: string; name: string }
  node: { name: string }
}

export interface AdminInstance {
  id: string
  name: string
  status: string
  statusReason: string | null
  createdAt: string
  updatedAt: string
  diskUsedBytes: string | number | null
  diskLevel: string
  recoveryAttempts: number
  tenantId: string
  email: string | null
  plan: string
  node: string
}

export interface AdminInstanceDetail {
  id: string
  name: string
  status: string
  statusReason: string | null
  image: string
  hostPort: number | null
  createdAt: string
  updatedAt: string
  lastHealthAt: string | null
  diskUsedBytes: string | number | null
  diskLevel: string
  consecutiveFailures: number
  recoveryAttempts: number
  nextRecoveryAt: string | null
  configRevision: number
  appliedRevision: number
  tenantId: string
  email: string | null
  plan: { slug: string; name: string; cpuMillis: number; memoryMb: number; storageMb: number; pids: number }
  node: { name: string; region: string }
  /** Whether a provider is attached and which kind — never the key. */
  provider: { kind: string; baseUrl: string; model: string; status: string; lastTestedAt: string | null; lastErrorCode: string | null } | null
  telegram: { botUsername: string; status: string; verifiedAt: string | null; lastErrorCode: string | null } | null
}

export interface AdminEvent {
  id: string
  type: string
  message: string
  createdAt: string
}

export interface AdminPlan {
  id: string
  slug: string
  name: string
  active: boolean
  cpuMillis: number
  memoryMb: number
  pids: number
  storageMb: number
  monthlyPriceIdr: number | null
  includedCreditNano: string | null
  includedCreditUsd: number | null
  /** Stock of a priced plan; null: no limit. The free plan is limited by FREE_BETA_SLOTS instead. */
  stockLimit: number | null
  /** Instances, paid subscriptions waiting for theirs, and unexpired invoices on this plan. */
  stockUsed: number
  /** Null when the stock does not apply (no limit, or the free plan). */
  stockLeft: number | null
}

export interface AdminNode {
  id: string
  name: string
  region: string
  schedulable: boolean
  instanceCount: number
}

export interface AdminSubscription {
  id: string
  status: string
  instanceId: string | null
  intendedName: string
  currentPeriodEnd: string | null
  graceEndsAt: string | null
  suspendedAt: string | null
  retentionEndsAt: string | null
  cancelAtPeriodEnd: boolean
  restartPending: boolean
  createdAt: string
  plan: { slug: string; monthlyPriceIdr: number | null }
  tenantId: string
  email: string | null
}

export interface AdminPayment {
  id: string
  merchantOrderId: string
  amountIdr: number
  purpose: string
  status: string
  reference: string | null
  resultCode: string | null
  paidAt: string | null
  expiresAt: string
  createdAt: string
  subscriptionId: string
  subscriptionStatus: string
  tenantId: string
  email: string | null
}

export interface AdminAuditEntry {
  id: string
  actorEmail: string
  action: string
  targetType: string | null
  targetId: string | null
  reason: string | null
  detail: unknown
  createdAt: string
}

export interface AdminPage<T> {
  items: T[]
  nextCursor: string | null
}

/** A page of one of the paged collections, normalized to the same shape. */
export type AdminPageKey = "customers" | "instances" | "subscriptions" | "payments"

export interface AdminWaitlistEntry {
  id: string
  name: string
  email: string
  useCase: string
  /** UNCONFIRMED: joined, email not confirmed yet; not in the queue and deleted after 24 hours. */
  status: "UNCONFIRMED" | "WAITING" | "INVITED" | "REGISTERED"
  createdAt: string
  confirmedAt: string | null
  invitedAt: string | null
  inviteExpiresAt: string | null
  inviteFailures: number
  registeredAt: string | null
  /** INVITED and the claim window has passed without a registration. */
  lapsed: boolean
}

export interface AdminBetaInvite {
  id: string
  email: string
  note: string | null
  /** Admin who added it; null for a row made by hand. */
  addedBy: string | null
  createdAt: string
  /** Set once revoked; the row stays for the history. */
  revokedAt: string | null
}

export interface AdminBetaInvites {
  /** Newest first, revoked ones included. */
  invites: AdminBetaInvite[]
  /** Set in `BETA_ALLOWED_EMAILS` on the host; read only here. */
  fromEnv: string[]
  freeBetaSlots: number
}

export interface AdminWaitlist {
  counts: { unconfirmed: number; waiting: number; invited: number; lapsed: number; registered: number }
  freeBetaSlots: number
  /** Oldest first: the order in which free slots are offered. */
  entries: AdminWaitlistEntry[]
}
