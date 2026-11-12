import { ApiError, type InstancesApi } from "./client"
import type { Instance, InstanceEvent, InstanceStatusView } from "./types"

const BASE = "/api/hermes"

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { accept: "application/json", ...(init.headers ?? {}) },
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

/** Talks to the backend's existing instance endpoints through the server-side dev bridge. */
export function createLiveInstancesApi(): InstancesApi {
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
