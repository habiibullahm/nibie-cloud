import { Document, isMap, parseDocument, YAMLMap } from 'yaml';
import { AppError } from '../../shared/errors.js';

/** The environment variable that carries the provider key; the file only ever names it (`key_env`). */
export const PROVIDER_KEY_ENV = 'HERMES_PROVIDER_API_KEY';

export interface ModelConfig {
  default: string;
  baseUrl: string;
  keyEnv: string;
}

/** The existing `config.yaml` cannot be parsed, so it is not touched. The customer must fix or reset it. */
export class ConfigUnreadableError extends AppError {
  constructor() {
    super('The instance configuration file could not be read', 409, 'config_unreadable');
  }
}

/**
 * Computes the new text of `/opt/data/config.yaml` with the platform-managed `model:` block (ADR 0003), or
 * `null` when nothing needs to be written. Every other key and comment is preserved. With `model === null`
 * the block is removed only if the platform wrote it (its `key_env` is ours); a customer's own block stays.
 */
export function applyModelBlock(existing: string | null, model: ModelConfig | null): string | null {
  if (existing === null && model === null) return null;
  const doc = existing === null ? new Document({}) : parseDocument(existing);
  if (doc.errors.length > 0) throw new ConfigUnreadableError();
  if (doc.contents !== null && !isMap(doc.contents)) throw new ConfigUnreadableError();

  if (model === null) {
    const current = doc.get('model');
    if (!isMap(current) || current.get('key_env') !== PROVIDER_KEY_ENV) return null;
    doc.delete('model');
  } else {
    let block = doc.get('model');
    if (!isMap(block)) {
      block = new YAMLMap();
      doc.set('model', block);
    }
    const m = block as YAMLMap;
    m.delete('api_key');
    m.set('default', model.default);
    m.set('provider', 'custom');
    m.set('base_url', model.baseUrl);
    m.set('key_env', model.keyEnv);
  }
  const out = doc.toString();
  if (existing !== null && out === existing) return null;
  return out;
}
