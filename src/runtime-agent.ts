import 'dotenv/config';
import { z } from 'zod';
import { isIPv4 } from 'node:net';
import { buildRuntimeAgent } from './modules/runtime/agent-server.js';
import { nodeName } from './modules/runtime/agent-protocol.js';
import { loadAgentTls } from './modules/runtime/fleet.js';
import { openHostRuntime } from './modules/runtime/host-runtime.js';
import { assertPinnedImage } from './modules/runtime/image-policy.js';
import { createLogger } from './shared/logger.js';

const privateAddress = z.string().refine((ip) => {
  if (!isIPv4(ip)) return false;
  const [a, b = -1] = ip.split('.').map(Number);
  return a === 127 || a === 10 || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
});
const env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  HERMES_AGENT_NAME: nodeName,
  HERMES_AGENT_BIND: privateAddress,
  HERMES_AGENT_PORT: z.coerce.number().int().min(1024).max(65535).default(9443),
  HERMES_AGENT_TLS_DIR: z.string().min(1),
  HERMES_AGENT_QUOTA_FILE: z.string().optional(),
  DOCKER_SOCKET_PATH: z.string().default('/var/run/docker.sock'),
  HERMES_RUNTIME: z.enum(['runc', 'runsc']).default('runsc'),
  HERMES_DISK_QUOTA: z.enum(['enforce', 'off']).default('enforce'),
  HERMES_EGRESS_POLICY: z.enum(['enforce', 'off']).default('enforce'),
  HERMES_CANARY_IMAGE: z.string().optional(),
  HERMES_CANARY_PRIVATE_IP: z.ipv4().optional(),
  HERMES_DNS_RESOLVERS: z.string().default('').transform((v) => v.split(/[\s,]+/).filter(Boolean)).pipe(z.array(z.ipv4()).max(8)),
}).parse(process.env);
const production = env.NODE_ENV === 'production';
if (production && (env.HERMES_RUNTIME !== 'runsc' || env.HERMES_DISK_QUOTA !== 'enforce' || env.HERMES_EGRESS_POLICY !== 'enforce')) {
  throw new Error('Production agents require runsc, disk quota and egress enforcement');
}
if (production && !env.HERMES_AGENT_QUOTA_FILE) throw new Error('An agent quota inventory file is required');
if (env.HERMES_CANARY_IMAGE) assertPinnedImage(env.HERMES_CANARY_IMAGE, { production });
const config = {
  dockerSocketPath: env.DOCKER_SOCKET_PATH, runtime: env.HERMES_RUNTIME,
  diskQuota: env.HERMES_DISK_QUOTA, egressPolicy: env.HERMES_EGRESS_POLICY,
  canaryImage: env.HERMES_CANARY_IMAGE, canaryPrivateIp: env.HERMES_CANARY_PRIVATE_IP, dnsResolvers: env.HERMES_DNS_RESOLVERS,
};
const logger = createLogger();
const { docker, runtime } = await openHostRuntime(config, logger);
const app = buildRuntimeAgent({
  tls: await loadAgentTls(env.HERMES_AGENT_TLS_DIR), name: env.HERMES_AGENT_NAME,
  production, config, runtime, ping: () => docker.ping(), logger,
  quotaFile: env.HERMES_AGENT_QUOTA_FILE,
});
await app.listen({ host: env.HERMES_AGENT_BIND, port: env.HERMES_AGENT_PORT });
logger.info({ node: env.HERMES_AGENT_NAME }, 'runtime agent ready');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
