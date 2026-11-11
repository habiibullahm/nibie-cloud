import { describe, expect, it } from 'vitest';
import { assertPinnedImage } from '../../src/modules/runtime/image-policy.js';
import { ValidationError } from '../../src/shared/errors.js';

const digest = 'sha256:' + 'a'.repeat(64);

describe('assertPinnedImage', () => {
  it.each(['hermes', 'hermes:latest', 'registry.example.com/x/hermes:LATEST', 'hermes:', ''])(
    'rejects %j in development',
    (img) => {
      expect(() => assertPinnedImage(img, { production: false })).toThrow(ValidationError);
    },
  );

  it('accepts an explicit non-latest tag in development', () => {
    expect(() => assertPinnedImage('hermes:1.4.2', { production: false })).not.toThrow();
  });

  it('rejects tag-only images in production', () => {
    expect(() => assertPinnedImage('hermes:1.4.2', { production: true })).toThrow(ValidationError);
  });

  it('accepts a digest-pinned image in production', () => {
    expect(() => assertPinnedImage(`reg.example.com/hermes@${digest}`, { production: true })).not.toThrow();
    expect(() => assertPinnedImage(`hermes:1.4.2@${digest}`, { production: true })).not.toThrow();
  });

  it('rejects a malformed digest', () => {
    expect(() => assertPinnedImage('hermes@sha256:abc', { production: true })).toThrow(ValidationError);
  });

  it('rejects latest even when a digest is present with a latest tag', () => {
    expect(() => assertPinnedImage(`hermes:latest@${digest}`, { production: false })).toThrow(ValidationError);
  });
});
