import type { ApiError } from "./client"
import type {
  AdminApiKey,
  AdminApiKeyCreated,
  AdminAuditEntry,
  AdminBetaInvite,
  AdminBetaInvites,
  AdminCustomer,
  AdminCustomerDetail,
  AdminCustomerInstance,
  AdminInstance,
  AdminInstanceDetail,
  AdminMe,
  AdminNode,
  AdminOverview,
  AdminPage,
  AdminPayment,
  AdminPlan,
  AdminSubscription,
  AdminSystem,
  AdminWaitlist,
} from "./admin-types"

export interface AdminFailedJob {
  id: string
  reason?: string
}

/**
 * Browser client for the admin API (`/api/v1/admin/*`). Every call carries the signed-in user's
 * Supabase access token; the backend checks `ADMIN_EMAILS` and answers 403 for everyone else. The UI
 * must render nothing until `/me` has answered 200 — the guard is server-side, not here.
 */
export interface AdminApi {
  me(): Promise<AdminMe>
  system(): Promise<AdminSystem>
  overview(): Promise<AdminOverview>
  customers(q: string, cursor?: string): Promise<AdminPage<AdminCustomer>>
  customer(tenantId: string): Promise<{ customer: AdminCustomerDetail; instances: AdminCustomerInstance[]; subscriptions: AdminSubscription[]; payments: AdminPayment[] }>
  instances(status: string | undefined, cursor?: string): Promise<AdminPage<AdminInstance>>
  instance(id: string): Promise<{ instance: AdminInstanceDetail; events: { id: string; type: string; message: string; createdAt: string }[] }>
  plans(): Promise<AdminPlan[]>
  /** Changes data: sets a priced plan's stock (null: no limit). Answers 409 `free_plan_stock` for the free plan. */
  setPlanStock(id: string, stockLimit: number | null, reason: string): Promise<Pick<AdminPlan, "id" | "slug" | "stockLimit">>
  /** Changes data: the support contacts on the dashboard's Support page. An empty string clears one. */
  setSupportContact(input: { whatsapp: string; email: string }): Promise<{ whatsapp: string | null; email: string | null }>
  nodes(): Promise<AdminNode[]>
  subscriptions(cursor?: string): Promise<AdminPage<AdminSubscription>>
  payments(cursor?: string): Promise<AdminPage<AdminPayment>>
  audit(cursor?: string): Promise<AdminPage<AdminAuditEntry>>
  /** Read only: the platform invites people by itself. */
  waitlist(): Promise<AdminWaitlist>
  /** Answers 503 `queue_unavailable` when the backend runs without Redis. */
  jobsFailed(): Promise<{ jobs: AdminFailedJob[] }>
  betaInvites(): Promise<AdminBetaInvites>
  /** Changes data: the backend needs a second factor and keeps `reason` in the audit trail. */
  /** `emailSent` is false when the backend has no mail settings or the send failed; the invite is saved either way. */
  addBetaInvite(input: { email: string; note?: string; reason: string }): Promise<AdminBetaInvite & { emailSent: boolean }>
  revokeBetaInvite(id: string, reason: string): Promise<AdminBetaInvite>
  /** Admin keys for scripts and the admin MCP. Only a panel session can manage them, never a key. */
  apiKeys(): Promise<AdminApiKey[]>
  createApiKey(input: { name: string; expiresInDays: number | null; reason: string }): Promise<AdminApiKeyCreated>
  revokeApiKey(id: string, reason: string): Promise<AdminApiKey>
}

/** Shape of every paged admin response: one named array plus a cursor. */
type Paged<K extends string, T> = { [P in K]: T[] } & { nextCursor: string | null }

/** Pulls the named array out of a paged body and renames the cursor, so the UI sees one shape. */
export function toPage<K extends string, T>(body: Paged<K, T>, key: K): AdminPage<T> {
  return { items: body[key], nextCursor: body.nextCursor }
}

