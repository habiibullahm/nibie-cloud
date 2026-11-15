"use client"

import { useQuery } from "@tanstack/react-query"
import { ApiError } from "@/lib/api"
import { getAdminApi, type AdminApi } from "@/lib/api/admin"
/**
 * Whether the signed-in account is an admin, asked of the backend.
 *
 * `403` is an answer ("not an admin"), not an error: it is cached as a negative result so the
 * dashboard does not probe on every page. Any other failure is surfaced as an error so a real
 * outage is not mistaken for "no access".
 */
export function useAdminMe() {
  return useQuery({
    queryKey: ["admin", "me"],
    queryFn: async () => {
      try {
        return { admin: await getAdminApi().me() }
      } catch (e) {
        if (e instanceof ApiError && (e.status === 403 || e.status === 401)) return { admin: null }
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
