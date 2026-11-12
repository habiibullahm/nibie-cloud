import type {
  AccessInfo,
  Account,
  Backup,
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
  Subscription,
  TelegramConfig,
  Usage,
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

/** PRD §15 endpoints with no backend yet. Always served by the mock. */
export interface PreviewApi {
  me(): Promise<Account>
  plans(): Promise<Plan[]>
  regions(): Promise<Region[]>
  meta(instanceId: string): Promise<InstanceMeta | null>
  access(instanceId: string): Promise<AccessInfo>
  subscription(instanceId: string): Promise<Subscription>
  usage(instanceId: string, range: "1h" | "24h" | "7d"): Promise<Usage>
  logs(instanceId: string, filter: { level?: LogLevel | "all"; query?: string }): Promise<LogLine[]>
  provider(instanceId: string): Promise<ProviderConfig>
  saveProvider(
    instanceId: string,
    input: { kind: ProviderKind; providerName?: string; baseUrl?: string; apiKey?: string }
  ): Promise<ProviderConfig>
  testProvider(instanceId: string): Promise<ProviderConfig>
  telegram(instanceId: string): Promise<TelegramConfig>
  saveTelegram(
    instanceId: string,
    input: { token?: string; mode: "polling" | "webhook"; allowlist: string[] }
  ): Promise<TelegramConfig>
  verifyTelegram(instanceId: string): Promise<TelegramConfig>
  removeTelegram(instanceId: string): Promise<TelegramConfig>
  files(instanceId: string, path: string): Promise<FileEntry[]>
  fileContent(instanceId: string, path: string): Promise<string>
  backups(instanceId: string): Promise<Backup[]>
  createBackup(instanceId: string): Promise<Backup>
}

export type ApiMode = "mock" | "live"

export interface HermesApi {
  mode: ApiMode
  instances: InstancesApi
  preview: PreviewApi
}
