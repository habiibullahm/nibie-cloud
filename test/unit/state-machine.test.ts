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
    ['ACTIVE', 'STOPPED'],
    ['DEGRADED', 'STOPPED'],
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
    ['PENDING', 'ACTIVE'],
    ['ACTIVE', 'ACTIVE'],
    ['DELETING', 'ACTIVE'],
    ['FAILED', 'ACTIVE'],
    ['PROVISIONING', 'DELETING'],
  ] as const)('forbids %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });
});
