import { NextResponse, type NextRequest } from "next/server"
import { backendPath, isForwardable } from "@/lib/api/proxy-rules"

/**
 * Development bridge to the operator-only backend API (src/http/server.ts).
 *
 * The backend has no customer auth yet; it accepts one bearer ADMIN_TOKEN and tenant-scoped
 * paths. This handler keeps that token on the server, pins one tenant from env, and forwards only
 * the allowlisted instance endpoints. It is refused in production builds unless explicitly
 * enabled, and it must be replaced by the real customer API once auth exists.
 */

export const dynamic = "force-dynamic"

function error(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status })
}

function config() {
  const enabled = process.env.NEXT_PUBLIC_HERMES_API_MODE === "live"
  const url = process.env.HERMES_API_URL
  const token = process.env.HERMES_ADMIN_TOKEN
  const tenantId = process.env.HERMES_DEV_TENANT_ID
  const allowInProd = process.env.HERMES_ALLOW_DEV_BRIDGE === "1"
  if (!enabled) return null
  if (process.env.NODE_ENV === "production" && !allowInProd) return null
  if (!url || !token || !tenantId) return null
  return { url: url.replace(/\/+$/, ""), token, tenantId, planId: process.env.HERMES_DEV_PLAN_ID }
}

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const cfg = config()
  if (!cfg) return error(503, "live_mode_disabled", "Live API mode is not configured")

  const { path } = await ctx.params
  if (!isForwardable(req.method, path)) return error(404, "not_found", "Route not found")

  const headers: Record<string, string> = {
    authorization: `Bearer ${cfg.token}`,
    accept: "application/json",
  }
  let body: string | undefined

  if (req.method === "POST" && path.length === 1) {
    const key = req.headers.get("idempotency-key")
    if (!key) return error(400, "validation_error", "Idempotency-Key header is required")
    headers["idempotency-key"] = key
    const parsed = (await req.json().catch(() => null)) as { name?: unknown; planId?: unknown } | null
    if (!parsed || typeof parsed.name !== "string") return error(400, "validation_error", "Invalid request")
    // Plans are not served by the backend yet, so the dashboard's plan ids are previews.
    // HERMES_DEV_PLAN_ID maps every deploy onto one real plan row until GET /plans exists.
    body = JSON.stringify({ name: parsed.name, planId: cfg.planId ?? parsed.planId })
    headers["content-type"] = "application/json"
  }

  try {
    const res = await fetch(cfg.url + backendPath(cfg.tenantId, path), {
      method: req.method,
      headers,
      body,
      cache: "no-store",
    })
    const text = await res.text()
    return new NextResponse(text, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    })
  } catch {
    // Never echo upstream error text: it can carry internal hostnames.
    return error(502, "backend_unreachable", "The Hermes API is unreachable")
  }
}

export const GET = forward
export const POST = forward
export const DELETE = forward
