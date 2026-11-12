import { describe, expect, it } from 'vitest';
import { nextDiskLevel, type DiskLevel } from '../../src/modules/instances/disk-monitor.js';

const LIMIT = 1000;
const at = (prev: DiskLevel, pct: number) => nextDiskLevel(prev, (LIMIT * pct) / 100, LIMIT);

describe('nextDiskLevel', () => {
  it('ok to warning at 90%', () => {
    expect(at('ok', 89.9)).toBe('ok');
    expect(at('ok', 90)).toBe('warning');
  });

  it('ok to full at 99%', () => {
    expect(at('ok', 98.9)).toBe('warning');
    expect(at('ok', 99)).toBe('full');
    expect(at('ok', 100)).toBe('full');
  });

  it('warning stays warning at 89% and 90%', () => {
    expect(at('warning', 89)).toBe('warning');
    expect(at('warning', 90)).toBe('warning');
  });

  it('warning to ok only below 85%', () => {
    expect(at('warning', 85)).toBe('warning');
    expect(at('warning', 84.9)).toBe('ok');
  });

  it('warning to full at 99%', () => {
    expect(at('warning', 99)).toBe('full');
  });

  it('full to warning only below 97%', () => {
    expect(at('full', 97)).toBe('full');
    expect(at('full', 96.9)).toBe('warning');
  });

  it('full stays full at 98%', () => {
    expect(at('full', 98)).toBe('full');
  });

  it('full jumps straight to ok below 85%', () => {
    expect(at('full', 84.9)).toBe('ok');
  });

  it('a zero or negative limit returns the previous level', () => {
    expect(nextDiskLevel('warning', 500, 0)).toBe('warning');
    expect(nextDiskLevel('full', 500, -1)).toBe('full');
  });

  it('a negative or non-finite usage returns the previous level', () => {
    expect(nextDiskLevel('warning', -1, LIMIT)).toBe('warning');
    expect(nextDiskLevel('ok', Number.NaN, LIMIT)).toBe('ok');
  });
});
