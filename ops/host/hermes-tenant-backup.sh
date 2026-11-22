#!/usr/bin/env bash
# Backs up every tenant data volume (hermes-data-<instance uuid>) to the restic repository on R2, encrypted by restic.
#   hermes-tenant-backup.sh             back up all tenant volumes, then expire old snapshots
#   hermes-tenant-backup.sh --verify    restore the newest snapshot of one volume into a temp dir and check it
#   hermes-tenant-backup.sh --retention expire shared-fleet snapshots from the control plane
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
METADATA_DIR=${BACKUP_METADATA_DIR:-/var/lib/hermes-backup-metadata}
KEEP_DAYS=7
BACKUP_HOST=${RESTIC_BACKUP_HOST:-nibie-cloud}
RETENTION_MODE=${RESTIC_RETENTION_MODE:-local}
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG_FILE" >&2; }
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
: "${RESTIC_REPOSITORY:?}" "${RESTIC_PASSWORD_FILE:?}"

read_operator() {
  local token
  token=$(grep -m1 '^ADMIN_TOKEN=' "${BACKEND_ENV_FILE:-/etc/hermes-cloud/backend.env}" | cut -d= -f2-)
  [ -n "$token" ] || return 1
  printf 'header = "authorization: Bearer %s"\n' "$token" |
    curl --config - -fsS --max-time 15 "http://127.0.0.1:${PORT:-3000}/api/v1/$1"
}

# The backend reads only these metadata files through a read-only host mount.
publish_metadata() {
  local name=$1 json=$2 temp
  install -d -m 0755 -- "$METADATA_DIR" || return 1
  temp=$(mktemp "$METADATA_DIR/.metadata.XXXXXX") || return 1
  if printf '%s\n' "$json" > "$temp" && chmod 0644 "$temp" && mv -f -- "$temp" "$METADATA_DIR/$name"; then
    return 0
  fi
  rm -f -- "$temp"
  return 1
}

