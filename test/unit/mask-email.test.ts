import { describe, expect, it } from 'vitest';
import { maskEmail } from '../../src/modules/beta/invites.js';

describe('maskEmail', () => {
  it('keeps the first and last character of the local part and the whole domain', () => {
    expect(maskEmail('husniattin@gmail.com')).toBe('h********n@gmail.com');
  });

  it('stars a short local part completely', () => {
    expect(maskEmail('a@x.test')).toBe('*@x.test');
    expect(maskEmail('ab@x.test')).toBe('**@x.test');
    expect(maskEmail('abc@x.test')).toBe('a*c@x.test');
  });

  it('never returns text that is not an address', () => {
    expect(maskEmail('not-an-email')).toBe('***');
    expect(maskEmail('@x.test')).toBe('***');
    expect(maskEmail('')).toBe('***');
  });
});
