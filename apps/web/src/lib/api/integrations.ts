import { ApiError, type PreviewApi } from "./client"
import type { Call } from "./live"
import {
  API_KEY_FORMAT,
  MAX_TELEGRAM_USERS,
  MODEL_FORMAT,
  TELEGRAM_TOKEN_FORMAT,
  TELEGRAM_USER_ID_FORMAT,
  providerNameForUrl,
} from "./providers"
import type { LogLevel, LogLine, ProviderConfig, TelegramConfig } from "./types"

/** Shapes returned by src/http/integration-routes.ts (ProviderView, TelegramView). */
interface ProviderBody {
  id: string
  kind: "BYOK" | "NIBIEROUTER"
  baseUrl: string
  model: string
  status: "UNTESTED" | "OK" | "FAILED"
  keyHint: string | null
  lastTestedAt: string | null
  lastErrorCode: string | null
  restartRequired: boolean
}
type TelegramBody =
  | { configured: false }
  | {
      configured: true
      botUsername: string
      allowedUserIds: string[]
      status: "UNTESTED" | "OK" | "FAILED"
      keyHint: string
      lastErrorCode: string | null
      verifiedAt: string | null
      restartRequired: boolean
    }

const PROVIDER_ERRORS: Record<string, string> = {
  unauthorized: "The provider rejected the API key.",
  unexpected_status: "The provider answered with an unexpected error.",
  timeout: "The provider did not answer in time.",
  unreachable: "The provider could not be reached.",
  blocked: "This address is not allowed.",
}

const TELEGRAM_ERRORS: Record<string, string> = {
  token_rejected: "Telegram rejected the bot token.",
  needs_start: "Open your bot in Telegram and press Start, then send the test message again.",
  send_failed: "Telegram did not accept the test message.",
}

const NOT_CONFIGURED_PROVIDER: ProviderConfig = {
  id: "",
  configured: false,
  kind: "byok",
  providerName: null,
  baseUrl: null,
  model: null,
  keyHint: null,
  status: "untested",
  statusMessage: null,
  lastTestedAt: null,
  restartRequired: false,
}

export function toProvider(p: ProviderBody): ProviderConfig {
  return {
    id: p.id,
    configured: true,
    kind: p.kind === "NIBIEROUTER" ? "nibierouter" : "byok",
    providerName: p.kind === "BYOK" ? providerNameForUrl(p.baseUrl) : null,
    baseUrl: p.baseUrl,
    model: p.model,
    keyHint: p.keyHint ? `…${p.keyHint}` : null,
    status: p.status === "OK" ? "connected" : p.status === "FAILED" ? "error" : "untested",
    statusMessage: p.lastErrorCode ? (PROVIDER_ERRORS[p.lastErrorCode] ?? "The connection test failed.") : null,
    lastTestedAt: p.lastTestedAt,
    restartRequired: p.restartRequired,
  }
}

export function toTelegram(t: TelegramBody): TelegramConfig {
  if (!t.configured) {
    return {
      configured: false,
      botUsername: null,
      tokenHint: null,
      verified: false,
      statusMessage: null,
      allowlist: [],
      verifiedAt: null,
      restartRequired: false,
    }
  }
  return {
    configured: true,
    botUsername: t.botUsername,
    tokenHint: t.keyHint ? `…${t.keyHint}` : null,
    verified: t.status === "OK",
    statusMessage: t.lastErrorCode ? (TELEGRAM_ERRORS[t.lastErrorCode] ?? "The test message failed.") : null,
    allowlist: t.allowedUserIds,
    verifiedAt: t.verifiedAt,
    restartRequired: t.restartRequired,
  }
}

const bad = (message: string) => new ApiError(400, "validation_error", message)
const json = (body: unknown): RequestInit => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

const TS = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:[.,]\d+)?(Z|[+-]\d{2}:?\d{2})?/
const LEVEL = /\b(DEBUG|INFO|WARN(?:ING)?|ERROR|CRITICAL|FATAL)\b/

/**
 * The backend returns raw container output (secrets already redacted). Pull a timestamp and a level out
 * when the line has them; a line without a timestamp keeps `t` empty rather than getting an invented one.
 */
