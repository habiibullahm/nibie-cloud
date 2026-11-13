export const INSTANCE_OPS = ['provision', 'start', 'stop', 'restart', 'delete'] as const;
export type InstanceOp = (typeof INSTANCE_OPS)[number];

/** Everything a job carries: ids only, never keys, emails, tokens or names (PRD 7.4). */
export interface InstanceOpPayload {
  op: InstanceOp;
  tenantId: string;
  instanceId: string;
}

export interface FailedJob {
  jobId: string;
  op: InstanceOp;
  instanceId: string;
  attempts: number;
  /** Error class name only; free-text messages can contain secrets. */
  reason: string;
  failedAt: Date;
}

export interface JobQueue {
  /** Adds the job, or returns the existing one with the same id. Throws `QueueUnavailableError` when Redis cannot be reached. */
  enqueue(payload: InstanceOpPayload, opts?: { dedupeKey?: string }): Promise<{ jobId: string }>;
  listFailed(): Promise<FailedJob[]>;
  /** Moves a failed job back to waiting. Throws `NotFoundError` when it is not in the failed set. */
  retryFailed(jobId: string): Promise<void>;
  close(): Promise<void>;
}
