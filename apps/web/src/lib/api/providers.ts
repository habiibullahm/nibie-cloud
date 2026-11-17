/**
 * BYOK provider presets. The backend only stores a base URL and a model name (ProviderService); a preset
 * is a dashboard convenience that fills the base URL. Anthropic is not offered: the backend tests a
 * provider with `GET {baseUrl}/models` and a Bearer token, which Anthropic's own API does not accept.
 */
export const BYOK_PROVIDERS = [
  { value: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", modelHint: "gpt-4o-mini" },
  { value: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", modelHint: "openai/gpt-4o-mini" },
  { value: "custom", label: "OpenAI-compatible (custom URL)", baseUrl: null, modelHint: "model-name" },
] as const

export type ByokProviderName = (typeof BYOK_PROVIDERS)[number]["value"]

export function providerNameForUrl(baseUrl: string): ByokProviderName {
  const clean = baseUrl.replace(/\/+$/, "")
  return BYOK_PROVIDERS.find((p) => p.baseUrl === clean)?.value ?? "custom"
}

/** Same rules as the backend (provider-service.ts), so a bad value fails before the request. */
export const MODEL_FORMAT = /^[A-Za-z0-9._:/@+-]{1,100}$/
export const API_KEY_FORMAT = /^[\x21-\x7e]{8,512}$/
/** BotFather format, same as telegram-service.ts. */
export const TELEGRAM_TOKEN_FORMAT = /^\d{5,15}:[A-Za-z0-9_-]{30,50}$/
export const TELEGRAM_USER_ID_FORMAT = /^\d{1,15}$/
export const MAX_TELEGRAM_USERS = 20
