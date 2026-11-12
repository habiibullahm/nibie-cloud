import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/shared/errors.js';
import { API_KEY_LABEL, deriveApiKey } from '../../src/modules/runtime/api-key.js';

const MASTER = 'm'.repeat(32);
const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

describe('deriveApiKey', () => {
  it('is deterministic for the same master key and instance', () => {
    expect(deriveApiKey(MASTER, ID)).toBe(deriveApiKey(MASTER, ID));
  });

  it('differs per instance', () => {
    expect(deriveApiKey(MASTER, ID)).not.toBe(deriveApiKey(MASTER, randomUUID()));
  });

  it('differs per master key', () => {
    expect(deriveApiKey(MASTER, ID)).not.toBe(deriveApiKey('n'.repeat(32), ID));
  });

  it('is 64 lowercase hex characters', () => {
    expect(deriveApiKey(MASTER, ID)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats upper and lower case ids as the same instance', () => {
    expect(deriveApiKey(MASTER, ID.toUpperCase())).toBe(deriveApiKey(MASTER, ID));
  });

  it('rejects a non-UUID instance id', () => {
    expect(() => deriveApiKey(MASTER, 'not-a-uuid')).toThrow(ValidationError);
  });

  it('matches HMAC-SHA256 over the versioned label and the lower-cased id', () => {
    const expected = createHmac('sha256', MASTER).update(`hermes-cloud/api-server-key/v1:${ID}`).digest('hex');
    expect(API_KEY_LABEL).toBe('hermes-cloud/api-server-key/v1:');
    expect(deriveApiKey(MASTER, ID)).toBe(expected);
  });
});
