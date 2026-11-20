"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { ApiError, getApi, type CreateInstanceInput, type Instance, type LogLevel, type NewTicket } from "@/lib/api"
import { isTransitional, type InstanceAction } from "@/lib/api/status"
import type { AiAlert } from "@/lib/api/types"
import { authConfigured, getSupabase } from "@/lib/auth/supabase"
import { fetchSupportContact } from "@/lib/support"
import { isPayable } from "@/lib/wallet"

const POLL_MS = 1500

export const keys = {
  instances: ["instances"] as const,
  instance: (id: string) => ["instance", id] as const,
  events: (id: string) => ["events", id] as const,
  meta: (id: string) => ["meta", id] as const,
  plans: ["plans"] as const,
  regions: ["regions"] as const,
  me: ["me"] as const,
  access: (id: string) => ["access", id] as const,
  subscriptions: ["subscriptions"] as const,
  wallet: ["wallet"] as const,
  ai: ["ai"] as const,
  aiKeys: ["ai", "keys"] as const,
  aiModels: ["ai", "models"] as const,
  invoices: ["invoices"] as const,
  invoice: (id: string) => ["invoices", id] as const,
  usage: (id: string, r: string) => ["usage", id, r] as const,
  logs: (id: string, level: string, q: string) => ["logs", id, level, q] as const,
  provider: (id: string) => ["provider", id] as const,
  routerModels: (id: string) => ["router-models", id] as const,
  telegram: (id: string) => ["telegram", id] as const,
  files: (id: string, path: string) => ["files", id, path] as const,
  file: (id: string, path: string) => ["file", id, path] as const,
  backups: (id: string) => ["backups", id] as const,
  supportContact: ["support-contact"] as const,
  displayName: ["auth-user-name"] as const,
}

/**
 * The name the customer chose on Account (Google sign-in fills it too), kept in the Supabase user's metadata; "" when
 * unset. Only asked when auth is configured; the sign-out in auth-gate.tsx clears the cache, so it never leaks across users.
 */
export function useDisplayName() {
  return useQuery({
    queryKey: keys.displayName,
    queryFn: async () => {
      const n = (await getSupabase()?.auth.getUser())?.data.user?.user_metadata?.full_name
      return typeof n === "string" ? n : ""
    },
    enabled: authConfigured(),
  })
}

const ticketKeys = {
  list: ["tickets"] as const,
  one: (id: string) => ["tickets", id] as const,
}

/** The customer's own support tickets. Refreshed every 30 s so a reply shows without reloading. */
export function useTickets() {
  return useQuery({ queryKey: ticketKeys.list, queryFn: () => getApi().tickets.list(), refetchInterval: 30_000 })
}

export function useTicket(id: string) {
  return useQuery({ queryKey: ticketKeys.one(id), queryFn: () => getApi().tickets.get(id), refetchInterval: 30_000 })
}

export function useCreateTicket() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: NewTicket) => getApi().tickets.create(input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ticketKeys.list }),
  })
}

/** Reply or close one ticket: both refresh it and the list. */
export function useTicketAction(id: string) {
  const qc = useQueryClient()
  const refresh = () => void qc.invalidateQueries({ queryKey: ticketKeys.list })
  return {
    reply: useMutation({ mutationFn: (message: string) => getApi().tickets.reply(id, message), onSuccess: refresh }),
    close: useMutation({ mutationFn: () => getApi().tickets.close(id), onSuccess: refresh }),
  }
}

/** Support contacts set on the admin Pengaturan page (public endpoint, no token). */
export function useSupportContact() {
  return useQuery({ queryKey: keys.supportContact, queryFn: () => fetchSupportContact(), staleTime: 60_000 })
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message
  // Not from the API client (a bug in the page, or the sign-in library): name the error so support can tell them apart.
  const name = e instanceof Error && e.name !== "Error" ? ` (${e.name})` : ""
  return `Something went wrong${name}. Try again.`
}

export function useApiMode() {
  return getApi().mode
}

export function useInstances() {
  return useQuery({
    queryKey: keys.instances,
    queryFn: () => getApi().instances.list(),
    refetchInterval: (q) => (q.state.data?.some((i) => isTransitional(i.status)) ? POLL_MS : false),
  })
}

export function useInstance(id: string) {
  return useQuery({
    queryKey: keys.instance(id),
    queryFn: () => getApi().instances.get(id),
    refetchInterval: (q) => (q.state.data && isTransitional(q.state.data.status) ? POLL_MS : false),
  })
}

export function useEvents(id: string, poll: boolean) {
  return useQuery({
    queryKey: keys.events(id),
    queryFn: () => getApi().instances.events(id),
    refetchInterval: poll ? POLL_MS : false,
  })
}

