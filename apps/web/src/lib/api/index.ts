import type { ApiMode, HermesApi } from "./client"
import { createLiveInstancesApi } from "./live"
import { createMockApi } from "./mock"

export * from "./client"
export * from "./types"

let singleton: HermesApi | null = null

export function apiMode(): ApiMode {
  return process.env.NEXT_PUBLIC_HERMES_API_MODE === "live" ? "live" : "mock"
}

/** Browser-side API. Instances go live when configured; preview endpoints are always mocked. */
export function getApi(): HermesApi {
  if (singleton) return singleton
  if (apiMode() === "live") {
    const mock = createMockApi({ empty: true, synthesizeUnknown: true })
    singleton = { mode: "live", instances: createLiveInstancesApi(), preview: mock.preview }
  } else {
    const empty = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("empty")
    singleton = createMockApi({ empty })
  }
  return singleton
}
