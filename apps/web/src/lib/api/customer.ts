import { ApiError, type HermesApi } from "./client"
import { buildIntegrationsApi } from "./integrations"
import { buildBillingApi, buildInstancesApi, makeCall } from "./live"
import { buildTicketsApi } from "./tickets"
import type { Account, Plan } from "./types"

/** Shapes returned by the backend customer API (src/http/customer-routes.ts). */
interface MeBody {
  id: string
  email: string
  tenantId: string
  admin?: boolean
}
interface PlanBody {
  id: string
  slug: string
  name: string
  cpuMillis: number
  memoryMb: number
  storageMb: number
  pids: number
  monthlyPriceIdr: number | null
  includedCreditUsd?: number | null
  available?: boolean
}

export function toPlan(p: PlanBody): Plan {
  // The API does not carry backup retention or a custom-domain flag yet, so those stay unknown (null)
  // instead of being invented here.
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    cpuMillis: p.cpuMillis,
    memoryMb: p.memoryMb,
    storageMb: p.storageMb,
    pids: p.pids,
    backupRetentionDays: null,
    customDomain: null,
    monthlyPriceIdr: p.monthlyPriceIdr,
    includedCreditUsd: p.includedCreditUsd ?? null,
    // An older backend lists only the plans the account may take and sends no flag.
    available: p.available ?? true,
  }
}

export function toAccount(m: MeBody): Account {
  return { name: m.email.split("@")[0] ?? m.email, email: m.email, admin: m.admin === true }
}

/**
 * Browser client for the backend customer API: every call carries the signed-in user's Supabase access
 * token, and the backend derives the tenant from it. The instance endpoints, billing, /me, /plans, the
 * provider and Telegram settings and the logs are real. Nothing here falls back to sample data: an endpoint
 * without a backend answers empty or rejects with `not_available` (customers must never see preview data).
 */
export function createCustomerApi(opts: { baseUrl: string; getToken: () => Promise<string | null> }): HermesApi {
  const call = makeCall(opts.baseUrl.replace(/\/+$/, "") + "/api/v1", async () => {
    const token = await opts.getToken()
    if (!token) throw new ApiError(401, "unauthorized", "Sign in to continue.")
    return { authorization: `Bearer ${token}` }
  })
  const realPlans = async () => (await call<{ plans: PlanBody[] }>("/plans")).plans.map(toPlan)
  const notAvailable = () => Promise.reject(new ApiError(501, "not_available", "This feature is not available yet."))

  return {
    mode: "customer",
    instances: buildInstancesApi(call),
    billing: buildBillingApi(call),
    tickets: buildTicketsApi(call),
    preview: {
      ...buildIntegrationsApi(call),
      me: async () => toAccount(await call<MeBody>("/me")),
      plans: realPlans,
      // No backend for these yet. The pages that need them are hidden in customer mode (instance-frame.tsx).
      regions: async () => [],
      meta: async () => null,
      access: notAvailable,
      usage: notAvailable,
      files: notAvailable,
      fileContent: notAvailable,
      backups: notAvailable,
      createBackup: notAvailable,
    },
  }
}