export function useInstanceMeta(id: string) {
  return useQuery({ queryKey: keys.meta(id), queryFn: () => getApi().preview.meta(id) })
}

export function usePlans() {
  return useQuery({ queryKey: keys.plans, queryFn: () => getApi().preview.plans(), staleTime: Infinity })
}

export function useRegions() {
  return useQuery({ queryKey: keys.regions, queryFn: () => getApi().preview.regions(), staleTime: Infinity })
}

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: () => getApi().preview.me(), staleTime: Infinity })
}

export function useAccess(id: string) {
  return useQuery({ queryKey: keys.access(id), queryFn: () => getApi().preview.access(id) })
}

/** All subscriptions of the tenant. Polls while a purchase waits for its payment callback (`poll`). */
export function useSubscriptions(poll = false) {
  return useQuery({
    queryKey: keys.subscriptions,
    queryFn: () => getApi().billing.list(),
    refetchInterval: poll ? 3000 : false,
  })
}

/** The checkout starts a purchase; the caller sends the customer to `payment.paymentUrl`. */
export function useCheckout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ input, idempotencyKey }: { input: CreateInstanceInput; idempotencyKey: string }) =>
      getApi().billing.checkout(input, idempotencyKey),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.subscriptions }),
  })
}

/** Upgrades a free instance; the caller sends the customer to `payment.paymentUrl`. */
export function useUpgrade() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ instanceId, planId, idempotencyKey }: { instanceId: string; planId: string; idempotencyKey: string }) =>
      getApi().billing.upgrade({ instanceId, planId }, idempotencyKey),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.subscriptions }),
    onError: (e) => toast.error(errorMessage(e)),
  })
}

export function useRenew() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (subscriptionId: string) => getApi().billing.renew(subscriptionId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.subscriptions }),
    onError: (e) => toast.error(errorMessage(e)),
  })
}

export function useCancelRenewal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (subscriptionId: string) => getApi().billing.cancel(subscriptionId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.subscriptions })
      toast.success("Renewal cancelled. Your instance keeps running until the end of the paid period.")
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
}

/**
 * The Nibie Cloud wallet; `data` is null when the backend has it off. Polls while a top-up waits for its payment, so the
 * balance updates after the customer comes back from SumoPod.
 */
export function useWallet() {
  return useQuery({
    queryKey: keys.wallet,
    queryFn: () => getApi().billing.wallet(),
    refetchInterval: (q) => (q.state.data?.topups.some((t) => isPayable(t)) ? 3000 : false),
  })
}

/** The NibieRouter (AI) balance and usage in Rupiah; `data` is null when the backend has no NibieRouter. */
export function useAiAccount() {
  return useQuery({ queryKey: keys.ai, queryFn: () => getApi().billing.ai() })
}

export function useSetAiAlert() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (alert: AiAlert) => getApi().billing.setAiAlert(alert),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.ai })
      toast.success("Reminder saved.")
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
}

/** Buys AI credit from the wallet; both balances refresh. A PENDING purchase is delivered by the backend shortly after. */
export function useBuyAiCredit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ amountIdr, idempotencyKey, captchaToken }: { amountIdr: number; idempotencyKey: string; captchaToken?: string }) =>
      getApi().billing.buyAiCredit(amountIdr, idempotencyKey, captchaToken),
    onSuccess: (p) => {
      for (const key of [keys.wallet, keys.ai]) void qc.invalidateQueries({ queryKey: key })
      toast.success(p.status === "DONE" ? "AI credit added." : "Paid. The AI credit arrives in a few minutes.")
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
}

/** The customer's own NibieRouter keys; `data` is null when the backend has no NibieRouter. */
export function useAiKeys() {
  return useQuery({ queryKey: keys.aiKeys, queryFn: () => getApi().billing.aiKeys() })
}

/** The NibieRouter models this account may use; `data` is null when the backend has no NibieRouter. */
export function useAiModels() {
  return useQuery({ queryKey: keys.aiModels, queryFn: () => getApi().billing.aiModels() })
}

/** Errors are left to the caller, which shows them next to the form. */
export function useCreateAiKey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => getApi().billing.createAiKey(name),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.aiKeys }),
  })
}

export function useRevokeAiKey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => getApi().billing.revokeAiKey(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.aiKeys }),
  })
}

/** Starts a top-up; the caller sends the customer to `paymentUrl`. */
export function useTopup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ amountIdr, idempotencyKey }: { amountIdr: number; idempotencyKey: string }) =>
      getApi().billing.topup(amountIdr, idempotencyKey),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.wallet }),
    onError: (e) => toast.error(errorMessage(e)),
  })
}

