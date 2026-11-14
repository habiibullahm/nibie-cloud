import { ApiError, type HermesApi } from "./client"
import { buildInstancesApi, makeCall } from "./live"
import type { Account, Plan } from "./types"

/** Shapes returned by the backend customer API (src/http/customer-routes.ts). */
interface MeBody {
  id: string
  email: string
  tenantId: string
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
  }
}

export function toAccount(m: MeBody): Account {
  return { name: m.email.split("@")[0] ?? m.email, email: m.email }
}

/**
 * Browser client for the backend customer API: every call carries the signed-in user's Supabase access
 * token, and the backend derives the tenant from it. Only the instance endpoints, /me and /plans exist
 * there, so those are real; everything else is taken from `preview` (mock data, labelled in the UI).
 */
export function createCustomerApi(opts: {
  baseUrl: string
  getToken: () => Promise<string | null>
  preview: HermesApi["preview"]
}): HermesApi {
  const call = makeCall(opts.baseUrl.replace(/\/+$/, "") + "/api/v1", async () => {
    const token = await opts.getToken()
    if (!token) throw new ApiError(401, "unauthorized", "Sign in to continue.")
    return { authorization: `Bearer ${token}` }
  })
  const realPlans = async () => (await call<{ plans: PlanBody[] }>("/plans")).plans.map(toPlan)

  /**
   * Preview rows (meta, subscription) are synthesized from the mock plans. Point them at the real plan
   * with the same slug (or the first one), so the preview pages can still find their plan.
   */
  async function remapPlanId(planId: string): Promise<string> {
    const [real, sample] = await Promise.all([realPlans(), opts.preview.plans()])
    const slug = sample.find((p) => p.id === planId)?.slug
    return (real.find((p) => p.slug === slug) ?? real[0])?.id ?? planId
  }

  return {
    mode: "customer",
    instances: buildInstancesApi(call),
    preview: {
      ...opts.preview,
      me: async () => toAccount(await call<MeBody>("/me")),
      plans: realPlans,
      meta: async (id) => {
        const m = await opts.preview.meta(id)
        return m && { ...m, planId: await remapPlanId(m.planId) }
      },
      subscription: async (id) => {
        const s = await opts.preview.subscription(id)
        return { ...s, planId: await remapPlanId(s.planId) }
      },
    },
  }
}
