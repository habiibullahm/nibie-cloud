import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = 'ops/egress/hermes-egress.sh';
const hasBash = spawnSync('bash', ['--version']).status === 0;
if (!hasBash) console.warn('egress-rules tests skipped: bash is not available');

const BLOCKED = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4',
];

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'egress-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function run(args: string[], config?: string) {
  const file = join(dir, `conf-${n += 1}`);
  writeFileSync(file, config ?? '');
  const r = spawnSync('bash', [SCRIPT, ...args, '--config', file], { encoding: 'utf8' });
  const lines = r.stdout.split('\n').filter(Boolean).map((l) => l.replace(/^iptables -w /, ''));
  return { status: r.status, lines, stdout: r.stdout, stderr: r.stderr };
}
const apply = (config?: string) => run(['apply', '--dry-run'], config);
/** Rules appended to the chain, in order (without the "-A HERMES-EGRESS " prefix). */
const rules = (lines: string[]) => lines.filter((l) => l.startsWith('-A HERMES-EGRESS ')).map((l) => l.slice('-A HERMES-EGRESS '.length));
const idx = (rs: string[], re: RegExp) => rs.findIndex((r) => re.test(r));

describe.skipIf(!hasBash)('hermes-egress.sh apply --dry-run', () => {
  it('creates chain HERMES-EGRESS and jumps to it from DOCKER-USER and INPUT for -i hn+', () => {
    const { status, lines } = apply();
    expect(status).toBe(0);
    expect(lines).toContain('-N HERMES-EGRESS');
    expect(lines).toContain('-F HERMES-EGRESS');
    expect(lines).toContain('-I DOCKER-USER 1 -i hn+ -j HERMES-EGRESS');
    expect(lines).toContain('-I INPUT 1 -i hn+ -j HERMES-EGRESS');
    // The chain is filled before anything jumps to it.
    const firstJump = lines.findIndex((l) => l.includes('-j HERMES-EGRESS'));
    const lastRule = lines.map((l) => l.startsWith('-A HERMES-EGRESS ')).lastIndexOf(true);
    expect(firstJump).toBeGreaterThan(lastRule);
  });

  it('accepts established traffic first', () => {
    const rs = rules(apply().lines);
    expect(rs[0]).toBe('-m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT');
  });

  it('accepts DNS only to each configured resolver', () => {
    const rs = rules(apply('RESOLVERS="192.0.2.53 198.51.100.7"\n').lines);
    for (const ip of ['192.0.2.53', '198.51.100.7']) {
      expect(rs).toContain(`-p udp -d ${ip} --dport 53 -j ACCEPT`);
      expect(rs).toContain(`-p tcp -d ${ip} --dport 53 -j ACCEPT`);
    }
    expect(rs.filter((r) => r.includes('--dport 53'))).toHaveLength(4);
    expect(rs.some((r) => /--dport 53/.test(r) && !/-d \d/.test(r))).toBe(false);
  });

  it('emits no exception rules when EXCEPTIONS is empty and one ACCEPT per ip:port otherwise, before the rejects', () => {
    const ports = rules(apply().lines).flatMap((r) => [...r.matchAll(/--dport (\d+)/g)].map((m) => m[1]));
    expect(ports.every((p) => p === '25')).toBe(true);
    const rs = rules(apply('EXCEPTIONS="192.0.2.10:8080 198.51.100.20:443"\n').lines);
    expect(rs).toContain('-p tcp -d 192.0.2.10 --dport 8080 -j ACCEPT');
    expect(rs).toContain('-p tcp -d 198.51.100.20 --dport 443 -j ACCEPT');
    const firstReject = idx(rs, /-j REJECT/);
    expect(idx(rs, /--dport 8080 -j ACCEPT/)).toBeLessThan(firstReject);
    expect(idx(rs, /--dport 443 -j ACCEPT/)).toBeLessThan(firstReject);
  });

  it('rejects TCP 25 before the rate cap and before the range rejects', () => {
    const rs = rules(apply().lines);
    const smtp = idx(rs, /-p tcp --dport 25 -j REJECT/);
    expect(smtp).toBeGreaterThan(-1);
    expect(smtp).toBeLessThan(idx(rs, /hashlimit/));
    expect(smtp).toBeLessThan(idx(rs, /-d 10\.0\.0\.0\/8 -j REJECT/));
  });

  it('rate-caps new connections per source with hashlimit, dropping above the cap, before the range rejects', () => {
    const rs = rules(apply().lines);
    const i = idx(rs, /hashlimit/);
    expect(i).toBeGreaterThan(-1);
    expect(rs[i]).toMatch(/-m conntrack --ctstate NEW/);
    expect(rs[i]).toMatch(/--hashlimit-above \d+\/(sec|min|hour)/);
    expect(rs[i]).toMatch(/--hashlimit-mode srcip/);
    expect(rs[i]).toMatch(/-j DROP$/);
    expect(i).toBeLessThan(idx(rs, /-d 10\.0\.0\.0\/8 -j REJECT/));
  });

  it('uses NEW_CONN_RATE from the config and rejects a malformed one', () => {
    expect(rules(apply('NEW_CONN_RATE="40/min"\n').lines).find((r) => r.includes('hashlimit'))).toMatch(/--hashlimit-above 40\/min/);
    const bad = apply('NEW_CONN_RATE="lots"\n');
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toBe('');
  });

  it('rejects every blocked range from the spec, including 169.254.0.0/16', () => {
    const rs = rules(apply().lines);
    for (const cidr of BLOCKED) expect(rs).toContain(`-d ${cidr} -j REJECT`);
    expect(rs).toContain('-d 169.254.0.0/16 -j REJECT');
  });

  it('rejects addresses local to the host (only INPUT traffic can match) after the exceptions', () => {
    const rs = rules(apply('EXCEPTIONS="192.0.2.10:8080"\n').lines);
    const local = rs.filter((r) => r.includes('--dst-type LOCAL'));
    expect(local).toEqual(['-m addrtype --dst-type LOCAL -j REJECT']);
    expect(idx(rs, /--dst-type LOCAL/)).toBeGreaterThan(idx(rs, /--dport 8080 -j ACCEPT/));
  });

  it('ends with RETURN so Docker and the host firewall still see the public traffic', () => {
    const rs = rules(apply().lines);
    expect(rs[rs.length - 1]).toBe('-j RETURN');
    expect(rs.filter((r) => r === '-j RETURN')).toHaveLength(1);
  });

  it('contains no rule that matches a hostname', () => {
    const out = apply('RESOLVERS="192.0.2.53"\nEXCEPTIONS="192.0.2.10:8080"\n').lines;
    for (const l of out) {
      for (const m of l.matchAll(/-d (\S+)/g)) expect(m[1]).toMatch(/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/);
      expect(l).not.toMatch(/--(dst|src)-?name|\.(com|net|org|io)\b/i);
    }
  });

  it('ignores comments and blank lines in the config', () => {
    const r = apply('# resolvers\n\nRESOLVERS="192.0.2.53"  # primary\n');
    expect(r.status).toBe(0);
    expect(rules(r.lines)).toContain('-p udp -d 192.0.2.53 --dport 53 -j ACCEPT');
  });

  it('rejects a malformed resolver or exception: non-zero exit and nothing printed', () => {
    for (const conf of [
      'RESOLVERS="not-an-ip"\n', 'RESOLVERS="192.0.2.300"\n', 'RESOLVERS="192.0.2.1/24"\n', 'RESOLVERS="2001:db8::1"\n',
      'EXCEPTIONS="192.0.2.10"\n', 'EXCEPTIONS="192.0.2.10:0"\n', 'EXCEPTIONS="192.0.2.10:99999"\n',
      'EXCEPTIONS="host.example:80"\n', 'EXCEPTIONS="192.0.2.10:80; reboot"\n', 'RESOLVERS="192.0.2.1 $(reboot)"\n',
    ]) {
      const r = apply(conf);
      expect(r.status, conf).not.toBe(0);
      expect(r.stdout, conf).toBe('');
      expect(r.stderr, conf).not.toBe('');
    }
  });

  it('rejects an unknown config key and never executes the config', () => {
    const marker = join(dir, 'executed');
    const r = apply(`RESOLVERS=""\ntouch ${marker}\nFOO=bar\n`);
    expect(r.status).not.toBe(0);
    const { status } = spawnSync('test', ['-e', marker]);
    expect(status).not.toBe(0);
  });

  it('fails with a clear message when the config file is missing', () => {
    const r = spawnSync('bash', [SCRIPT, 'apply', '--dry-run', '--config', join(dir, 'does-not-exist')], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/config/i);
  });

  it('prints the same commands on a second run (deterministic, idempotent shape)', () => {
    expect(apply('RESOLVERS="192.0.2.53"\n').lines).toEqual(apply('RESOLVERS="192.0.2.53"\n').lines);
  });
});

describe.skipIf(!hasBash)('hermes-egress.sh remove and status --dry-run', () => {
  it('remove deletes the jumps, then flushes and deletes the chain', () => {
    const { status, lines } = run(['remove', '--dry-run']);
    expect(status).toBe(0);
    expect(lines).toEqual([
      '-D DOCKER-USER -i hn+ -j HERMES-EGRESS',
      '-D INPUT -i hn+ -j HERMES-EGRESS',
      '-F HERMES-EGRESS',
      '-X HERMES-EGRESS',
    ]);
  });

  it('status --dry-run lists the checks it would run', () => {
    const { status, lines } = run(['status', '--dry-run']);
    expect(status).toBe(0);
    expect(lines).toContain('-S HERMES-EGRESS');
    expect(lines).toContain('-C DOCKER-USER -i hn+ -j HERMES-EGRESS');
    expect(lines).toContain('-C INPUT -i hn+ -j HERMES-EGRESS');
  });

  it('refuses an unknown subcommand', () => {
    const r = spawnSync('bash', [SCRIPT, 'frobnicate'], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage/i);
  });
});