publish_inventory() {
  local json
  json=$(restic snapshots --tag tenant-vol --json | python3 -c '
from datetime import datetime, timezone
import json, re, sys
instance_tag = re.compile(r"inst-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})")
latest = {}
for snapshot in json.load(sys.stdin):
    for tag in snapshot.get("tags", []):
        match = instance_tag.fullmatch(tag)
        if match:
            instance = match[1]
            taken = datetime.fromisoformat(snapshot["time"])
            if instance not in latest or taken > latest[instance]:
                latest[instance] = taken
json.dump({
    "observedAt": datetime.now(timezone.utc).isoformat(),
    "retentionDays": int(sys.argv[1]),
    "snapshots": {instance: taken.isoformat() for instance, taken in latest.items()},
}, sys.stdout)' "$KEEP_DAYS") || return 1
  publish_metadata snapshots.json "$json"
}

expire_snapshots() {
  local expired
  local -a snapshot_ids
  expired=$(python3 - "$KEEP_DAYS" "$1" <<'PY'
import json, subprocess, sys, datetime
keep = int(sys.argv[1]); live = set(sys.argv[2].split())
snaps = json.loads(subprocess.check_output(["restic", "snapshots", "--tag", "tenant-vol", "--json"]) or b"[]")
now = datetime.datetime.now(datetime.timezone.utc)
by = {}
for s in snaps:
    inst = next((t[5:] for t in s.get("tags", []) if t.startswith("inst-")), None)
    if inst is not None:
        t = datetime.datetime.fromisoformat(s["time"].replace("Z", "+00:00"))
        by.setdefault(inst, []).append((t, s["id"]))
for inst, items in by.items():
    for i, (t, sid) in enumerate(sorted(items, reverse=True)):
        if (now - t).days >= keep and (inst not in live or i > 0):
            print(sid)
PY
  ) || return 1
  if [ -n "$expired" ]; then
    mapfile -t snapshot_ids <<<"$expired"
    restic forget --quiet "${snapshot_ids[@]}" || return 1
  fi
  restic prune --quiet >>"$LOG_FILE" 2>&1
}

if [ "${1:-}" = "--retention" ]; then
  live=$(read_operator runtime-backup-live |
    python3 -c 'import json,sys; print(" ".join(json.load(sys.stdin)["instanceIds"]))')
  expire_snapshots "$live"
  publish_inventory
  exit 0
fi

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
  tmp=$(mktemp -d)
  tag=; taken=
  # The EXIT trap records the result for both explicit failures and command errors.
  # shellcheck disable=SC2317
  finish_verification() {
    local code=$1 result=failed json
    rm -rf "$tmp" || true
    if [[ "$tag" =~ ^inst-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]] && [ -n "$taken" ]; then
      if [ "$code" = 0 ]; then result=passed; fi
      if ! json=$(python3 -c 'import json, sys
snapshot_at, checked_at, status = sys.argv[1:]
print(json.dumps({"snapshotAt": snapshot_at, "checkedAt": checked_at, "status": status}))' \
          "$taken" "$(date -u +%FT%TZ)" "$result") || ! publish_metadata "verify-${tag#inst-}.json" "$json"; then
        echo "WARN: could not publish tenant verification metadata" >&2
      fi
    fi
  }
  trap 'finish_verification "$?"' EXIT
  snap_json=$(restic snapshots --tag tenant-vol --host "$BACKUP_HOST" --json)
  pick=$(printf '%s' "$snap_json" | python3 -c 'import sys,json,random
s=json.load(sys.stdin)
if not s: sys.exit(1)
by={}
for x in s:
    t=[t for t in x["tags"] if t.startswith("inst-")][0]
    if t not in by or x["time"]>by[t]["time"]: by[t]=x
x=random.choice(list(by.values())); print(x["short_id"], [t for t in x["tags"] if t.startswith("inst-")][0], x["time"])') || { echo "no tenant snapshots to verify" >&2; exit 1; }
  read -r id tag taken <<< "$pick"
  echo "verifying snapshot $id $tag"
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
if [ "$RETENTION_MODE" = fleet ]; then
  if [ -n "${DESIRED_QUOTAS_FILE:-}" ]; then
    modified=$(stat -c %Y "$DESIRED_QUOTAS_FILE")
    [ $(( $(date +%s) - modified )) -lt 120 ] || { log "ERROR: stale runtime assignments"; exit 1; }
    assignments=$(cat "$DESIRED_QUOTAS_FILE")
  else
    assignments=$(read_operator volume-quotas)
  fi
  assigned=$(python3 -c 'import json,sys; print("\n".join("hermes-data-"+r["instanceId"] for r in json.load(sys.stdin)["volumes"]))' <<<"$assignments")
  volumes=$(grep -Fx -f <(printf '%s\n' "$assigned") <<<"$volumes" || true)
fi
ok=0; failed=0; ids=()
for v in $volumes; do
  id=${v#hermes-data-}; ids+=("$id")
  data=$(docker volume inspect -f '{{.Mountpoint}}' "$v")
  stage="$STAGE_ROOT/$id"; rm -rf "$stage"; mkdir -p "$stage"; n=; got=
  # The live SQLite files are excluded only under $data (anchored): an unanchored '*.db' also dropped the consistent
  # copies in $stage, so until 2026-11-21 no snapshot held a database. The count check below catches that kind of loss.
  if n=$(sqlite_copy "$data" "$stage") && restic backup "$data" "$stage" --tag tenant-vol --tag "inst-$id" --host "$BACKUP_HOST" \
       --exclude "$data/**/*.db" --exclude "$data/**/*.db-wal" --exclude "$data/**/*.db-shm" --exclude "$data/**/*.db-journal" \
       --exclude '*.lock' --exclude '*.sock' --quiet \
     && got=$(restic ls latest --tag "inst-$id" --host "$BACKUP_HOST" | grep -c "^$stage/.*\.db$" || true) && [ "$got" = "$n" ]; then
    ok=$((ok + 1)); log "OK $id ($n sqlite files)"
  elif [ -n "${got:-}" ] && [ "$got" != "${n:-}" ]; then
    failed=$((failed + 1)); log "ERROR $id: snapshot holds ${got} of ${n} sqlite files"
  else
    failed=$((failed + 1)); log "ERROR backing up $id"
  fi
  rm -rf "$stage"
done

if [ "$RETENTION_MODE" = local ]; then
  expire_snapshots "${ids[*]:-}" || log "WARN: retention failed"
fi
publish_inventory || log "WARN: could not publish tenant snapshot inventory"

log "done: $ok ok, $failed failed"
[ "$failed" = 0 ] || exit 1
