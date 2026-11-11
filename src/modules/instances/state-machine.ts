import type { InstanceStatus } from '@prisma/client';

const T: Record<InstanceStatus, readonly InstanceStatus[]> = {
  PENDING: ['PROVISIONING'],
  PROVISIONING: ['CONFIGURING', 'FAILED'],
  CONFIGURING: ['STARTING', 'FAILED'],
  STARTING: ['ACTIVE', 'DEGRADED', 'FAILED'],
  ACTIVE: ['DEGRADED', 'STOPPED', 'STARTING', 'DELETING'],
  DEGRADED: ['ACTIVE', 'STOPPED', 'STARTING', 'DELETING'],
  STOPPED: ['STARTING', 'DELETING'],
  FAILED: ['PROVISIONING', 'DELETING'],
  DELETING: ['DELETED'],
  DELETED: [],
};

export function canTransition(from: InstanceStatus, to: InstanceStatus): boolean {
  return T[from].includes(to);
}
