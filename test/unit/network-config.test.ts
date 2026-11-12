import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  LABEL_INSTANCE, LABEL_MANAGED, LABEL_TENANT, bridgeName, buildNetworkConfig, networkName,
} from '../../src/modules/runtime/hardening.js';

const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

describe('bridgeName', () => {
  it('is hn plus the first 12 hex characters of the uuid without dashes', () => {
    expect(bridgeName(ID)).toBe('hn0a1b2c3d4e5f');
  });

  it('is 14 characters and stays within the 15 character interface limit', () => {
    for (let i = 0; i < 50; i += 1) {
      const n = bridgeName(randomUUID());
      expect(n).toHaveLength(14);
      expect(n).toMatch(/^hn[0-9a-f]{12}$/);
    }
  });

  it('is the same for upper and lower case ids', () => {
    expect(bridgeName(ID.toUpperCase())).toBe(bridgeName(ID));
  });

  it('rejects a non-UUID', () => {
    for (const bad of ['', 'abc', 'hermes; rm -rf /', `${ID}x`, '../etc']) {
      expect(() => bridgeName(bad)).toThrow('Invalid instance id');
    }
  });
});

describe('buildNetworkConfig', () => {
  it('disables IPv6 and ICC and sets the bridge name', () => {
    const c = buildNetworkConfig(ID);
    expect(c.Driver).toBe('bridge');
    expect(c.EnableIPv6).toBe(false);
    expect(c.Name).toBe(networkName(ID));
    expect(c.Options).toEqual({
      'com.docker.network.bridge.name': bridgeName(ID),
      'com.docker.network.bridge.enable_icc': 'false',
    });
  });

  it('keeps the managed and instance labels', () => {
    expect(buildNetworkConfig(ID).Labels).toEqual({ [LABEL_MANAGED]: 'true', [LABEL_INSTANCE]: ID });
  });

  it('adds the tenant label only when a tenant id is given', () => {
    const t = randomUUID();
    expect(buildNetworkConfig(ID, t).Labels?.[LABEL_TENANT]).toBe(t);
    expect(buildNetworkConfig(ID).Labels?.[LABEL_TENANT]).toBeUndefined();
  });
});
