import { describe, expect, it } from "vitest"
import { fetchSupportContact, formatWhatsapp, safeGroupUrl, whatsappUrl } from "../src/lib/support"

describe("support contact", () => {
  it("formats Indonesian numbers in groups and others with a plus", () => {
    expect(formatWhatsapp("6281234567890")).toBe("+62 812 3456 7890")
    expect(formatWhatsapp("447911123456")).toBe("+447911123456")
    expect(whatsappUrl("6281234567890")).toBe("https://wa.me/6281234567890")
  })

  it("asks the public endpoint without a token in customer mode, and nothing in mock mode", async () => {
    const calls: [string, RequestInit | undefined][] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return new Response(JSON.stringify({ whatsapp: "6281234567890", email: null, groupUrl: "https://chat.whatsapp.com/AbCdEfGhIjKl123" }), { status: 200 })
    }) as typeof fetch
    expect(await fetchSupportContact("https://api.example.test/", "customer", fetchImpl)).toEqual({
      whatsapp: "6281234567890",
      email: null,
      groupUrl: "https://chat.whatsapp.com/AbCdEfGhIjKl123",
    })
    expect(calls[0]![0]).toBe("https://api.example.test/api/v1/public/support-contact")
    expect(JSON.stringify(calls[0]![1])).not.toContain("authorization")
    expect(await fetchSupportContact("https://api.example.test", "mock", fetchImpl)).toEqual({ whatsapp: null, email: null, groupUrl: null })
    expect(calls).toHaveLength(1)
  })

  it("never turns anything but a WhatsApp invite into a group link", () => {
    expect(safeGroupUrl("https://chat.whatsapp.com/AbCdEfGhIjKl123")).toBe("https://chat.whatsapp.com/AbCdEfGhIjKl123")
    for (const bad of ["javascript:alert(1)", "https://evil.example/AbCdEfGhIjKl123", "http://chat.whatsapp.com/AbCdEfGhIjKl123", "https://chat.whatsapp.com.evil.test/AbCdEfGhIjKl123", null, 42]) {
      expect(safeGroupUrl(bad)).toBeNull()
    }
  })

  it("fails loudly on an error answer so the page shows its error state", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 503 })) as typeof fetch
    await expect(fetchSupportContact("https://api.example.test", "customer", fetchImpl)).rejects.toThrow("503")
  })
})
