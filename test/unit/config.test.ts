import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/db',
  HERMES_IMAGE: 'hermes-stub:0.1.0',
  ADMIN_TOKEN: 'a'.repeat(24),
};

describe('loadConfig', () => {
  it.each(['DATABASE_URL', 'HERMES_IMAGE', 'ADMIN_TOKEN'])('throws when %s is missing', (key) => {
    const env: Record<string, string> = { ...base };
    delete env[key];
    expect(() => loadConfig(env)).toThrow(key);
  });

  it('throws when ADMIN_TOKEN is shorter than 24 chars', () => {
    expect(() => loadConfig({ ...base, ADMIN_TOKEN: 'short' })).toThrow('ADMIN_TOKEN');
  });

  it('defaults port to 3000, nodeEnv to development and socket path', () => {
    const cfg = loadConfig(base);
    expect(cfg.port).toBe(3000);
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.dockerSocketPath).toBe('/var/run/docker.sock');
  });

  it('does not echo secret values in validation errors', () => {
    let message = '';
    try {
      loadConfig({ ...base, ADMIN_TOKEN: 'tooshort-secret' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain('tooshort-secret');
  });
});
