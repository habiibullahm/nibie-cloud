"use client"

import { useQuery } from "@tanstack/react-query"
import { ApiError } from "@/lib/api"
import { getAdminApi, type AdminApi } from "@/lib/api/admin"
/**
 * Status and code of an API error. The admin client builds its errors as plain `Error`s named "ApiError" (it does not
 * import the class), so `instanceof` alone would miss them.
 */
function apiErrorOf(e: unknown): { status: number; code: string } | null {
  if (e instanceof ApiError) return { status: e.status, code: e.code }
  const o = e as { name?: unknown; status?: unknown; code?: unknown } | null
  return o && o.name === "ApiError" && typeof o.status === "number" ? { status: o.status, code: typeof o.code === "string" ? o.code : "" } : null
}

/**
 * Whether the signed-in account is an admin, asked of the backend.
 *
 * `403` is an answer, not an error: `mfa_required` means "an admin who still has to give the second factor", any other
 * 403 (or 401) means "not an admin". Both are cached so the dashboard does not probe on every page. Any other failure is
 * surfaced as an error so a real outage is not mistaken for "no access".
 */
export function useAdminMe() {
  return useQuery({
    queryKey: ["admin", "me"],
    queryFn: async () => {
      try {
        return { admin: await getAdminApi().me(), mfaRequired: false }
      } catch (e) {
        const err = apiErrorOf(e)
        if (err?.status === 403 && err.code === "mfa_required") return { admin: null, mfaRequired: true }
        if (err && (err.status === 403 || err.status === 401)) return { admin: null, mfaRequired: false }
        throw e
      }
    },
    staleTime: 60_000,
    retry: false,
  })
}

export const adminKeys = {
  overview: ["admin", "overview"] as const,
  system: ["admin", "system"] as const,
  customers: (q: string) => ["admin", "customers", q] as const,
  customer: (id: string) => ["admin", "customer", id] as const,
  instances: (status: string) => ["admin", "instances", status] as const,
  instance: (id: string) => ["admin", "instance", id] as const,
  plans: ["admin", "plans"] as const,
  nodes: ["admin", "nodes"] as const,
  waitlist: ["admin", "waitlist"] as const,
  subscriptions: ["admin", "subscriptions"] as const,
  payments: ["admin", "payments"] as const,
  audit: ["admin", "audit"] as const,
}

const LONG = 30_000

export function useAdminOverview() {
  return useQuery({ queryKey: adminKeys.overview, queryFn: () => getAdminApi().overview(), staleTime: LONG })
}

export function useAdminSystem() {
  return useQuery({ queryKey: adminKeys.system, queryFn: () => getAdminApi().system(), staleTime: LONG })
}

export function useAdminCustomers(q: string) {
  return useQuery({ queryKey: adminKeys.customers(q), queryFn: () => getAdminApi().customers(q), staleTime: LONG })
}

export function useAdminCustomer(id: string) {
  return useQuery({ queryKey: adminKeys.customer(id), queryFn: () => getAdminApi().customer(id), staleTime: LONG })
}

export function useAdminInstances(status: string) {
  return useQuery({ queryKey: adminKeys.instances(status), queryFn: () => getAdminApi().instances(status || undefined), staleTime: LONG })
}

export function useAdminInstance(id: string) {
  return useQuery({ queryKey: adminKeys.instance(id), queryFn: () => getAdminApi().instance(id), staleTime: LONG })
}

export function useAdminPlans() {
  return useQuery({ queryKey: adminKeys.plans, queryFn: () => getAdminApi().plans(), staleTime: LONG })
}

export function useAdminNodes() {
  return useQuery({ queryKey: adminKeys.nodes, queryFn: () => getAdminApi().nodes(), staleTime: LONG })
}

export function useAdminWaitlist() {
  return useQuery({ queryKey: adminKeys.waitlist, queryFn: () => getAdminApi().waitlist(), staleTime: LONG })
}

export function useAdminSubscriptions() {
  return useQuery({ queryKey: adminKeys.subscriptions, queryFn: () => getAdminApi().subscriptions(), staleTime: LONG })
}

export function useAdminPayments() {
  return useQuery({ queryKey: adminKeys.payments, queryFn: () => getAdminApi().payments(), staleTime: LONG })
}

export function useAdminAudit() {
  return useQuery({ queryKey: adminKeys.audit, queryFn: () => getAdminApi().audit(), staleTime: LONG })
}

export type { AdminApi }
