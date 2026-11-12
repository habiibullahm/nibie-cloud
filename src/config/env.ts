import { z } from 'zod';
import type { DiskQuotaMode, EgressPolicyMode, SupportedRuntime } from '../modules/runtime/types.js';

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);
const DIGEST_PINNED = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

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
}).superRefine((e, ctx) => {
  // Without enforcement a tenant can fill the node's disk, so it is never allowed in production.
  if (e.NODE_ENV === 'production' && e.HERMES_DISK_QUOTA === 'off') {
    ctx.addIssue({ code: 'custom', path: ['HERMES_DISK_QUOTA'], message: 'must be enforce in production' });
  }
  // Without the host ruleset a tenant can reach the host, cloud metadata and private networks.
  if (e.NODE_ENV === 'production' && e.HERMES_EGRESS_POLICY === 'off') {
    ctx.addIssue({ code: 'custom', path: ['HERMES_EGRESS_POLICY'], message: 'must be enforce in production' });
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
  };
}
