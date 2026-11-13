import type { SecretStore } from '../secrets/secret-store.js';
import type { ProviderService } from './provider-service.js';
import type { TelegramService } from './telegram-service.js';

/** What the HTTP layer may do with secrets: counts and rotation only, never plaintext. */
export type SecretsAdmin = Pick<SecretStore, 'rewrapAll' | 'countsByVersion'>;

export interface Integrations {
  telegram: TelegramService;
  providers: ProviderService;
  secrets: SecretsAdmin;
  /** Version of the key new secrets are sealed with. */
  kekVersion: number;
}
