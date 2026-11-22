import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { agentCall, nodeName, quotaList } from '../../src/modules/runtime/agent-protocol.js';

const UUID = randomUUID();
const TENANT = randomUUID();

const validSpec = {
  instanceId: UUID,
  tenantId: TENANT,
  image: 'nousresearch/hermes-agent@sha256:' + 'a'.repeat(64),
  limits: { cpuMillis: 1000, memoryMb: 1024, pids: 256, storageMb: 4096 },
  diskQuota: 'enforce' as const,
  egressPolicy: 'enforce' as const,
  env: { HERMES_INSTANCE_ID: UUID },
  runtime: 'runsc' as const,
  dns: ['1.1.1.1'],
};

describe('runtime agent protocol', () => {
  it('accepts valid node names and rejects uppercase, underscores, and traversal', () => {
    expect(nodeName.safeParse('jkt-1').success).toBe(true);
    expect(nodeName.safeParse('sg-02').success).toBe(true);
    for (const bad of ['', '-jkt', 'JKT-1', 'jkt_1', '../jkt', 'a'.repeat(64)]) {
      expect(nodeName.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('accepts valid agent calls across all operations', () => {
    const calls = [
      { op: 'ready' },
      { op: 'volumeUsage' },
      { op: 'ensure', spec: validSpec },
      { op: 'recreate', spec: { ...validSpec, modelConfig: { default: 'gpt-4o', baseUrl: 'https://router.nibie.app/v1', keyEnv: 'HERMES_PROVIDER_API_KEY' } } },
      { op: 'start', instanceId: UUID },
      { op: 'stop', instanceId: UUID, timeoutSec: 10 },
      { op: 'restart', instanceId: UUID },
      { op: 'inspect', instanceId: UUID },
      { op: 'backup', instanceId: UUID },
      { op: 'assertVolumeQuota', instanceId: UUID },
      { op: 'assertNetworkPolicy', instanceId: UUID },
      { op: 'remove', instanceId: UUID, deleteVolume: true },
      { op: 'logs', instanceId: UUID, tail: 200 },
      { op: 'checkHealth', instanceId: UUID, apiServerKey: 'k'.repeat(32) },
      { op: 'quotaPolicy', volumes: [{ instanceId: UUID, storageMb: 2048 }] },
    ];
    for (const c of calls) {
      expect(agentCall.safeParse(c).success, c.op).toBe(true);
    }
  });

  it('rejects unknown fields, arbitrary env injection, and out-of-range parameters', () => {
    expect(agentCall.safeParse({ op: 'ready', extra: true }).success).toBe(false);
    expect(agentCall.safeParse({ op: 'ensure', spec: { ...validSpec, env: { LD_PRELOAD: '/tmp/x.so' } } }).success).toBe(false);
    expect(agentCall.safeParse({ op: 'ensure', spec: { ...validSpec, limits: { ...validSpec.limits, memoryMb: 0 } } }).success).toBe(false);
    expect(agentCall.safeParse({ op: 'logs', instanceId: UUID, tail: 501 }).success).toBe(false);
    expect(agentCall.safeParse({ op: 'stop', instanceId: UUID, timeoutSec: 31 }).success).toBe(false);
    expect(agentCall.safeParse({ op: 'start', instanceId: 'not-a-uuid' }).success).toBe(false);
    expect(quotaList.safeParse([{ instanceId: UUID, storageMb: -1 }]).success).toBe(false);
  });
});
