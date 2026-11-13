import { describe, expect, it } from 'vitest';
import { isForbiddenAddress } from '../../src/modules/net/ip-ranges.js';

describe('isForbiddenAddress', () => {
  it.each([
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.254',
    '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1', '64:ff9b::7f00:1', '2002:7f00:1::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe',
  ])('forbids %s', (ip) => {
    expect(isForbiddenAddress(ip)).toBe(true);
  });

  it.each(['1.1.1.1', '8.8.8.8', '104.18.0.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8'])(
    'allows %s',
    (ip) => {
      expect(isForbiddenAddress(ip)).toBe(false);
    },
  );

  it('forbids anything that is not an IP address (fail closed)', () => {
    expect(isForbiddenAddress('example.com')).toBe(true);
    expect(isForbiddenAddress('')).toBe(true);
    expect(isForbiddenAddress('999.1.1.1')).toBe(true);
  });
});
