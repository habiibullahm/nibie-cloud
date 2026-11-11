import { describe, expect, it } from 'vitest';
import { canTransition } from '../../src/modules/instances/state-machine.js';

describe('canTransition', () => {
  it.each([
    ['PENDING', 'PROVISIONING'],
    ['PROVISIONING', 'CONFIGURING'],
    ['CONFIGURING', 'STARTING'],
    ['STARTING', 'ACTIVE'],
    ['STARTING', 'DEGRADED'],
    ['ACTIVE', 'DEGRADED'],
    ['DEGRADED', 'ACTIVE'],
    ['ACTIVE', 'STOPPING'],
    ['DEGRADED', 'STOPPING'],
    ['STOPPING', 'STOPPED'],
    ['STOPPED', 'STARTING'],
    ['ACTIVE', 'STARTING'],
    ['DEGRADED', 'STARTING'],
    ['PROVISIONING', 'FAILED'],
    ['CONFIGURING', 'FAILED'],
    ['STARTING', 'FAILED'],
    ['FAILED', 'PROVISIONING'],
    ['ACTIVE', 'DELETING'],
    ['DEGRADED', 'DELETING'],
    ['STOPPED', 'DELETING'],
    ['FAILED', 'DELETING'],
    ['DELETING', 'DELETED'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    ['DELETED', 'ACTIVE'],
    ['DELETED', 'PROVISIONING'],
    ['STOPPED', 'ACTIVE'],
    ['ACTIVE', 'STOPPED'],
    ['STOPPING', 'ACTIVE'],
    ['PENDING', 'ACTIVE'],
    ['ACTIVE', 'ACTIVE'],
    ['DELETING', 'ACTIVE'],
    ['FAILED', 'ACTIVE'],
    ['PROVISIONING', 'DELETING'],
  ] as const)('forbids %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });
});
