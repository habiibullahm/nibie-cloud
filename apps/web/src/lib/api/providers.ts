/**
 * BYOK provider presets. The backend only stores a base URL and a model name (ProviderService); a preset
 * is a dashboard convenience that fills the base URL. Anthropic is not offered: the backend tests a
 * provider with `GET {baseUrl}/models` and a Bearer token, which Anthropic's own API does not accept.
 * A preset must also accept OpenAI-style `POST {baseUrl}/chat/completions` (Hermes runs it as `provider: custom`).
 * Base URLs have no trailing slash, so `providerNameForUrl` matches them. Checked in each provider's docs, 2026-11-21.
 */
export const BYOK_PROVIDERS = [
  // The customer's own NibieRouter account: they create the key on the router's site and paste it here.
  { value: "nibierouter", label: "NibieRouter (own account)", baseUrl: "https://router.nibie.app/v1", modelHint: "model-name", keyUrl: "https://router.nibie.app" },
  { value: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", modelHint: "gpt-4o-mini", keyUrl: null },
  { value: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", modelHint: "openai/gpt-4o-mini", keyUrl: null },
  { value: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", modelHint: "gemini-4-hydrogen", keyUrl: null },
  { value: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", modelHint: "deepseek-flash", keyUrl: null },
  { value: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", modelHint: "llama-3.1-8b-instant", keyUrl: null },
  { value: "mistral", label: "Mistral AI", baseUrl: "https://api.mistral.ai/v1", modelHint: "mistral-large-latest", keyUrl: null },
  { value: "xai", label: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", modelHint: "grok-4.7", keyUrl: null },
  { value: "custom", label: "OpenAI-compatible (custom URL)", baseUrl: null, modelHint: "model-name", keyUrl: null },
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
