import { z } from 'zod';

export const AGENT_API = '/v1/runtime';
export const AGENT_VERSION = 1;
export const nodeName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const uuid = z.uuid();
const dimension = z.number().int().positive();
const key = z.string().min(1).max(4096);
export const quotaList = z.array(z.strictObject({ instanceId: uuid, storageMb: dimension })).max(1_000);
export type QuotaList = z.infer<typeof quotaList>;

const spec = z.strictObject({
  instanceId: uuid, tenantId: uuid, image: z.string().min(1).max(512),
  limits: z.strictObject({ cpuMillis: dimension, memoryMb: dimension, pids: dimension, storageMb: dimension }),
  diskQuota: z.enum(['enforce', 'off']), egressPolicy: z.enum(['enforce', 'off']),
  env: z.strictObject({
    HERMES_INSTANCE_ID: uuid.optional(), HERMES_PROVIDER_API_KEY: key.optional(),
    TELEGRAM_BOT_TOKEN: key.optional(), TELEGRAM_ALLOWED_USERS: z.string().max(32_768).optional(),
  }),
  runtime: z.enum(['runc', 'runsc']).optional(), dns: z.array(z.ipv4()).max(8).optional(),
  apiServerKey: key.optional(),
  modelConfig: z.strictObject({ default: key, baseUrl: z.url().max(4096), keyEnv: z.literal('HERMES_PROVIDER_API_KEY') }).nullish(),
});

export const agentCall = z.discriminatedUnion('op', [
  z.strictObject({ op: z.enum(['ensure', 'recreate']), spec }),
  z.strictObject({ op: z.enum(['start', 'restart', 'inspect', 'assertVolumeQuota', 'assertNetworkPolicy', 'backup']), instanceId: uuid }),
  z.strictObject({ op: z.literal('stop'), instanceId: uuid, timeoutSec: z.number().int().min(0).max(30).optional() }),
  z.strictObject({ op: z.literal('remove'), instanceId: uuid, deleteVolume: z.boolean() }),
  z.strictObject({ op: z.literal('logs'), instanceId: uuid, tail: z.number().int().min(1).max(500) }),
  z.strictObject({ op: z.literal('checkHealth'), instanceId: uuid, apiServerKey: key.optional() }),
  z.strictObject({ op: z.enum(['ready', 'volumeUsage']) }),
  z.strictObject({ op: z.literal('quotaPolicy'), volumes: quotaList }),
]);
export type AgentCall = z.infer<typeof agentCall>;
export const AGENT_ERRORS = ['volume_quota_missing', 'network_policy_missing', 'config_unreadable', 'runtime_unavailable'] as const;
