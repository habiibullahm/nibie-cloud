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
  /** Which gateway is active: `sumopod`, `duitku`, `both`, or null when billing is off. */
  billingGateway: "sumopod" | "duitku" | "both" | null
  router: boolean
  mail: boolean
  redis: boolean
  customerApi: boolean
  adminEmails: number
}

export interface AdminOverview {
  counts: {
    customers: number
    instances: number
    subscriptions: number
    pendingPayments: number
    activeInstances: number
    failedInstances: number
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
