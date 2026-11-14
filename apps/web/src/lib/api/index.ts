import { ApiError, type ApiMode, type HermesApi } from "./client"
import { createCustomerApi } from "./customer"
import { authConfigured, getSupabase } from "@/lib/auth/supabase"
import { createLiveInstancesApi } from "./live"
import { createMockApi } from "./mock"

export * from "./client"
export * from "./types"

let singleton: HermesApi | null = null

export function apiMode(): ApiMode {
  const m = process.env.NEXT_PUBLIC_HERMES_API_MODE
  if (m === "live") return "live"
  // The customer API needs a base URL and Supabase sign-in; without them stay on labelled mock data.
  if (m === "customer" && process.env.NEXT_PUBLIC_HERMES_API_URL && authConfigured()) return "customer"
  return "mock"
}

async function accessToken(): Promise<string | null> {
  const { data } = (await getSupabase()?.auth.getSession()) ?? { data: null }
  return data?.session?.access_token ?? null
}

/** Browser-side API. Instances go live when configured; preview endpoints are always mocked. */
export function getApi(): HermesApi {
  if (singleton) return singleton
  const mode = apiMode()
  if (mode === "customer") {
    const mock = createMockApi({ empty: true, synthesizeUnknown: true })
    singleton = createCustomerApi({
      baseUrl: process.env.NEXT_PUBLIC_HERMES_API_URL ?? "",
      getToken: accessToken,
      preview: mock.preview,
    })
  } else if (mode === "live") {
    const mock = createMockApi({ empty: true, synthesizeUnknown: true })
    singleton = { mode: "live", instances: createLiveInstancesApi(), preview: mock.preview }
  } else {
    const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null
    const mock = createMockApi({ empty: params?.has("empty") ?? false })
    // `?fail` makes every preview endpoint reject, to check the error states (antislop R-27).
    singleton = params?.has("fail") ? { ...mock, preview: failingPreview(mock.preview) } : mock
  }
  return singleton
}

/** Same shape as `preview`, but every call rejects with a 503. */
export function failingPreview(preview: HermesApi["preview"]): HermesApi["preview"] {
  const fail = () => Promise.reject(new ApiError(503, "unavailable", "The preview service is unavailable."))
  return Object.fromEntries(Object.keys(preview).map((k) => [k, fail])) as unknown as HermesApi["preview"]
}
