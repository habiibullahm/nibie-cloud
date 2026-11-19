import type { Instance, ProviderConfig, TelegramConfig } from "./api/types"

/** The instance the Quickstart checklist follows: the first running one, else the first that is not being deleted. */
export function quickstartInstance(instances: Instance[]): Instance | null {
  const live = instances.filter((i) => i.status !== "DELETED" && i.status !== "DELETING")
  return live.find((i) => i.status === "ACTIVE" || i.status === "DEGRADED") ?? live[0] ?? null
}

export interface QuickstartDone {
  deploy: boolean
  provider: boolean
  telegram: boolean
}

/** Which of the three steps are done. Telegram counts only once a test message was delivered. */
export function quickstartDone(
  instance: Instance | null,
  provider: ProviderConfig | undefined,
  telegram: TelegramConfig | undefined
): QuickstartDone {
  return {
    deploy: instance !== null,
    provider: instance !== null && provider?.configured === true,
    telegram: instance !== null && telegram?.configured === true && telegram.verified,
  }
}
