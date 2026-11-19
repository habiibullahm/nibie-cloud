import { afterEach, describe, expect, it, vi } from "vitest"
import { createCustomerApi } from "../src/lib/api/customer"
import { parseLogLine } from "../src/lib/api/integrations"
import { providerNameForUrl } from "../src/lib/api/providers"

const ID = "5b0c6a2e-1f1d-4c55-9a7e-0d1f3a000001"
const TOKEN = "123456789:AAEexampleexampleexampleexample_12"

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function setup() {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
  vi.stubGlobal("fetch", fetchMock)
  const api = createCustomerApi({ baseUrl: "https://api.example.test", getToken: async () => "tok" })
  return { api, fetchMock }
}

const providerBody = {
  id: "p-1",
  kind: "BYOK",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  status: "UNTESTED",
  keyHint: "abcd",
  lastTestedAt: null,
  lastErrorCode: null,
  restartRequired: true,
}

afterEach(() => vi.unstubAllGlobals())

describe("customer API: AI provider", () => {
  it("reads the provider and maps backend names to the dashboard type", async () => {
    const { api, fetchMock } = setup()
    fetchMock.mockResolvedValue(json({ providers: [providerBody] }))
    const cfg = await api.preview.provider(ID)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`https://api.example.test/api/v1/instances/${ID}/providers`)
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer tok")
    expect(cfg).toMatchObject({
      configured: true,
      kind: "byok",
      providerName: "openai",
      model: "gpt-4o-mini",
      keyHint: "…abcd",
      status: "untested",
      restartRequired: true,
    })
  })

  it("answers an unconfigured placeholder when the backend lists no provider", async () => {
    const { api, fetchMock } = setup()
    fetchMock.mockResolvedValue(json({ providers: [] }))
    expect(await api.preview.provider(ID)).toMatchObject({ configured: false, id: "", status: "untested" })
  })

  it("maps NibieRouter without a key hint or preset", async () => {
    const { api, fetchMock } = setup()
    fetchMock.mockResolvedValue(
      json({ providers: [{ ...providerBody, kind: "NIBIEROUTER", baseUrl: "https://router.nibie.app/v1", keyHint: null, status: "OK" }] })
    )
    expect(await api.preview.provider(ID)).toMatchObject({ kind: "nibierouter", providerName: null, keyHint: null, status: "connected" })
  })

  it("saves with PUT {baseUrl, model, apiKey} and never echoes the key", async () => {
    const { api, fetchMock } = setup()
    fetchMock.mockResolvedValue(json({ provider: providerBody }))
    const saved = await api.preview.saveProvider(ID, {
      kind: "byok",
      providerName: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: " gpt-4o-mini ",
      apiKey: "sk-test-1234567890abcd",
    })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`https://api.example.test/api/v1/instances/${ID}/providers`)
    expect(init!.method).toBe("PUT")
    expect(JSON.parse(init!.body as string)).toEqual({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-test-1234567890abcd",
    })
    expect(JSON.stringify(saved)).not.toContain("sk-test")
  })

  it("rejects before any request when the model or key is missing, or NibieRouter is chosen", async () => {
    const { api, fetchMock } = setup()
    const base = { kind: "byok" as const, baseUrl: "https://api.openai.com/v1", model: "m", apiKey: "sk-test-1234567890" }
    await expect(api.preview.saveProvider(ID, { ...base, model: "" })).rejects.toMatchObject({ status: 400 })
    await expect(api.preview.saveProvider(ID, { ...base, model: "bad model!" })).rejects.toMatchObject({ status: 400 })
    await expect(api.preview.saveProvider(ID, { ...base, apiKey: "" })).rejects.toMatchObject({ status: 400 })
    await expect(api.preview.saveProvider(ID, { ...base, baseUrl: "" })).rejects.toMatchObject({ status: 400 })
    await expect(api.preview.saveProvider(ID, { kind: "nibierouter" })).rejects.toMatchObject({ code: "not_supported" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("tests the connection with POST and explains a failure", async () => {
    const { api, fetchMock } = setup()
    fetchMock.mockResolvedValue(json({ provider: { ...providerBody, status: "FAILED", lastErrorCode: "unauthorized" } }))
    const cfg = await api.preview.testProvider(ID)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`https://api.example.test/api/v1/instances/${ID}/providers/test`)
    expect(init!.method).toBe("POST")
    expect(cfg).toMatchObject({ status: "error", statusMessage: "The provider rejected the API key." })
  })

  it("surfaces backend validation errors", async () => {
    const { api, fetchMock } = setup()
    fetchMock.mockResolvedValue(json({ error: { code: "validation_error", message: "baseUrl must be an https URL" } }, 400))
    await expect(
      api.preview.saveProvider(ID, { kind: "byok", baseUrl: "http://x.example", model: "m", apiKey: "sk-test-1234567890" })
    ).rejects.toMatchObject({ status: 400, message: "baseUrl must be an https URL" })
  })

  it("recognises preset base URLs", () => {
    expect(providerNameForUrl("https://openrouter.ai/api/v1")).toBe("openrouter")
    expect(providerNameForUrl("https://api.openai.com/v1/")).toBe("openai")
    expect(providerNameForUrl("https://llm.example.com/v1")).toBe("custom")
  })
})

describe("customer API: Telegram", () => {
  const configured = {
    configured: true,
    botId: "1",
    botUsername: "nibie_bot",
    allowedUserIds: ["111", "222"],
    status: "UNTESTED",
    keyHint: "x9Qa",
    lastErrorCode: "needs_start",
    verifiedAt: null,
    restartRequired: true,
  }

  it("maps an unconfigured bot", async () => {
    const { api, fetchMock } = setup()
    fetchMock.mockResolvedValue(json({ telegram: { configured: false } }))
    expect(await api.preview.telegram(ID)).toMatchObject({ configured: false, allowlist: [], restartRequired: false })
  })

  it("maps a configured bot, its allowlist and the needs-start hint", async () => {
    const { api, fetchMock } = setup()
    fetchMock.mockResolvedValue(json({ telegram: configured }))
    const t = await api.preview.telegram(ID)
    expect(t).toMatchObject({
      configured: true,
      botUsername: "nibie_bot",
      tokenHint: "…x9Qa",
      verified: false,
      allowlist: ["111", "222"],
      restartRequired: true,
    })
    expect(t.statusMessage).toMatch(/press Start/)
  })

  it("saves with PUT {token, allowedUserIds}, deduplicated", async () => {
    const { api, fetchMock } = setup()
    fetchMock.mockResolvedValue(json({ telegram: configured }))
    const saved = await api.preview.saveTelegram(ID, { token: TOKEN, allowlist: ["111", " 111 ", "222"] })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`https://api.example.test/api/v1/instances/${ID}/telegram`)
    expect(init!.method).toBe("PUT")
    expect(JSON.parse(init!.body as string)).toEqual({ token: TOKEN, allowedUserIds: ["111", "222"] })
    expect(JSON.stringify(saved)).not.toContain(TOKEN)
  })

  it("refuses usernames, an empty allowlist and malformed tokens before any request", async () => {
    const { api, fetchMock } = setup()
    await expect(api.preview.saveTelegram(ID, { token: TOKEN, allowlist: ["@me"] })).rejects.toMatchObject({ status: 400 })
    await expect(api.preview.saveTelegram(ID, { token: TOKEN, allowlist: [] })).rejects.toMatchObject({ status: 400 })
    await expect(api.preview.saveTelegram(ID, { token: "nope", allowlist: ["1"] })).rejects.toMatchObject({ status: 400 })
    await expect(
      api.preview.saveTelegram(ID, { token: TOKEN, allowlist: Array.from({ length: 21 }, (_, i) => String(i + 1)) })
    ).rejects.toMatchObject({ status: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("verifies with POST and reports a delivered test message", async () => {
    const { api, fetchMock } = setup()
    fetchMock.mockResolvedValue(json({ telegram: { ...configured, status: "OK", lastErrorCode: null, verifiedAt: "2026-11-17T01:00:00.000Z" } }))
    const t = await api.preview.verifyTelegram(ID)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`https://api.example.test/api/v1/instances/${ID}/telegram/verify`)
    expect(init!.method).toBe("POST")
    expect(t).toMatchObject({ verified: true, statusMessage: null, verifiedAt: "2026-11-17T01:00:00.000Z" })
  })

  it("disconnects with DELETE and keeps restartRequired from the answer", async () => {
    const { api, fetchMock } = setup()
    fetchMock.mockResolvedValue(json({ restartRequired: true }))
    const t = await api.preview.removeTelegram(ID)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`https://api.example.test/api/v1/instances/${ID}/telegram`)
    expect(init!.method).toBe("DELETE")
    expect(t).toMatchObject({ configured: false, restartRequired: true })
  })
})

describe("customer API: logs", () => {
  it("requests the tail and filters by level and text on the client", async () => {
    const { api, fetchMock } = setup()
    fetchMock.mockImplementation(async () =>
      json({
        lines: [
          "2026-11-17 01:02:03,456 INFO gateway: telegram polling started",
          "2026-11-17T01:02:04Z WARNING slow upstream",
          "2026-11-17T01:02:05+07:00 ERROR provider failed",
          "plain line without a level",
        ],
      })
    )
    const all = await api.preview.logs(ID, { level: "all" })
    expect(fetchMock.mock.calls[0]![0]).toBe(`https://api.example.test/api/v1/instances/${ID}/logs?tail=200`)
    expect(all.map((l) => l.level)).toEqual(["info", "warn", "error", "info"])
    expect((await api.preview.logs(ID, { level: "error" })).map((l) => l.message)).toEqual([
      "2026-11-17T01:02:05+07:00 ERROR provider failed",
    ])
    expect(await api.preview.logs(ID, { query: "TELEGRAM" })).toHaveLength(1)
  })

  it("parses timestamps and leaves them empty rather than inventing one", () => {
    expect(parseLogLine("2026-11-17T01:02:05+07:00 ERROR x").t).toBe("2026-11-16T18:02:05.000Z")
    expect(parseLogLine("2026-11-17 01:02:03,456 INFO x").t).toBe("2026-11-17T01:02:03.000Z")
    expect(parseLogLine("no timestamp").t).toBe("")
  })
})
