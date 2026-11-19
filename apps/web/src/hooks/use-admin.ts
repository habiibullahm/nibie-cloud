"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ApiError } from "@/lib/api"
import { getAdminApi, type AdminApi } from "@/lib/api/admin"
import type { TicketStatus } from "@/lib/api/tickets"
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
export function useAdminMe(enabled = true) {
  return useQuery({
    enabled,
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
  betaInvites: ["admin", "beta-invites"] as const,
  apiKeys: ["admin", "api-keys"] as const,
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

export function useSetPlanStock() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, stockLimit, reason }: { id: string; stockLimit: number | null; reason: string }) =>
      getAdminApi().setPlanStock(id, stockLimit, reason),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: adminKeys.plans })
      void qc.invalidateQueries({ queryKey: adminKeys.audit })
    },
  })
}

export function useAdminTickets(status: TicketStatus | undefined) {
  return useQuery({ queryKey: ["admin", "tickets", status ?? "all"], queryFn: () => getAdminApi().tickets(status), refetchInterval: 30_000 })
}

export function useAdminTicket(id: string) {
  return useQuery({ queryKey: ["admin", "ticket", id], queryFn: () => getAdminApi().ticket(id), refetchInterval: 30_000 })
}

/** Reply or close: both refresh the ticket, the list, the Ringkasan count and the audit list. */
export function useAdminTicketAction(id: string) {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["admin", "ticket", id] })
    void qc.invalidateQueries({ queryKey: ["admin", "tickets"] })
    void qc.invalidateQueries({ queryKey: adminKeys.overview })
    void qc.invalidateQueries({ queryKey: adminKeys.audit })
  }
  return {
    reply: useMutation({ mutationFn: (message: string) => getAdminApi().replyTicket(id, message), onSuccess: refresh }),
    close: useMutation({ mutationFn: () => getAdminApi().closeTicket(id), onSuccess: refresh }),
  }
}

/** Saves the support contacts (empty string clears one); the public contact query is refreshed for every page. */
export function useSetSupportContact() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { whatsapp: string; email: string; groupUrl: string }) => getAdminApi().setSupportContact(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["support-contact"] })
      void qc.invalidateQueries({ queryKey: adminKeys.audit })
    },
  })
}

export function useAdminBetaInvites() {
  return useQuery({ queryKey: adminKeys.betaInvites, queryFn: () => getAdminApi().betaInvites(), staleTime: LONG })
}

/** A change shows in the list and in the audit trail, so both are refetched. */
function useRefreshAfterInviteChange() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: adminKeys.betaInvites })
    void qc.invalidateQueries({ queryKey: adminKeys.audit })
  }
}

export function useAddBetaInvite() {
  const refresh = useRefreshAfterInviteChange()
  return useMutation({
    mutationFn: (input: { email: string; note?: string; reason: string }) => getAdminApi().addBetaInvite(input),
    onSuccess: refresh,
  })
}

export function useRevokeBetaInvite() {
  const refresh = useRefreshAfterInviteChange()
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => getAdminApi().revokeBetaInvite(id, reason),
    onSuccess: refresh,
  })
}

export function useAdminApiKeys() {
  return useQuery({ queryKey: adminKeys.apiKeys, queryFn: () => getAdminApi().apiKeys(), staleTime: LONG })
}

function useRefreshAfterKeyChange() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: adminKeys.apiKeys })
    void qc.invalidateQueries({ queryKey: adminKeys.audit })
  }
}

export function useCreateApiKey() {
  const refresh = useRefreshAfterKeyChange()
  return useMutation({
    mutationFn: (input: { name: string; expiresInDays: number | null; reason: string }) => getAdminApi().createApiKey(input),
    onSuccess: refresh,
  })
}

export function useRevokeApiKey() {
  const refresh = useRefreshAfterKeyChange()
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => getAdminApi().revokeApiKey(id, reason),
    onSuccess: refresh,
  })
}

export type { AdminApi }
