import { createHmac } from 'node:crypto';
import { ValidationError } from '../../shared/errors.js';
import { isUuid } from '../../shared/uuid.js';

/** Versioned domain label: a future derivation scheme can coexist under a new label. */
export const API_KEY_LABEL = 'hermes-cloud/api-server-key/v1:';

/**
 * Per-instance API_SERVER_KEY, derived rather than stored: the same master key and instance id
 * always give the same key, so the reconciler can recreate a container with the key it had.
 */
export function deriveApiKey(masterKey: string, instanceId: string): string {
  if (!isUuid(instanceId)) throw new ValidationError('Invalid instance id');
  return createHmac('sha256', masterKey).update(`${API_KEY_LABEL}${instanceId.toLowerCase()}`).digest('hex');
}
