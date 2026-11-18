import { describe, expect, it, vi } from "vitest"
import { createAdminApi } from "../src/lib/api/admin"
import { claudeMcpCommand, createKeyProblem, expiryDays, keyErrorMessage, keyStatusLabel, mcpUrl } from "../src/lib/admin-settings"

const BASE = "https://api.cloud.nibie.app"
const KEY = { id: "k1", name: "laptop", prefix: "nca_abcdef", createdByEmail: "boss@nibie.app", createdAt: "2026-11-19T00:00:00.000Z", expiresAt: null, revokedAt: null, lastUsedAt: null }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}
const client = (fetchImpl: typeof fetch) => createAdminApi({ baseUrl: BASE, getToken: async () => "tok", fetchImpl })
const lastCall = (f: unknown) => (f as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [string, RequestInit]

describe("admin api key client", () => {
  it("lists keys with a GET", async () => {
    const f = vi.fn(async () => jsonResponse({ keys: [KEY] }))
    expect(await client(f as unknown as typeof fetch).apiKeys()).toEqual([KEY])
    const [url, init] = lastCall(f)
    expect(url).toBe(`${BASE}/api/v1/admin/api-keys`)
    expect(init.method).toBeUndefined()
  })

  it("creates a key with a JSON POST and returns the one-time plaintext", async () => {
    const f = vi.fn(async () => jsonResponse({ key: KEY, plaintext: "nca_secret" }, 201))
    const out = await client(f as unknown as typeof fetch).createApiKey({ name: "laptop", expiresInDays: null, reason: "mcp" })
    expect(out.plaintext).toBe("nca_secret")
    const [url, init] = lastCall(f)
    expect(url).toBe(`${BASE}/api/v1/admin/api-keys`)
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body as string)).toEqual({ name: "laptop", expiresInDays: null, reason: "mcp" })
  })

  it("revokes by an encoded id", async () => {
    const f = vi.fn(async () => jsonResponse({ key: { ...KEY, revokedAt: "2026-11-19T01:00:00.000Z" } }))
    await client(f as unknown as typeof fetch).revokeApiKey("../x", "lost")
    const [url, init] = lastCall(f)
    expect(url).toBe(`${BASE}/api/v1/admin/api-keys/..%2Fx/revoke`)
    expect(JSON.parse(init.body as string)).toEqual({ reason: "lost" })
  })
})

describe("admin settings rules", () => {
  it("maps expiry choices, never to an unknown value", () => {
    expect(expiryDays("30")).toBe(30)
    expect(expiryDays("365")).toBe(365)
    expect(expiryDays("never")).toBeNull()
    expect(expiryDays("7")).toBe(30)
  })

  it("names the key status in words", () => {
    const now = new Date("2026-11-19T12:00:00Z")
    expect(keyStatusLabel({ revokedAt: null, expiresAt: null }, now)).toBe("Aktif")
    expect(keyStatusLabel({ revokedAt: null, expiresAt: "2026-11-20T00:00:00Z" }, now)).toBe("Aktif")
    expect(keyStatusLabel({ revokedAt: null, expiresAt: "2026-11-19T00:00:00Z" }, now)).toBe("Kedaluwarsa")
    expect(keyStatusLabel({ revokedAt: "2026-11-19T00:00:00Z", expiresAt: null }, now)).toBe("Dicabut")
  })

  it("builds the MCP URL and a command that keeps the key as a placeholder", () => {
    const url = mcpUrl(`${BASE}/`, "/api/v1/admin/mcp")
    expect(url).toBe(`${BASE}/api/v1/admin/mcp`)
    const cmd = claudeMcpCommand(url)
    expect(cmd).toContain(url)
    expect(cmd).toContain("Bearer <KUNCI>")
    expect(cmd).toContain("--scope user")
  })

  it("checks the create form and explains a key trying to manage keys", () => {
    expect(createKeyProblem({ name: " ", reason: "long enough" }, 3)).toMatch(/nama/i)
    expect(createKeyProblem({ name: "laptop", reason: "x" }, 3)).toBe("Alasan minimal 3 karakter.")
    expect(createKeyProblem({ name: "laptop", reason: "mcp use" }, 3)).toBeNull()
    expect(keyErrorMessage({ status: 403, code: "session_required" })).toMatch(/panel/)
    expect(keyErrorMessage({ status: 403, code: "mfa_required" })).toMatch(/verifikasi 2 langkah/)
    expect(keyErrorMessage(null)).toBe("Gagal menyimpan. Coba lagi.")
  })
})
