import { z } from 'zod';
import type { DiskQuotaMode, EgressPolicyMode, SupportedRuntime } from '../modules/runtime/types.js';

const DIGEST_PINNED = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

/** An unset variable and an empty one (`VAR=` in a .env file) both mean "not configured". */
const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

function parseOrigin(v: string, opts: { httpsOnly: boolean; allowTrailingSlash: boolean }): string | null {
  const raw = opts.allowTrailingSlash ? v.replace(/\/$/, '') : v;
  try {
    const u = new URL(raw);
    if (opts.httpsOnly && u.protocol !== 'https:') return null;
    return u.origin === raw ? raw : null;
  } catch {
    return null;
  }
}

const supabaseUrl = z.preprocess(
  emptyToUndefined,
  z.string().refine((v) => parseOrigin(v, { httpsOnly: true, allowTrailingSlash: true }) !== null).optional(),
);
const dashboardOrigin = z.preprocess(
  emptyToUndefined,
  z.string().refine((v) => parseOrigin(v, { httpsOnly: false, allowTrailingSlash: false }) !== null).optional(),
);

const redisUrl = z.preprocess(
  emptyToUndefined,
  z.string().refine((v) => {
    try {
      const p = new URL(v).protocol;
      return p === 'redis:' || p === 'rediss:';
    } catch {
      return false;
    }
  }).optional(),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  HERMES_IMAGE: z.string().min(1),
  ADMIN_TOKEN: z.string().min(24),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DOCKER_SOCKET_PATH: z.string().default('/var/run/docker.sock'),
  HERMES_MASTER_KEY: z.string().min(32),
  HERMES_RUNTIME: z.enum(['runc', 'runsc']).default('runc'),
  HERMES_DISK_QUOTA: z.enum(['enforce', 'off']).default('enforce'),
  HERMES_DISK_CHECK_INTERVAL_MS: z.coerce.number().int().min(1000).default(300_000),
  HERMES_EGRESS_POLICY: z.enum(['enforce', 'off']).default('enforce'),
  HERMES_CANARY_IMAGE: z.preprocess(emptyToUndefined, z.string().optional()),
  HERMES_CANARY_PRIVATE_IP: z.preprocess(emptyToUndefined, z.ipv4().optional()),
  /** `https://<project-ref>.supabase.co`. Unset disables the customer API. */
  SUPABASE_URL: supabaseUrl,
  /** Exact browser origin of the dashboard (no path). Unset sends no CORS headers. */
  DASHBOARD_ORIGIN: dashboardOrigin,
  /** Comma-separated emails allowed to create instances until payments exist. Empty: nobody. */
  BETA_ALLOWED_EMAILS: z.string().optional(),
  /** `redis://[:password@]host:port`. Unset runs operations inline (no queue); required in production. */
  REDIS_URL: redisUrl,
  MAX_INSTANCES_PER_TENANT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(1000).default(1)),
}).superRefine((e, ctx) => {
  // Without enforcement a tenant can fill the node's disk, so it is never allowed in production.
  if (e.NODE_ENV === 'production' && e.HERMES_DISK_QUOTA === 'off') {
    ctx.addIssue({ code: 'custom', path: ['HERMES_DISK_QUOTA'], message: 'must be enforce in production' });
  }
  // Without the host ruleset a tenant can reach the host, cloud metadata and private networks.
  if (e.NODE_ENV === 'production' && e.HERMES_EGRESS_POLICY === 'off') {
    ctx.addIssue({ code: 'custom', path: ['HERMES_EGRESS_POLICY'], message: 'must be enforce in production' });
  }
  // Without the queue a request runs the whole operation inline and a crash loses it.
  if (e.NODE_ENV === 'production' && !e.REDIS_URL) {
    ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'required in production' });
  }
  // The startup canary needs an image pinned by digest, like every other image.
  if (e.HERMES_EGRESS_POLICY === 'enforce' && (!e.HERMES_CANARY_IMAGE || !DIGEST_PINNED.test(e.HERMES_CANARY_IMAGE))) {
    ctx.addIssue({ code: 'custom', path: ['HERMES_CANARY_IMAGE'], message: 'must be name@sha256:<digest> when egress policy is enforce' });
  }
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  hermesImage: string;
  port: number;
  adminToken: string;
  dockerSocketPath: string;
  masterKey: string;
  runtime: SupportedRuntime;
  diskQuota: DiskQuotaMode;
  diskCheckIntervalMs: number;
  egressPolicy: EgressPolicyMode;
  canaryImage: string | undefined;
  canaryPrivateIp: string | undefined;
  /** Origin without a trailing slash, or null when the customer API is disabled. */
  supabaseUrl: string | null;
  dashboardOrigin: string | null;
  /** Lowercased, trimmed. Empty means nobody may provision (fail closed). */
  betaAllowedEmails: string[];
  maxInstancesPerTenant: number;
  /** Null: no job queue, operations run inline in the request. */
  redisUrl: string | null;
}

/** Parse environment. Errors name the failing keys only, never the values. */
export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new Error(`Invalid configuration: ${keys}`);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    databaseUrl: e.DATABASE_URL,
    hermesImage: e.HERMES_IMAGE,
    port: e.PORT,
    adminToken: e.ADMIN_TOKEN,
    dockerSocketPath: e.DOCKER_SOCKET_PATH,
    masterKey: e.HERMES_MASTER_KEY,
    runtime: e.HERMES_RUNTIME,
    diskQuota: e.HERMES_DISK_QUOTA,
    diskCheckIntervalMs: e.HERMES_DISK_CHECK_INTERVAL_MS,
    egressPolicy: e.HERMES_EGRESS_POLICY,
    canaryImage: e.HERMES_CANARY_IMAGE,
    canaryPrivateIp: e.HERMES_CANARY_PRIVATE_IP,
    supabaseUrl: e.SUPABASE_URL ? e.SUPABASE_URL.replace(/\/$/, '') : null,
    dashboardOrigin: e.DASHBOARD_ORIGIN ?? null,
    betaAllowedEmails: (e.BETA_ALLOWED_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
    maxInstancesPerTenant: e.MAX_INSTANCES_PER_TENANT,
    redisUrl: e.REDIS_URL ?? null,
  };
}
