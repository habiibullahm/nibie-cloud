import type { Instance, Plan, PrismaClient } from '@prisma/client';
import type { RuntimeConfig, RuntimeConfigLoader } from '../integrations/runtime-env.js';
import { deriveApiKey } from '../runtime/api-key.js';
import type { DiskQuotaMode, EgressPolicyMode, RuntimeManager, RuntimeSpec, SupportedRuntime } from '../runtime/types.js';

export interface SpecDeps {
  masterKey: string;
  diskQuota: DiskQuotaMode;
  egressPolicy: EgressPolicyMode;
  containerRuntime?: SupportedRuntime | undefined;
  /** See `RuntimeSpec.dns`. Empty or unset: the container keeps Docker's embedded resolver. */
  dnsResolvers?: string[] | undefined;
}

/** The one place a container's spec is assembled: platform defaults first, then the customer configuration. */
export function runtimeSpec(d: SpecDeps, inst: Pick<Instance, 'id' | 'tenantId' | 'image'>, plan: Plan, cfg: RuntimeConfig): RuntimeSpec {
  return {
    instanceId: inst.id,
    tenantId: inst.tenantId,
    image: inst.image,
    limits: { cpuMillis: plan.cpuMillis, memoryMb: plan.memoryMb, pids: plan.pids, storageMb: plan.storageMb },
    diskQuota: d.diskQuota,
    egressPolicy: d.egressPolicy,
    env: { ...cfg.env, HERMES_INSTANCE_ID: inst.id },
    apiServerKey: deriveApiKey(d.masterKey, inst.id),
    ...(d.containerRuntime ? { runtime: d.containerRuntime } : {}),
    ...(d.dnsResolvers && d.dnsResolvers.length > 0 ? { dns: d.dnsResolvers } : {}),
    ...(cfg.model !== undefined ? { modelConfig: cfg.model } : {}),
  };
}

/** Monotonic: a late writer can never move the applied revision backwards. */
export async function markApplied(prisma: PrismaClient, instanceId: string, revision: number): Promise<void> {
  await prisma.instance.updateMany({ where: { id: instanceId, appliedRevision: { lt: revision } }, data: { appliedRevision: revision } });
}

/**
 * Starts (`start`) or restarts (`restart`) a container. When the running container predates the latest
 * configuration (`appliedRevision < configRevision`) it is recreated with the new environment and model
 * block first (volume kept), so a replaced or revoked credential never survives a restart. Otherwise this is
 * the plain runtime call it always was.
 */
export async function startOrRecreate(
  d: SpecDeps & { prisma: PrismaClient; runtime: RuntimeManager; loader: RuntimeConfigLoader },
  inst: Instance,
  op: 'start' | 'restart',
): Promise<void> {
  if (inst.appliedRevision >= inst.configRevision) {
    await d.runtime[op](inst.id);
    return;
  }
  const plan = await d.prisma.plan.findUniqueOrThrow({ where: { id: inst.planId } });
  const cfg = await d.loader(inst.tenantId, inst.id);
  await d.runtime.recreate(runtimeSpec(d, inst, plan, cfg));
  // The container now has this configuration whether or not it starts cleanly.
  await markApplied(d.prisma, inst.id, cfg.revision);
  await d.runtime.start(inst.id);
}
