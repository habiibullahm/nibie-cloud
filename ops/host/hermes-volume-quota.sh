#!/usr/bin/env bash
# Raises the XFS project quota of tenant volumes (hermes-data-<instance uuid>) to their plan's disk size.
# A volume's quota is set once, when Docker creates it, so a plan upgrade (free -> paid) would otherwise keep the old size.
# Reads the wanted size from the operator API on loopback (GET /api/v1/volume-quotas, bearer ADMIN_TOKEN from the backend
# env file). Only ever raises a limit: a smaller plan size never shrinks a volume below what it already holds.
#   hermes-volume-quota.sh            apply
#   DRY_RUN=1 hermes-volume-quota.sh  print what it would change
# Runs as root (xfs_quota needs it). Never prints the token.
set -euo pipefail
ENV_FILE=${ENV_FILE:-/etc/hermes-cloud/backend.env}
API=${API_URL:-http://127.0.0.1:3000/api/v1/volume-quotas}
MOUNT=${VOLUMES_MOUNT:-/var/lib/docker/volumes}
LOG_FILE=${LOG_FILE:-/var/log/hermes-volume-quota.log}
DRY=${DRY_RUN:-0}
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG_FILE" >&2; }

token=$(grep -m1 '^ADMIN_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
[ -n "$token" ] || { log "ERROR: ADMIN_TOKEN missing in $ENV_FILE"; exit 1; }
wanted=$(curl -fsS --max-time 10 -H "authorization: Bearer $token" "$API" \
  | python3 -c 'import json,sys
for v in json.load(sys.stdin)["volumes"]:
    print(v["instanceId"], int(v["storageMb"]))') || { log "ERROR: could not read $API"; exit 1; }

# Current hard limits in KiB per project id (Docker sets soft = hard).
report=$(xfs_quota -x -c 'report -p -n -b -N' "$MOUNT" 2>/dev/null)

raised=0; failed=0
while read -r id mb; do
  [ -n "$id" ] || continue
  [[ $id =~ ^[0-9a-f-]{36}$ ]] || continue
  v="hermes-data-$id"
  dir=$(docker volume inspect -f '{{.Mountpoint}}' "$v" 2>/dev/null) || continue # not created yet, or gone
  proj=$(xfs_io -c lsproj "$dir" 2>/dev/null | awk '{print $NF}')
  [[ $proj =~ ^[0-9]+$ ]] && [ "$proj" != 0 ] || { log "WARN: $v has no XFS project; skipped"; continue; }
  have=$(awk -v p="#$proj" '$1 == p {print $4}' <<<"$report")
  want=$((mb * 1024))
  if [ -n "$have" ] && [ "$have" -ge "$want" ]; then continue; fi
  if [ "$DRY" = 1 ]; then echo "[dry-run] $v project $proj: ${have:-none} KiB -> $want KiB"; continue; fi
  if xfs_quota -x -c "limit -p bsoft=${mb}m bhard=${mb}m $proj" "$MOUNT" 2>/dev/null; then
    raised=$((raised + 1)); log "raised $v (project $proj) to ${mb} MiB (was ${have:-none} KiB)"
  else
    failed=$((failed + 1)); log "ERROR: could not raise $v (project $proj)"
  fi
done <<<"$wanted"

[ "$raised" = 0 ] && [ "$failed" = 0 ] || log "done: $raised raised, $failed failed"
[ "$failed" = 0 ]
