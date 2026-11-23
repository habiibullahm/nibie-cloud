import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Runs `hermes-tenant-backup.sh --verify` with fake `docker` and `restic` on PATH. Needs bash, python3 and GNU coreutils,
// so it runs on Linux (CI) only.
const SCRIPT = resolve('ops/host/hermes-tenant-backup.sh');
const DELETED = '11111111-1111-4111-8111-111111111111';
const LIVE = '22222222-2222-4222-8222-222222222222';

const FAKE_RESTIC = `#!/usr/bin/env python3
import json, os, sqlite3, sys
a = sys.argv[1:]
snaps = json.load(open(os.environ["FAKE_SNAPSHOTS"]))
if a[0] == "snapshots":
    print(json.dumps(snaps))
elif a[0] == "restore":
    sid, target = a[1], a[a.index("--target") + 1]
    tag = next(t for s in snaps if s["short_id"] == sid for t in s["tags"] if t.startswith("inst-"))
    d = target + os.environ["STAGE_ROOT"] + "/" + tag[5:]
    os.makedirs(d, exist_ok=True)
    c = sqlite3.connect(d + "/state.db"); c.execute("create table t(x)"); c.commit(); c.close()
    open(os.environ["FAKE_RESTORED"], "a").write(tag + "\\n")
`;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function verify(volumes: string[], snapshots: { id: string; instance: string; time: string }[]) {
  const dir = mkdtempSync(join(tmpdir(), 'tenant-verify-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'restic'), FAKE_RESTIC);
  writeFileSync(join(bin, 'docker'), '#!/usr/bin/env bash\nprintf "%s" "$FAKE_VOLUMES"\n');
  chmodSync(join(bin, 'restic'), 0o755);
  chmodSync(join(bin, 'docker'), 0o755);
  writeFileSync(join(dir, 'env'), `RESTIC_REPOSITORY=fake\nRESTIC_PASSWORD_FILE=${join(dir, 'pw')}\n`);
  writeFileSync(join(dir, 'snaps.json'), JSON.stringify(snapshots.map((s) => ({ short_id: s.id, tags: ['tenant-vol', `inst-${s.instance}`], time: s.time }))));
  const run = spawnSync('bash', [SCRIPT, '--verify'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RESTIC_ENV_FILE: join(dir, 'env'),
      STAGE_ROOT: join(dir, 'stage'),
      LOG_FILE: join(dir, 'log'),
      BACKUP_METADATA_DIR: join(dir, 'meta'),
      FAKE_SNAPSHOTS: join(dir, 'snaps.json'),
      FAKE_RESTORED: join(dir, 'restored'),
      FAKE_VOLUMES: volumes.map((v) => `hermes-data-${v}\n`).join(''),
    },
  });
  const restored = existsSync(join(dir, 'restored')) ? readFileSync(join(dir, 'restored'), 'utf8').split('\n').filter(Boolean) : [];
  const meta = (id: string) => (existsSync(join(dir, 'meta', `verify-${id}.json`)) ? JSON.parse(readFileSync(join(dir, 'meta', `verify-${id}.json`), 'utf8')) : null);
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, restored, meta };
}

describe.skipIf(process.platform === 'win32')('hermes-tenant-backup --verify', () => {
  it('never picks a deleted instance whose last snapshot is still kept', () => {
    const snaps = [
      { id: 'aaaa0001', instance: DELETED, time: '2026-11-21T04:00:01+08:00' },
      { id: 'bbbb0001', instance: LIVE, time: '2026-11-23T04:00:50+08:00' },
    ];
    for (let i = 0; i < 5; i += 1) {
      const r = verify([LIVE], snaps);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('verify OK');
      expect(r.restored).toEqual([`inst-${LIVE}`]);
      expect(r.meta(LIVE)).toMatchObject({ status: 'passed' });
    }
  });

  it('passes with nothing to verify on a host without tenant volumes', () => {
    const r = verify([], [{ id: 'aaaa0001', instance: DELETED, time: '2026-11-21T04:00:01+08:00' }]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('nothing to verify');
    expect(r.restored).toEqual([]);
  });

  it('fails when the host has tenant volumes but none of them has a snapshot', () => {
    const r = verify([LIVE], [{ id: 'aaaa0001', instance: DELETED, time: '2026-11-21T04:00:01+08:00' }]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no snapshot of a tenant volume on this host');
    expect(r.restored).toEqual([]);
  });
});
