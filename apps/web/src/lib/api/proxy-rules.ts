/**
 * Allowlist for the dev bridge in src/app/api/hermes/[...path]/route.ts.
 *
 * The browser never talks to the backend directly and never sees the operator token. It calls
 * /api/hermes/<path>; only the method + path pairs below are forwarded, and only to the
 * tenant-scoped instance endpoints that exist in src/http/server.ts today. Ids must be UUIDs, so
 * nothing the browser sends can reach another route, a host path or a container id.
 */

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"

type Method = "GET" | "POST" | "DELETE"

const RULES: { method: Method; pattern: RegExp }[] = [
  { method: "GET", pattern: /^instances$/ },
  { method: "POST", pattern: /^instances$/ },
  { method: "GET", pattern: new RegExp(`^instances/${UUID}$`) },
  { method: "GET", pattern: new RegExp(`^instances/${UUID}/(status|events)$`) },
  { method: "POST", pattern: new RegExp(`^instances/${UUID}/(start|stop|restart)$`) },
  { method: "DELETE", pattern: new RegExp(`^instances/${UUID}$`) },
]

export function isForwardable(method: string, segments: readonly string[]): boolean {
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.includes("/") || s.includes("\\"))) {
    return false
  }
  const path = segments.join("/")
  return RULES.some((r) => r.method === method && r.pattern.test(path))
}

export function backendPath(tenantId: string, segments: readonly string[]): string {
  return `/api/v1/tenants/${encodeURIComponent(tenantId)}/${segments.join("/")}`
}