export function parseLogLine(raw: string): LogLine {
  const m = TS.exec(raw)
  let t = ""
  if (m) {
    const tz = m[3] ? (m[3].length === 5 ? `${m[3].slice(0, 3)}:${m[3].slice(3)}` : m[3]) : "Z"
    const d = new Date(`${m[1]}T${m[2]}${tz}`)
    if (!Number.isNaN(d.getTime())) t = d.toISOString()
  }
  const lv = LEVEL.exec(raw)?.[1]
  const level: LogLevel = !lv
    ? "info"
    : lv === "DEBUG"
      ? "debug"
      : lv.startsWith("WARN")
        ? "warn"
        : lv === "INFO"
          ? "info"
          : "error"
  return { t, level, source: "hermes", message: raw }
}

/** Provider, Telegram and log endpoints of the customer API (src/http/integration-routes.ts). */
export function buildIntegrationsApi(
  call: Call
): Pick<
  PreviewApi,
  | "provider"
  | "saveProvider"
  | "testProvider"
  | "telegram"
  | "saveTelegram"
  | "verifyTelegram"
  | "removeTelegram"
  | "logs"
> {
  const id = (s: string) => encodeURIComponent(s)
  return {
    provider: async (i) => {
      const { providers } = await call<{ providers: ProviderBody[] }>(`/instances/${id(i)}/providers`)
      return providers[0] ? toProvider(providers[0]) : NOT_CONFIGURED_PROVIDER
    },
    saveProvider: async (i, input) => {
      // The customer API only accepts a customer-supplied key; the NibieRouter key is attached by Nibie Cloud.
      if (input.kind !== "byok") {
        throw new ApiError(400, "not_supported", "NibieRouter is attached by Nibie Cloud. Choose your own key to change it.")
      }
      const baseUrl = input.baseUrl?.trim() ?? ""
      const model = input.model?.trim() ?? ""
      const apiKey = input.apiKey ?? ""
      if (!baseUrl) throw bad("Enter the provider base URL.")
      if (!MODEL_FORMAT.test(model)) throw bad("Enter the model name, for example gpt-4o-mini.")
      if (!API_KEY_FORMAT.test(apiKey)) throw bad("Enter your API key. It is needed each time you save.")
      const { provider } = await call<{ provider: ProviderBody }>(
        `/instances/${id(i)}/providers`,
        { method: "PUT", ...json({ baseUrl, model, apiKey }) }
      )
      return toProvider(provider)
    },
    testProvider: async (i) =>
      toProvider((await call<{ provider: ProviderBody }>(`/instances/${id(i)}/providers/test`, { method: "POST" })).provider),
    telegram: async (i) => toTelegram((await call<{ telegram: TelegramBody }>(`/instances/${id(i)}/telegram`)).telegram),
    saveTelegram: async (i, input) => {
      const allowedUserIds = [...new Set(input.allowlist.map((s) => s.trim()).filter(Boolean))]
      if (!TELEGRAM_TOKEN_FORMAT.test(input.token)) throw bad("That does not look like a BotFather token.")
      if (allowedUserIds.length === 0) throw bad("Add at least one numeric Telegram user ID.")
      if (allowedUserIds.length > MAX_TELEGRAM_USERS || !allowedUserIds.every((u) => TELEGRAM_USER_ID_FORMAT.test(u))) {
        throw bad(`Allowed users must be numeric Telegram user IDs, at most ${MAX_TELEGRAM_USERS}.`)
      }
      const { telegram } = await call<{ telegram: TelegramBody }>(`/instances/${id(i)}/telegram`, {
        method: "PUT",
        ...json({ token: input.token, allowedUserIds }),
      })
      return toTelegram(telegram)
    },
    verifyTelegram: async (i) =>
      toTelegram((await call<{ telegram: TelegramBody }>(`/instances/${id(i)}/telegram/verify`, { method: "POST" })).telegram),
    removeTelegram: async (i) => {
      const { restartRequired } = await call<{ restartRequired: boolean }>(`/instances/${id(i)}/telegram`, {
        method: "DELETE",
      })
      return { ...toTelegram({ configured: false }), restartRequired }
    },
    logs: async (i, filter) => {
      const { lines } = await call<{ lines: string[] }>(`/instances/${id(i)}/logs?tail=200`)
      const q = filter.query?.trim().toLowerCase()
      return lines
        .map(parseLogLine)
        .filter(
          (l) =>
            (!filter.level || filter.level === "all" || l.level === filter.level) &&
            (!q || l.message.toLowerCase().includes(q))
        )
    },
  }
}
