import { describe, expect, it } from 'vitest';
import { backoffMs } from '../../src/modules/instances/reconciler.js';

describe('backoffMs', () => {
  it('doubles from 2s and caps at 60s with jitter in [0.5, 1]', () => {
    expect(backoffMs(0, () => 1)).toBe(2000);
    expect(backoffMs(3, () => 0)).toBe(8000);
    expect(backoffMs(10, () => 1)).toBe(60000);
    expect(backoffMs(1, () => 0.5)).toBe(3000);
  });
});
