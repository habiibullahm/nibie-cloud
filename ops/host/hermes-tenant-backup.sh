#!/usr/bin/env bash
# Backs up every tenant data volume (hermes-data-<instance uuid>) to the restic repository on R2, encrypted by restic.
#   hermes-tenant-backup.sh             back up all tenant volumes, then expire old snapshots
#   hermes-tenant-backup.sh --verify    restore the newest snapshot of one volume into a temp dir and check it
# Needs /etc/restic/r2/env (the same credentials as the other backups). Runs as root; touches no tenant container.
# SQLite files are copied with the online backup API (consistent even while the agent writes); everything else is
# copied as is, so a volume is crash-consistent, not application-consistent. Provider keys and Telegram tokens are
# environment variables, not files in the volume (ADR 0003), so they are not in the backup.
# Snapshots of an instance are tagged tenant-vol and inst-<uuid>. Retention: 7 days per instance; the snapshots of
# a deleted instance (its volume is gone) are removed once they are older than 7 days.
set -euo pipefail
umask 077
ENV_FILE=${RESTIC_ENV_FILE:-/etc/restic/r2/env}
STAGE_ROOT=${STAGE_ROOT:-/var/lib/hermes-backup-staging}
LOG_FILE=${LOG_FILE:-/var/log/hermes-tenant-backup.log}
KEEP_DAYS=7
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG_FILE" >&2; }
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
: "${RESTIC_REPOSITORY:?}" "${RESTIC_PASSWORD_FILE:?}"

sqlite_copy() { # sqlite_copy SRC_DIR DEST_DIR: online-backup every *.db under SRC_DIR into DEST_DIR (same layout)
  python3 - "$1" "$2" <<'PY'
import os, sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
n = 0
for root, _dirs, files in os.walk(src):
    for f in files:
        if not f.endswith(".db"):
            continue
        p = os.path.join(root, f)
        rel = os.path.relpath(p, src)
        out = os.path.join(dst, rel)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        s = sqlite3.connect("file:%s?mode=ro" % p, uri=True)
        d = sqlite3.connect(out)
        s.backup(d)
        d.close(); s.close()
        n += 1
print(n)
PY
}

if [ "${1:-}" = "--verify" ]; then
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  snap_json=$(restic snapshots --tag tenant-vol --json)
  pick=$(printf '%s' "$snap_json" | python3 -c 'import sys,json,random
s=json.load(sys.stdin)
if not s: sys.exit(1)
by={}
for x in s:
    t=[t for t in x["tags"] if t.startswith("inst-")][0]
    if t not in by or x["time"]>by[t]["time"]: by[t]=x
x=random.choice(list(by.values())); print(x["short_id"], [t for t in x["tags"] if t.startswith("inst-")][0])') || { echo "no tenant snapshots to verify" >&2; exit 1; }
  read -r id tag <<< "$pick"
  echo "verifying snapshot $pick"
  restic restore "$id" --target "$tmp" --quiet
  files=$(find "$tmp" -type f | wc -l)
  [ "$files" -gt 0 ] || { echo "verify FAILED: the snapshot restored no files" >&2; exit 1; }
  stage_root=$(realpath -ms -- "$STAGE_ROOT")
  stage="$tmp$stage_root/${tag#inst-}"
  if [ -d "$stage" ]; then
    find "$stage" -type f -name '*.db' -print0
  fi | (
    found=0; bad=0
    while IFS= read -r -d '' db; do
      found=1
      if ! r=$(python3 - "$db" 2>&1 <<'PY'
from pathlib import Path
import sqlite3, sys
with sqlite3.connect(Path(sys.argv[1]).as_uri() + "?mode=ro", uri=True) as conn:
    for (result,) in conn.execute("PRAGMA integrity_check"):
        print(result)
PY
      ) || [ "$r" != ok ]; then
        echo "integrity_check failed for ${db#"$tmp"/}: $r" >&2
        bad=1
      fi
    done
    [ "$found" = 1 ] || { echo "verify FAILED: the snapshot restored no SQLite databases in staging" >&2; exit 1; }
    [ "$bad" = 0 ]
  )
  echo "verify OK: $files files restored, databases pass integrity_check"
  exit 0
fi

mkdir -p "$STAGE_ROOT"
volumes=$(docker volume ls -q --filter name=hermes-data- | grep -E '^hermes-data-[0-9a-f-]{36}$' || true)
ok=0; failed=0; ids=()
for v in $volumes; do
  id=${v#hermes-data-}; ids+=("$id")
  data=$(docker volume inspect -f '{{.Mountpoint}}' "$v")
  stage="$STAGE_ROOT/$id"; rm -rf "$stage"; mkdir -p "$stage"; n=; got=
  # The live SQLite files are excluded only under $data (anchored): an unanchored '*.db' also dropped the consistent
  # copies in $stage, so until 2026-11-21 no snapshot held a database. The count check below catches that kind of loss.
  if n=$(sqlite_copy "$data" "$stage") && restic backup "$data" "$stage" --tag tenant-vol --tag "inst-$id" --host nibie-cloud \
       --exclude "$data/**/*.db" --exclude "$data/**/*.db-wal" --exclude "$data/**/*.db-shm" --exclude "$data/**/*.db-journal" \
       --exclude '*.lock' --exclude '*.sock' --quiet \
     && got=$(restic ls latest --tag "inst-$id" --host nibie-cloud | grep -c "^$stage/.*\.db$" || true) && [ "$got" = "$n" ]; then
    ok=$((ok + 1)); log "OK $id ($n sqlite files)"
  elif [ -n "${got:-}" ] && [ "$got" != "${n:-}" ]; then
    failed=$((failed + 1)); log "ERROR $id: snapshot holds ${got} of ${n} sqlite files"
  else
    failed=$((failed + 1)); log "ERROR backing up $id"
  fi
  rm -rf "$stage"
done

# Retention: 7 days per instance; drop snapshots of instances whose volume no longer exists once they are older than 7 days.
python3 - "$KEEP_DAYS" "${ids[*]:-}" <<'PY' | while read -r sid; do restic forget "$sid" --quiet || true; done
import json, subprocess, sys, datetime
keep = int(sys.argv[1]); live = set(sys.argv[2].split())
snaps = json.loads(subprocess.check_output(["restic", "snapshots", "--tag", "tenant-vol", "--json"]) or b"[]")
now = datetime.datetime.now(datetime.timezone.utc)
by = {}
for s in snaps:
    inst = next((t[5:] for t in s["tags"] if t.startswith("inst-")), None)
    t = datetime.datetime.fromisoformat(s["time"].replace("Z", "+00:00"))
    by.setdefault(inst, []).append((t, s["id"]))
for inst, items in by.items():
    items.sort(reverse=True)
    for i, (t, sid) in enumerate(items):
        old = (now - t).days >= keep
        if inst in live:
            # live instance: keep the newest snapshot of every day for the retention window, the newest always
            if old and i > 0:
                print(sid)
        elif old:
            print(sid)
PY
restic prune --quiet >>"$LOG_FILE" 2>&1 || log "WARN: prune failed"

log "done: $ok ok, $failed failed"
[ "$failed" = 0 ] || exit 1
