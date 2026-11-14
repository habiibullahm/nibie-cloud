import { ApiError, type InstancesApi } from "./client"
import type { Instance, InstanceEvent, InstanceStatusView } from "./types"

const BASE = (process.env.NEXT_PUBLIC_BASE_PATH ?? "") + "/api/hermes"

/** One JSON request against a base URL; `headers` is awaited so a caller can add a fresh token. */
export type Call = <T>(path: string, init?: RequestInit) => Promise<T>

export function makeCall(base: string, extraHeaders?: () => Promise<Record<string, string>>): Call {
  return async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(base + path, {
      ...init,
      headers: { accept: "application/json", ...((await extraHeaders?.()) ?? {}), ...(init.headers ?? {}) },
      cache: "no-store",
    })
    const data = (await res.json().catch(() => null)) as
      | (T & { error?: { code: string; message: string } })
      | null
    if (!res.ok) {
      throw new ApiError(
        res.status,
        data?.error?.code ?? "http_error",
        data?.error?.message ?? `Request failed (${res.status})`
      )
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
