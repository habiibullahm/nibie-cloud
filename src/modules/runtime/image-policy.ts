import { ValidationError } from '../../shared/errors.js';

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * Hermes images must be pinned (PRD 7.1): never `latest`, never untagged.
 * In production a content digest is required.
 */
export function assertPinnedImage(image: string, opts: { production: boolean }): void {
  const fail = (why: string): never => {
    throw new ValidationError(`Hermes image is not pinned: ${why}`);
  };
  if (!image || /\s/.test(image)) fail('empty or contains whitespace');

  let ref = image;
  let digest: string | undefined;
  const at = image.indexOf('@');
  if (at >= 0) {
    digest = image.slice(at + 1);
    ref = image.slice(0, at);
    if (!DIGEST.test(digest)) fail('malformed digest');
  }

  const lastSlash = ref.lastIndexOf('/');
  const colon = ref.indexOf(':', lastSlash + 1);
  const tag = colon >= 0 ? ref.slice(colon + 1) : undefined;

  if (colon >= 0 && !tag) fail('empty tag');
  if (tag?.toLowerCase() === 'latest') fail('tag "latest" is not allowed');
  if (!tag && !digest) fail('an explicit tag or digest is required');
  if (opts.production && !digest) fail('production requires an @sha256 digest');
}
