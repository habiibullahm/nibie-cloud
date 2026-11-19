import type { TicketsApi } from "./tickets"
import type {
  AccessInfo,
  Account,
  Backup,
  BillingSubscription,
  CheckoutResult,
  CreateInstanceInput,
  FileEntry,
  Instance,
  InstanceEvent,
  InstanceMeta,
  InstanceStatusView,
  LogLevel,
  LogLine,
  Plan,
  ProviderConfig,
  ProviderKind,
  Region,
  TelegramConfig,
  Usage,
  Wallet,
  WalletTopup,
} from "./types"

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "ApiError"
  }
}

/** Endpoints that exist on the backend today (src/http/server.ts). */
export interface InstancesApi {
  list(): Promise<Instance[]>
  get(id: string): Promise<Instance>
  status(id: string): Promise<InstanceStatusView>
  events(id: string): Promise<InstanceEvent[]>
  create(input: CreateInstanceInput, idempotencyKey: string): Promise<Instance>
  start(id: string): Promise<Instance>
  stop(id: string): Promise<Instance>
  restart(id: string): Promise<Instance>
  remove(id: string): Promise<Instance>
}

/** SumoPod billing (backend milestone D). Real in customer mode, in-memory sample data in mock mode. */
export interface BillingApi {
  /** Every subscription of the tenant, including purchases that are still waiting for payment. */
  list(): Promise<BillingSubscription[]>
  /** Starts a purchase; the instance is created by the backend only after the first verified payment. */
  checkout(input: CreateInstanceInput, idempotencyKey: string): Promise<CheckoutResult>
  /** Moves a free instance to a paid plan (data kept); the plan changes once the payment is verified. */
  upgrade(input: { instanceId: string; planId: string }, idempotencyKey: string): Promise<CheckoutResult>
  /** A new (or still open) renewal invoice for an existing subscription. */
  renew(subscriptionId: string): Promise<CheckoutResult>
  /** Stops auto-renewal only; the paid period keeps running. */
  cancel(subscriptionId: string): Promise<BillingSubscription>
  /** The Nibie Cloud wallet, or null when the backend has it switched off (WALLET_ENABLED). */
  wallet(): Promise<Wallet | null>
  /** Starts a QRIS top-up; the caller sends the customer to `paymentUrl`. */
  topup(amountIdr: number, idempotencyKey: string): Promise<WalletTopup>
}

/** PRD §15 endpoints with no backend yet. Always served by the mock. */
export interface PreviewApi {
  me(): Promise<Account>
  plans(): Promise<Plan[]>
  regions(): Promise<Region[]>
  meta(instanceId: string): Promise<InstanceMeta | null>
  access(instanceId: string): Promise<AccessInfo>
  usage(instanceId: string, range: "1h" | "24h" | "7d"): Promise<Usage>
  logs(instanceId: string, filter: { level?: LogLevel | "all"; query?: string }): Promise<LogLine[]>
  provider(instanceId: string): Promise<ProviderConfig>
  saveProvider(
    instanceId: string,
    input: { kind: ProviderKind; providerName?: string; baseUrl?: string; model?: string; apiKey?: string }
  ): Promise<ProviderConfig>
  testProvider(instanceId: string): Promise<ProviderConfig>
  telegram(instanceId: string): Promise<TelegramConfig>
  saveTelegram(instanceId: string, input: { token: string; allowlist: string[] }): Promise<TelegramConfig>
  verifyTelegram(instanceId: string): Promise<TelegramConfig>
  removeTelegram(instanceId: string): Promise<TelegramConfig>
  files(instanceId: string, path: string): Promise<FileEntry[]>
  fileContent(instanceId: string, path: string): Promise<string>
  backups(instanceId: string): Promise<Backup[]>
  createBackup(instanceId: string): Promise<Backup>
}

/**
 * mock: in-browser sample data. live: operator API through the dev bridge (local development only).
 * customer: the customer API with the signed-in user's Supabase token.
 */
export type ApiMode = "mock" | "live" | "customer"

export interface HermesApi {
  mode: ApiMode
  instances: InstancesApi
  billing: BillingApi
  /** Support tickets: real in customer mode, in memory in mock mode. */
  tickets: TicketsApi
  preview: PreviewApi
}