export function createAdminApi(opts: {
  baseUrl: string
  getToken: () => Promise<string | null>
  /** Injected so tests and the browser share one code path. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
}): AdminApi {
  const base = opts.baseUrl.replace(/\/+$/, "") + "/api/v1/admin"
  const doFetch = opts.fetchImpl ?? fetch

  async function call<T>(path: string, post?: unknown): Promise<T> {
    const token = await opts.getToken()
    if (!token) throw adminError(401, "unauthorized", "Sign in to continue.")
    const res = await doFetch(base + path, {
      ...(post === undefined ? {} : { method: "POST", body: JSON.stringify(post) }),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(post === undefined ? {} : { "content-type": "application/json" }),
      },
      cache: "no-store",
    })
    const data = (await res.json().catch(() => null)) as (T & { error?: { code: string; message: string } }) | null
    if (!res.ok) throw adminError(res.status, data?.error?.code ?? "http_error", data?.error?.message ?? `Request failed (${res.status})`)
    return data as T
  }

  const qs = (params: Record<string, string | undefined>) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v) p.set(k, v)
    const s = p.toString()
    return s ? `?${s}` : ""
  }

  return {
    me: () => call<AdminMe>("/me"),
    system: () => call<AdminSystem>("/system"),
    overview: () => call<AdminOverview>("/overview"),
    customers: async (q, cursor) => toPage(await call<Paged<"customers", AdminCustomer>>(`/customers${qs({ q, cursor })}`), "customers"),
    customer: (tenantId) => call(`/customers/${encodeURIComponent(tenantId)}`),
    instances: async (status, cursor) => toPage(await call<Paged<"instances", AdminInstance>>(`/instances${qs({ status, cursor })}`), "instances"),
    instance: (id) => call(`/instances/${encodeURIComponent(id)}`),
    plans: async () => (await call<{ plans: AdminPlan[] }>("/plans")).plans,
    setPlanStock: async (id, stockLimit, reason) =>
      (await call<{ plan: Pick<AdminPlan, "id" | "slug" | "stockLimit"> }>(`/plans/${encodeURIComponent(id)}/stock`, { stockLimit, reason })).plan,
    setSupportContact: (input) => call("/support-contact", input),
    nodes: async () => (await call<{ nodes: AdminNode[] }>("/nodes")).nodes,
    subscriptions: async (cursor) => toPage(await call<Paged<"subscriptions", AdminSubscription>>(`/subscriptions${qs({ cursor })}`), "subscriptions"),
    payments: async (cursor) => toPage(await call<Paged<"payments", AdminPayment>>(`/payments${qs({ cursor })}`), "payments"),
    audit: async (cursor) => toPage(await call<Paged<"entries", AdminAuditEntry>>(`/audit${qs({ cursor })}`), "entries"),
    waitlist: () => call<AdminWaitlist>("/waitlist"),
    jobsFailed: () => call<{ jobs: AdminFailedJob[] }>("/jobs/failed"),
    betaInvites: () => call<AdminBetaInvites>("/beta-invites"),
    addBetaInvite: async (input) => {
      const out = await call<{ invite: AdminBetaInvite; emailSent?: boolean }>("/beta-invites", input)
      return { ...out.invite, emailSent: out.emailSent === true }
    },
    revokeBetaInvite: async (id, reason) =>
      (await call<{ invite: AdminBetaInvite }>(`/beta-invites/${encodeURIComponent(id)}/revoke`, { reason })).invite,
    apiKeys: async () => (await call<{ keys: AdminApiKey[] }>("/api-keys")).keys,
    createApiKey: (input) => call<AdminApiKeyCreated>("/api-keys", input),
    revokeApiKey: async (id, reason) =>
      (await call<{ key: AdminApiKey }>(`/api-keys/${encodeURIComponent(id)}/revoke`, { reason })).key,
  }
}

/** Mirrors the dashboard's ApiError without importing it, so this module stays dependency-free. */
function adminError(status: number, code: string, message: string): ApiError {
  const e = new Error(message) as ApiError
  e.name = "ApiError"
  Object.assign(e, { status, code })
  return e
}

let singleton: AdminApi | null = null

/**
 * The admin client for the browser, built once. The base URL is the same public origin the customer
 * API uses; `ADMIN_EMAILS` on the backend is what decides who gets data back.
 */
export function getAdminApi(): AdminApi {
  singleton ??= createAdminApi({
    baseUrl: process.env.NEXT_PUBLIC_HERMES_API_URL ?? "",
    getToken: async () => {
      const { getSupabase } = await import("@/lib/auth/supabase")
      const { data } = (await getSupabase()?.auth.getSession()) ?? { data: null }
      return data?.session?.access_token ?? null
    },
  })
  return singleton
}
