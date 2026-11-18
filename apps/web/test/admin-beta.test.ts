import { describe, expect, it, vi } from "vitest"
import { createAdminApi } from "../src/lib/api/admin"
import { addInviteProblem, inviteErrorMessage, inviteStatusLabel, looksLikeEmail } from "../src/lib/admin-beta"

const BASE = "https://api.cloud.nibie.app"
const INVITE = { id: "i1", email: "a@example.test", note: null, addedBy: "boss@nibie.app", createdAt: "2026-11-18T00:00:00.000Z", revokedAt: null }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}
const client = (fetchImpl: typeof fetch) => createAdminApi({ baseUrl: BASE, getToken: async () => "tok", fetchImpl })
const lastCall = (f: unknown) => (f as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [string, RequestInit]

describe("admin beta invite client", () => {
  it("reads the list with a plain GET and no body", async () => {
    const f = vi.fn(async () => jsonResponse({ invites: [INVITE], fromEnv: ["env@example.test"], freeBetaSlots: 0 }))
    const out = await client(f as unknown as typeof fetch).betaInvites()
    expect(out.invites).toHaveLength(1)
    const [url, init] = lastCall(f)
    expect(url).toBe(`${BASE}/api/v1/admin/beta-invites`)
    expect(init.method).toBeUndefined()
    expect(init.body).toBeUndefined()
    expect((init.headers as Record<string, string>)["content-type"]).toBeUndefined()
  })

  it("adds an invite with a JSON POST carrying the token, and returns the row", async () => {
    const f = vi.fn(async () => jsonResponse({ invite: INVITE, emailSent: true }, 201))
    const out = await client(f as unknown as typeof fetch).addBetaInvite({ email: "a@example.test", note: "friend", reason: "asked" })
    expect(out).toEqual({ ...INVITE, emailSent: true })
    const [url, init] = lastCall(f)
    expect(url).toBe(`${BASE}/api/v1/admin/beta-invites`)
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body as string)).toEqual({ email: "a@example.test", note: "friend", reason: "asked" })
    const h = init.headers as Record<string, string>
    expect(h.authorization).toBe("Bearer tok")
    expect(h["content-type"]).toBe("application/json")
  })

  it("revokes by id, encoding it so the path cannot escape the admin prefix", async () => {
    const f = vi.fn(async () => jsonResponse({ invite: { ...INVITE, revokedAt: "2026-11-18T01:00:00.000Z" } }))
    await client(f as unknown as typeof fetch).revokeBetaInvite("../x", "left")
    const [url, init] = lastCall(f)
    expect(url).toBe(`${BASE}/api/v1/admin/beta-invites/..%2Fx/revoke`)
    expect(JSON.parse(init.body as string)).toEqual({ reason: "left" })
  })

  it("turns a refused change into an ApiError with its status and code", async () => {
    const f = async () => jsonResponse({ error: { code: "mfa_required", message: "Two-factor authentication is required" } }, 403)
    await expect(client(f as unknown as typeof fetch).addBetaInvite({ email: "a@example.test", reason: "asked" })).rejects.toMatchObject({ status: 403, code: "mfa_required" })
  })
})

describe("beta invite form rules", () => {
  it("accepts an address-shaped email and refuses the rest", () => {
    expect(looksLikeEmail(" a@example.test ")).toBe(true)
    for (const bad of ["", "a", "a@b", "a b@c.d", "@x.y"]) expect(looksLikeEmail(bad)).toBe(false)
  })

  it("names the first problem, email before reason, and is null when the form can be sent", () => {
    expect(addInviteProblem({ email: "nope", reason: "long enough" })).toBe("Isi email yang valid.")
    expect(addInviteProblem({ email: "a@example.test", reason: " x " })).toBe("Alasan minimal 3 karakter.")
    expect(addInviteProblem({ email: "a@example.test", reason: "asked" })).toBeNull()
  })

  it("says Aktif or Dicabut in words", () => {
    expect(inviteStatusLabel({ revokedAt: null })).toBe("Aktif")
    expect(inviteStatusLabel({ revokedAt: "2026-11-18T01:00:00.000Z" })).toBe("Dicabut")
  })

  it("picks Indonesian text by status and never repeats a backend message", () => {
    expect(inviteErrorMessage({ status: 400 })).toMatch(/tidak valid/i)
    expect(inviteErrorMessage({ status: 403 })).toMatch(/verifikasi 2 langkah/i)
    expect(inviteErrorMessage({ status: 401 })).toMatch(/verifikasi 2 langkah/i)
    expect(inviteErrorMessage({ status: 404 })).toMatch(/tidak ditemukan/i)
    expect(inviteErrorMessage({ status: 500, message: "internal stack detail" })).toBe("Gagal menyimpan. Coba lagi.")
    expect(inviteErrorMessage(null)).toBe("Gagal menyimpan. Coba lagi.")
  })
})
