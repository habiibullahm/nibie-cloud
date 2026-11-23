import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Runs `hermes-watchdog.sh` with fake `docker`, `systemctl` and `curl` on PATH: every container runs, no unit is failed,
// readyz does not answer and there is no database dump. Needs bash and GNU coreutils, so it runs on Linux (CI) only.
const SCRIPT = resolve('ops/host/hermes-watchdog.sh');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function watchdog(role: string) {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const fake = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  fake('docker', `case "$1" in inspect) echo true ;; restart) touch "${join(dir, 'restarted')}" ;; esac`);
  fake('systemctl', 'exit 1');
  fake('curl', 'exit 7');
  writeFileSync(join(dir, 'ops.env'), `OPS_ROLE=${role}\n`);
  const run = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      OPS_ENV_FILE: join(dir, 'ops.env'),
      OPS_STATE_DIR: join(dir, 'state'),
      DUMP_DIR: join(dir, 'dumps'),
      OFFSITE_LOG: join(dir, 'offsite.log'),
    },
  });
  return { status: run.status, out: run.stdout + run.stderr, restarted: existsSync(join(dir, 'restarted')) };
}

describe.skipIf(process.platform === 'win32')('hermes-watchdog OPS_ROLE', () => {
  it('node: skips readyz and the database dump checks, so a runtime node raises no alert', () => {
    const r = watchdog('node');
    expect(r.status).toBe(0);
    expect(r.out).not.toMatch(/readyz|ALERT/);
    expect(r.restarted).toBe(false);
  });

  it('control: still alerts on a missing database dump and counts readyz failures', () => {
    const r = watchdog('control');
    expect(r.status).toBe(0);
    expect(r.out).toContain('readyz failed (1 in a row)');
    expect(r.out).toContain('ALERT backup');
    expect(r.out).toContain('ALERT offsite');
  });

  it('refuses an unknown role and says so', () => {
    const r = watchdog('nodes');
    expect(r.status).toBe(1);
    expect(r.out).toContain("ALERT role: OPS_ROLE 'nodes' tidak dikenal");
  });
});
