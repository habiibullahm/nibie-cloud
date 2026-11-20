#!/usr/bin/env bash
# Restores a tenant volume snapshot (hermes-tenant-backup.sh) into an instance of the same tenant, usually a new one
# created after the old instance was deleted. Runbook: docs/runbook-tenant-restore.md. Run as root on the host.
#   hermes-tenant-restore.sh <snapshot id> <old instance id> <tenant id> <target instance id>
# Stops the target, copies the snapshot's files over its volume (keeping the target's own config.yaml and .env, which
# carry its model and key settings), puts the consistent SQLite copies in place, fixes ownership and starts it again.
# Files changed after the snapshot are lost. Provider keys and Telegram tokens are not in a backup: reconnect them.
set -euo pipefail
umask 077
[ $# -eq 4 ] || { echo "usage: $0 <snapshot> <old-instance-id> <tenant-id> <target-instance-id>" >&2; exit 2; }
SNAP=$1 OLD=$2 TENANT=$3 NEW=$4
uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
for x in "$OLD" "$TENANT" "$NEW"; do [[ $x =~ $uuid ]] || { echo "not a uuid: $x" >&2; exit 2; }; done
API=http://127.0.0.1:${PORT:-3000}/api/v1/tenants/$TENANT/instances/$NEW
T=$(grep -E '^ADMIN_TOKEN=' /etc/hermes-cloud/backend.env | cut -d= -f2-)
st() { curl -fsS -H "authorization: Bearer $T" "$API/status" | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])'; }
wait_for() { local s=; for _ in $(seq 1 60); do s=$(st); [ "$s" = "$1" ] && return 0; sleep 5; done; echo "timeout waiting for $1 (now $s)" >&2; exit 1; }
act() { curl -fsS -o /dev/null -X POST -H "authorization: Bearer $T" "$API/$1"; }

dst=$(docker volume inspect -f '{{.Mountpoint}}' "hermes-data-$NEW")
owner=$(stat -c '%u:%g' "$dst")
wait_for ACTIVE
act stop; wait_for STOPPED

work=$(mktemp -d /root/restore-XXXXXX); trap 'rm -rf "$work"' EXIT
# shellcheck disable=SC1090
set -a; . "${RESTIC_ENV_FILE:-/etc/restic/r2/env}"; set +a
restic restore "$SNAP" --target "$work" --quiet
src="$work/var/lib/docker/volumes/hermes-data-$OLD/_data"
stage="$work/var/lib/hermes-backup-staging/$OLD"
[ -d "$src" ] || { echo "snapshot $SNAP holds no volume of instance $OLD" >&2; exit 1; }
dbs=$(find "$stage" -name '*.db' 2>/dev/null | wc -l)
echo "snapshot: $(find "$src" -type f | wc -l) files, $dbs sqlite databases"

(cd "$src" && find . -mindepth 1 -maxdepth 1 ! -name config.yaml ! -name .env -exec cp -a {} "$dst"/ \;)
if [ "$dbs" -gt 0 ]; then
  # Drop the target's own journal files for every database we replace, or SQLite would replay them into the copy.
  (cd "$stage" && find . -name '*.db' | while read -r f; do rm -f "$dst/$f-wal" "$dst/$f-shm" "$dst/$f-journal"; done)
  cp -a "$stage"/. "$dst"/
fi
chown -R "$owner" "$dst"

act start; wait_for ACTIVE
echo "restored $SNAP into $NEW: ACTIVE"