/** Pays an open hosting invoice from the wallet; the balance, subscriptions and invoices refresh. */
export function useWalletPay() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ paymentId, captchaToken }: { paymentId: string; captchaToken?: string }) =>
      getApi().billing.payWithWallet(paymentId, captchaToken),
    onSuccess: () => {
      for (const key of [keys.subscriptions, keys.wallet, keys.invoices, keys.instances]) void qc.invalidateQueries({ queryKey: key })
      toast.success("Paid from your balance.")
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
}

export function useSetAutoRenew() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ subscriptionId, enabled }: { subscriptionId: string; enabled: boolean }) =>
      getApi().billing.setAutoRenew(subscriptionId, enabled),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.subscriptions }),
    onError: (e) => toast.error(errorMessage(e)),
  })
}

export function useInvoices() {
  return useQuery({ queryKey: keys.invoices, queryFn: () => getApi().billing.invoices() })
}

export function useInvoice(id: string) {
  return useQuery({ queryKey: keys.invoice(id), queryFn: () => getApi().billing.invoice(id) })
}

export function useUsage(id: string, range: "1h" | "24h" | "7d") {
  return useQuery({ queryKey: keys.usage(id, range), queryFn: () => getApi().preview.usage(id, range) })
}

export function useLogs(id: string, level: LogLevel | "all", query: string) {
  return useQuery({
    queryKey: keys.logs(id, level, query),
    queryFn: () => getApi().preview.logs(id, { level, query }),
  })
}

/** Re-reads every few seconds while a saved change waits for the restart that applies it. */
export function useProvider(id: string) {
  return useQuery({
    queryKey: keys.provider(id),
    queryFn: () => getApi().preview.provider(id),
    // Also while no provider is set: a free instance gets its NibieRouter key from the backend shortly after it starts.
    refetchInterval: (q) => (q.state.data?.restartRequired || q.state.data?.configured === false ? POLL_MS * 3 : false),
  })
}

/** The router's model list changes rarely (the backend caches it for 10 minutes), so it is not polled. */
export function useRouterModels(id: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.routerModels(id),
    queryFn: () => getApi().preview.routerModels(id),
    enabled,
    staleTime: 5 * 60_000,
  })
}

export function useTelegram(id: string) {
  return useQuery({
    queryKey: keys.telegram(id),
    queryFn: () => getApi().preview.telegram(id),
    refetchInterval: (q) => (q.state.data?.restartRequired ? POLL_MS * 3 : false),
  })
}

export function useFiles(id: string, path: string, enabled: boolean) {
  return useQuery({ queryKey: keys.files(id, path), queryFn: () => getApi().preview.files(id, path), enabled })
}

export function useFileContent(id: string, path: string | null) {
  return useQuery({
    queryKey: keys.file(id, path ?? ""),
    queryFn: () => getApi().preview.fileContent(id, path!),
    enabled: path !== null,
  })
}

export function useBackups(id: string) {
  return useQuery({
    queryKey: keys.backups(id),
    queryFn: () => getApi().preview.backups(id),
    refetchInterval: (q) => (q.state.data?.some((b) => b.status === "running") ? POLL_MS : false),
  })
}

export function useCreateInstance() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ input, idempotencyKey }: { input: CreateInstanceInput; idempotencyKey: string }) =>
      getApi().instances.create(input, idempotencyKey),
    onSuccess: (instance) => {
      qc.setQueryData(keys.instance(instance.id), instance)
      void qc.invalidateQueries({ queryKey: keys.instances })
    },
  })
}

const ACTION_COPY: Record<InstanceAction, { pending: string; done: string }> = {
  start: { pending: "Starting", done: "Start requested" },
  stop: { pending: "Stopping", done: "Stop requested" },
  restart: { pending: "Restarting", done: "Restart requested" },
  delete: { pending: "Deleting", done: "Deletion requested" },
}

export function useInstanceAction(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (action: InstanceAction): Promise<Instance> => {
      const api = getApi().instances
      switch (action) {
        case "start":
          return api.start(id)
        case "stop":
          return api.stop(id)
        case "restart":
          return api.restart(id)
        case "delete":
          return api.remove(id)
      }
    },
    onSuccess: (instance, action) => {
      qc.setQueryData(keys.instance(id), instance)
      void qc.invalidateQueries({ queryKey: keys.instances })
      void qc.invalidateQueries({ queryKey: keys.events(id) })
      toast.success(`${ACTION_COPY[action].done} for ${instance.name}`)
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
}

export function invalidateKey(qc: ReturnType<typeof useQueryClient>, key: readonly unknown[]) {
  return qc.invalidateQueries({ queryKey: key })
}
