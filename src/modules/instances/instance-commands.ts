import type { Logger } from '../../shared/logger.js';
import type { InstanceOp, JobQueue } from '../jobs/types.js';
import { decideOp, toView, type InstanceService, type InstanceView, type ProvisionInput } from './instance-service.js';

export interface CommandResult {
  instance: InstanceView;
  /** The queued job, or null when the work ran inline or there was nothing to do. */
  jobId: string | null;
}

/**
 * What the HTTP routes call. With a queue it validates the request, records it and enqueues ids only;
 * without one (no REDIS_URL) it runs the same InstanceService call inside the request, as before.
 */
export class InstanceCommands {
  constructor(private readonly d: { service: InstanceService; queue: JobQueue | null; logger: Logger }) {}

  async provision(input: ProvisionInput): Promise<CommandResult> {
    const { service, queue, logger } = this.d;
    if (!queue) return { instance: await service.provision(input), jobId: null };
    const { instance, needsRun } = await service.createProvisioning(input);
    if (!needsRun) return { instance: toView(instance), jobId: null };
    try {
      const { jobId } = await queue.enqueue({ op: 'provision', tenantId: instance.tenantId, instanceId: instance.id });
      return { instance: toView(instance), jobId };
    } catch (e) {
      // The PENDING row is the durable intent: the sweeper enqueues it once Redis is back.
      logger.warn({ instanceId: instance.id, errName: (e as Error).name }, 'provision accepted without a job; sweeper will enqueue it');
      return { instance: toView(instance), jobId: null };
    }
  }

  start = (tenantId: string, instanceId: string) => this.run('start', tenantId, instanceId);
  stop = (tenantId: string, instanceId: string) => this.run('stop', tenantId, instanceId);
  restart = (tenantId: string, instanceId: string) => this.run('restart', tenantId, instanceId);
  delete = (tenantId: string, instanceId: string) => this.run('delete', tenantId, instanceId);

  private async run(op: Exclude<InstanceOp, 'provision'>, tenantId: string, instanceId: string): Promise<CommandResult> {
    const { service, queue } = this.d;
    if (!queue) return { instance: await service[op](tenantId, instanceId), jobId: null };
    const instance = await service.get(tenantId, instanceId); // 404 for other tenants' ids
    if (decideOp(op, instance.status) === 'noop') return { instance, jobId: null };
    const { jobId } = await queue.enqueue({ op, tenantId, instanceId });
    return { instance, jobId };
  }
}
