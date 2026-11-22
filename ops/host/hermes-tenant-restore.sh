#!/usr/bin/env bash
# Restores a tenant volume snapshot (hermes-tenant-backup.sh) into an instance of the same tenant, usually a new one
# created after the old instance was deleted. Runbook: docs/runbook-tenant-restore.md. Run as root on the host.
#   hermes-tenant-restore.sh <snapshot id> <old instance id> <tenant id> <target instance id>
# Stops the target, copies the snapshot's files over its volume (keeping the target's own config.yaml and .env, which
# carry its model and key settings), puts the consistent SQLite copies in place, fixes ownership and starts it again.
# Files changed after the snapshot are lost. Provider keys and Telegram tokens are not in a backup: reconnect them.
set -euo pipefail
umask 077
OFFLINE=0
if [ "${1:-}" = --offline ]; then OFFLINE=1; shift; fi
[ $# -eq 4 ] || { echo "usage: $0 [--offline] <snapshot> <old-instance-id> <tenant-id> <target-instance-id>" >&2; exit 2; }
SNAP=$1 OLD=$2 TENANT=$3 NEW=$4
[[ $SNAP =~ ^[0-9a-f]{8,64}$ ]] || { echo "invalid snapshot id" >&2; exit 2; }
uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
for x in "$OLD" "$TENANT" "$NEW"; do [[ $x =~ $uuid ]] || { echo "not a uuid: $x" >&2; exit 2; }; done
API=http://127.0.0.1:${PORT:-3000}/api/v1/tenants/$TENANT/instances/$NEW
st() { curl -fsS -H "authorization: Bearer $T" "$API/status" | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])'; }
wait_for() { local s=; for _ in $(seq 1 60); do s=$(st); [ "$s" = "$1" ] && return 0; sleep 5; done; echo "timeout waiting for $1 (now $s)" >&2; exit 1; }
act() { curl -fsS -o /dev/null -X POST -H "authorization: Bearer $T" "$API/$1"; }

dst=$(docker volume inspect -f '{{.Mountpoint}}' "hermes-data-$NEW")
owner=$(stat -c '%u:%g' "$dst")
if [ "$OFFLINE" = 1 ]; then
  [ "$OLD" = "$NEW" ] || { echo "offline restore requires the same instance id" >&2; exit 2; }
  [ "$(docker inspect -f '{{.State.Status}}' "hermes-$NEW")" = created ] || {
    echo "offline recovery requires a prepared, unstarted container" >&2; exit 1;
  }
else
  T=$(grep -E '^ADMIN_TOKEN=' /etc/hermes-cloud/backend.env | cut -d= -f2-)
  wait_for ACTIVE
  act stop; wait_for STOPPED
fi

work=$(mktemp -d /root/restore-XXXXXX); trap 'rm -rf "$work"' EXIT
# shellcheck disable=SC1090
set -a; . "${RESTIC_ENV_FILE:-/etc/restic/r2/env}"; set +a
restic snapshots --tag "inst-$OLD" --json | python3 -c '
import json, sys
matches = [s for s in json.load(sys.stdin) if s["id"].startswith(sys.argv[1])]
sys.exit(len(matches) != 1)' "$SNAP"
restic restore "$SNAP" --target "$work" --quiet
src="$work/var/lib/docker/volumes/hermes-data-$OLD/_data"
stage="$work/var/lib/hermes-backup-staging/$OLD"
[ -d "$src" ] || { echo "snapshot $SNAP holds no volume of instance $OLD" >&2; exit 1; }
dbs=$(find "$stage" -name '*.db' 2>/dev/null | wc -l)
echo "snapshot: $(find "$src" -type f | wc -l) files, $dbs sqlite databases"
if [ "$OFFLINE" = 1 ]; then
  [ "$dbs" -gt 0 ] || { echo "snapshot holds no SQLite backup" >&2; exit 1; }
  python3 - "$src" "$stage" "$dst" <<'PY'
from pathlib import Path
import os, stat, sys
for arg in sys.argv[1:]:
    base = Path(arg).resolve(strict=True)
    for path, dirs, files in os.walk(base, followlinks=False):
        for entry in (Path(path) / name for name in dirs + files):
            mode = entry.lstat().st_mode
            if stat.S_ISLNK(mode):
                if Path(os.readlink(entry)).is_absolute() or not entry.resolve().is_relative_to(base):
                    sys.exit("restore rejected a symlink that leaves the volume")
            elif not stat.S_ISREG(mode) and not stat.S_ISDIR(mode):
                sys.exit("restore rejected a special file")
PY
  while IFS= read -r -d '' db; do
    [ "$(sqlite3 -readonly "$db" 'PRAGMA integrity_check;')" = ok ] || exit 1
  done < <(find "$stage" -type f -name '*.db' -print0)
fi

(cd "$src" && find . -mindepth 1 -maxdepth 1 ! -name config.yaml ! -name .env -exec cp -a {} "$dst"/ \;)
if [ "$dbs" -gt 0 ]; then
  # Drop the target's own journal files for every database we replace, or SQLite would replay them into the copy.
  (cd "$stage" && find . -name '*.db' | while read -r f; do rm -f "$dst/$f-wal" "$dst/$f-shm" "$dst/$f-journal"; done)
  cp -a "$stage"/. "$dst"/
fi
chown -hR "$owner" "$dst"

if [ "$OFFLINE" = 1 ]; then
  echo "restored $SNAP into $NEW: verified offline"
else
  act start; wait_for ACTIVE
  echo "restored $SNAP into $NEW: ACTIVE"
fi
