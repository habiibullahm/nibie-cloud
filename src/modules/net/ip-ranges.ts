import { BlockList, isIP } from 'node:net';

/**
 * Every address range a tenant-supplied URL must never reach (PRD 7.3): loopback, private, link-local
 * (including the cloud metadata address), CGNAT, multicast, reserved, documentation, and the IPv6
 * transition ranges that can wrap an IPv4 address (NAT64, 6to4, Teredo). IPv4-mapped IPv6 is handled by
 * `net.BlockList`, which compares the embedded IPv4 address.
 */
const list = new BlockList();
const v4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
for (const [a, p] of v4) list.addSubnet(a, p, 'ipv4');
const v6: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];
for (const [a, p] of v6) list.addSubnet(a, p, 'ipv6');

/** True when connecting to this address must be refused. Anything that is not an IP literal is refused. */
export function isForbiddenAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return true;
  return list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}
