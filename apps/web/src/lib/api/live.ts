import { ApiError, type BillingApi, type InstancesApi } from "./client"
import type { AiAccount, AiAlert, BillingSubscription, CheckoutResult, Instance, InstanceEvent, InstanceStatusView, Invoice, Wallet, WalletTopup } from "./types"

const BASE = (process.env.NEXT_PUBLIC_BASE_PATH ?? "") + "/api/hermes"

/** One JSON request against a base URL; `headers` is awaited so a caller can add a fresh token. */
export type Call = <T>(path: string, init?: RequestInit) => Promise<T>

/** Host of the API base, for messages; the base itself when it is not an absolute URL (the dev bridge). */
function hostOf(base: string): string {
  try {
    return new URL(base).host
  } catch {
    return base
  }
}

/**
 * Logs what failed (method, path, status, code; never headers or bodies) during development only: customers see the
 * error in the UI, not in their browser console.
 */
function fail(err: ApiError, method: string, path: string): ApiError {
  if (process.env.NODE_ENV !== "production") console.error(`[nibie-api] ${method} ${path} failed: ${err.status} ${err.code}`)
  return err
}

export function makeCall(base: string, extraHeaders?: () => Promise<Record<string, string>>): Call {
  return async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase()
    const headers = { accept: "application/json", ...((await extraHeaders?.()) ?? {}), ...(init.headers ?? {}) }
    let res: Response
    try {
      res = await fetch(base + path, { ...init, headers, cache: "no-store" })
    } catch {
      // No answer at all: the API is down, unreachable, or refused this page's origin (CORS).
      throw fail(
        new ApiError(0, "network_error", `Could not reach the API at ${hostOf(base)}. Check your connection and try again.`),
        method,
        path
      )
    }
    const data = (await res.json().catch(() => null)) as
      | (T & { error?: { code: string; message: string } })
      | null
    if (!res.ok) {
      throw fail(
        new ApiError(res.status, data?.error?.code ?? "http_error", data?.error?.message ?? `Request failed (${res.status})`),
        method,
        path
      )
    }
    if (data === null && res.status !== 204) {
      throw fail(new ApiError(res.status, "invalid_response", "The API sent an unexpected answer. Try again."), method, path)
    }
    return data as T
  }
}

/** Talks to the backend's existing instance endpoints through the server-side dev bridge. */
export function createLiveInstancesApi(): InstancesApi {
  return buildInstancesApi(makeCall(BASE))
}

/** The instance endpoints are identical on the operator API (via the bridge) and the customer API. */
export function buildInstancesApi(call: Call): InstancesApi {
  const id = (s: string) => encodeURIComponent(s)
  return {
    list: async () => (await call<{ instances: Instance[] }>("/instances")).instances,
    get: async (i) => (await call<{ instance: Instance }>(`/instances/${id(i)}`)).instance,
    status: (i) => call<InstanceStatusView>(`/instances/${id(i)}/status`),
    events: async (i) => (await call<{ events: InstanceEvent[] }>(`/instances/${id(i)}/events`)).events,
    create: async (input, idempotencyKey) =>
      (
        await call<{ instance: Instance }>("/instances", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
          body: JSON.stringify(input),
        })
      ).instance,
    start: async (i) => (await call<{ instance: Instance }>(`/instances/${id(i)}/start`, { method: "POST" })).instance,
    stop: async (i) => (await call<{ instance: Instance }>(`/instances/${id(i)}/stop`, { method: "POST" })).instance,
    restart: async (i) =>
      (await call<{ instance: Instance }>(`/instances/${id(i)}/restart`, { method: "POST" })).instance,
    remove: async (i) => (await call<{ instance: Instance }>(`/instances/${id(i)}`, { method: "DELETE" })).instance,
  }
}

/** The customer billing endpoints (backend milestone D); they exist only on the customer API. */
export function buildBillingApi(call: Call): BillingApi {
  const id = (s: string) => encodeURIComponent(s)
  return {
    list: async () => (await call<{ subscriptions: BillingSubscription[] }>("/subscriptions")).subscriptions,
    checkout: (input, idempotencyKey) =>
      call<CheckoutResult>("/subscriptions/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({ name: input.name, planId: input.planId }),
      }),
    upgrade: (input, idempotencyKey) =>
      call<CheckoutResult>("/subscriptions/upgrade", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({ instanceId: input.instanceId, planId: input.planId }),
      }),
    renew: (subscriptionId) => call<CheckoutResult>(`/subscriptions/${id(subscriptionId)}/renew`, { method: "POST" }),
    cancel: async (subscriptionId) =>
      (await call<{ subscription: BillingSubscription }>(`/subscriptions/${id(subscriptionId)}/cancel`, { method: "POST" }))
        .subscription,
    wallet: async () => {
      try {
        return (await call<{ wallet: Wallet }>("/wallet")).wallet
      } catch (e) {
        // 404: the backend has the wallet switched off (WALLET_ENABLED), so the page hides it.
        if (e instanceof ApiError && e.status === 404) return null
        throw e
      }
    },
    topup: async (amountIdr, idempotencyKey) =>
      (
        await call<{ topup: WalletTopup }>("/wallet/topups", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
          body: JSON.stringify({ amountIdr }),
        })
      ).topup,
    payWithWallet: (paymentId, captchaToken) =>
      call<CheckoutResult>(`/payments/${id(paymentId)}/pay-with-wallet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(captchaToken ? { captchaToken } : {}),
      }),
    setAutoRenew: async (subscriptionId, enabled) =>
      (
        await call<{ subscription: BillingSubscription }>(`/subscriptions/${id(subscriptionId)}/auto-renew`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled }),
        })
      ).subscription,
    ai: async () => {
      try {
        return await call<AiAccount>("/ai")
      } catch (e) {
        // 404: NibieRouter is not configured on the backend, so the page hides the AI balance.
        if (e instanceof ApiError && e.status === 404) return null
        throw e
      }
    },
    setAiAlert: async (alert) =>
      (
        await call<{ alert: AiAlert }>("/ai/alert", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(alert),
        })
      ).alert,
    invoices: async () => (await call<{ invoices: Invoice[] }>("/invoices")).invoices,
    invoice: async (invoiceId) => (await call<{ invoice: Invoice }>(`/invoices/${id(invoiceId)}`)).invoice,
  }
}

/** Live (operator bridge) mode has no billing: no subscriptions, and purchases are refused. */
export function createUnavailableBillingApi(): BillingApi {
  const refuse = () => Promise.reject(new ApiError(404, "billing_unavailable", "Billing is not available in this mode."))
  return {
    list: async () => [], checkout: refuse, upgrade: refuse, renew: refuse, cancel: refuse,
    wallet: async () => null, topup: refuse, payWithWallet: refuse, setAutoRenew: refuse, ai: async () => null, setAiAlert: refuse,
    invoices: async () => [], invoice: refuse,
  }
}
