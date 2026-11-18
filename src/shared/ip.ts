import { isIP } from 'node:net';

/**
 * The eight 16-bit groups of a valid IPv6 address, as lowercase hex without leading zeros. An embedded IPv4 tail
 * (`::1.2.3.4`) stands for two groups and is written as zeros: it only ever sits in the last 32 bits, which no caller reads.
 * Call it only after `isIP(ip) === 6`.
 */
export function ipv6Groups(ip: string): string[] {
  const halves = ip.split('%')[0]!.toLowerCase().split('::');
  const groups = (s: string): string[] => (s === '' ? [] : s.split(':')).flatMap((g) => (g.includes('.') ? ['0', '0'] : [g]));
  const head = groups(halves[0]!);
  const tail = halves.length > 1 ? groups(halves[1]!) : [];
  const full = halves.length > 1 ? [...head, ...new Array<string>(8 - head.length - tail.length).fill('0'), ...tail] : head;
  return full.map((g) => Number.parseInt(g, 16).toString(16));
}

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * An address cut down for logs: the network, not the person. IPv4 keeps its /24 (`203.0.113.0`), IPv6 its /48
 * (`2001:db8:1::`), and an IPv4-mapped IPv6 address is treated as the IPv4 address it wraps. Anything that is not an IP
 * returns undefined, so a bad value never reaches a log line.
 */
export function maskIp(ip: string | undefined | null): string | undefined {
  if (!ip) return undefined;
  const kind = isIP(ip);
  if (kind === 4) return `${ip.split('.').slice(0, 3).join('.')}.0`;
  if (kind !== 6) return undefined;
  const mapped = MAPPED_V4.exec(ip);
  if (mapped) return `${mapped[1]!.split('.').slice(0, 3).join('.')}.0`;
  return `${ipv6Groups(ip).slice(0, 3).join(':')}::`;
}
