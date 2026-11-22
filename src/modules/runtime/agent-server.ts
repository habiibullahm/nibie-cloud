import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import type { SecureContextOptions } from 'node:tls';
import { AppError, RuntimeUnavailableError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import { readHostUsage } from '../admin/host-usage.js';
import { readBackupMetadata } from '../instances/backup-metadata.js';
import { AGENT_API, AGENT_ERRORS, AGENT_VERSION, agentCall } from './agent-protocol.js';
import type { HostRuntimeConfig } from './host-runtime.js';
import { assertPinnedImage } from './image-policy.js';
import type { RuntimeManager } from './types.js';

export function buildRuntimeAgent(d: {
  tls: SecureContextOptions;
  name: string;
  production: boolean;
  config: HostRuntimeConfig;
  runtime: RuntimeManager;
  ping: () => Promise<unknown>;
  logger: Logger;
  hostUsageFile?: string;
  backupMetadataDir?: string;
  quotaFile?: string;
}) {
  const app = Fastify({
    https: { ...d.tls, minVersion: 'TLSv1.2', requestCert: true, rejectUnauthorized: true },
    bodyLimit: 128 * 1024,
  });
  const working = new Set<string>();
  const { runtime, config } = d;
  const check = async (id: string) => {
    await runtime.assertVolumeQuota(id, config.diskQuota);
    await runtime.assertNetworkPolicy(id, config.egressPolicy);
  };
  app.post(AGENT_API, async (req, reply) => {
    const parsed = agentCall.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const call = parsed.data;
    const id = 'spec' in call ? call.spec.instanceId : 'instanceId' in call ? call.instanceId : undefined;
    const mutates = id !== undefined && ['ensure', 'recreate', 'start', 'stop', 'restart', 'remove'].includes(call.op);
    if (mutates && working.has(id)) return reply.code(503).send({ error: 'runtime_unavailable' });
    if (mutates) working.add(id);
    try {
      let value: unknown;
      switch (call.op) {
        case 'ready':
          await d.ping();
          value = { version: AGENT_VERSION, name: d.name, host: await readHostUsage(d.hostUsageFile) };
          break;
        case 'volumeUsage': value = [...await runtime.volumeUsage()]; break;
        case 'backup': value = await readBackupMetadata(call.instanceId, d.backupMetadataDir); break;
        case 'quotaPolicy': {
          if (!d.quotaFile) break;
          const temp = `${d.quotaFile}.${randomUUID()}.tmp`;
          try {
            await writeFile(temp, JSON.stringify({ volumes: call.volumes }), { mode: 0o600, flag: 'wx' });
            await rename(temp, d.quotaFile);
          } finally { await rm(temp, { force: true }); }
          break;
        }
        case 'ensure':
        case 'recreate': {
          assertPinnedImage(call.spec.image, { production: d.production });
          const spec = { ...call.spec, runtime: config.runtime, diskQuota: config.diskQuota, egressPolicy: config.egressPolicy, dns: config.dnsResolvers };
          value = await runtime[call.op](spec);
          break;
        }
        case 'assertVolumeQuota': await runtime.assertVolumeQuota(call.instanceId, config.diskQuota); break;
        case 'assertNetworkPolicy': await runtime.assertNetworkPolicy(call.instanceId, config.egressPolicy); break;
        case 'start':
        case 'restart': await check(call.instanceId); await runtime[call.op](call.instanceId); break;
        case 'stop': await runtime.stop(call.instanceId, call.timeoutSec); break;
        case 'remove': await runtime.remove(call.instanceId, { deleteVolume: call.deleteVolume }); break;
        case 'inspect': value = await runtime.inspect(call.instanceId); break;
        case 'logs': value = await runtime.logs(call.instanceId, { tail: call.tail }); break;
        case 'checkHealth': value = await runtime.checkHealth(call.instanceId, call.apiServerKey); break;
      }
      return { value: value ?? null };
    } catch (error) {
      if (error instanceof AppError && AGENT_ERRORS.some((code) => code === error.code)) {
        return reply.code(error.status).send({ error: error.code });
      }
      if (error instanceof AppError && error.status === 400) return reply.code(400).send({ error: 'invalid_request' });
      d.logger.warn({ op: call.op, instanceId: id, errorName: error instanceof Error ? error.name : 'unknown' }, 'runtime agent operation failed');
      return reply.code(503).send({ error: new RuntimeUnavailableError().code });
    } finally {
      if (mutates) working.delete(id);
    }
  });
  return app;
}
