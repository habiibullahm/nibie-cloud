#!/usr/bin/env bash
# Records RAM and CPU of every tenant container and of the host, one CSV row each, every 5 minutes (systemd timer).
# The data decides when the VPS must grow: see docs/capacity.md. Read-only: it never touches a container.
#   /var/log/hermes-usage.csv:  ts_utc,kind,name,cpu_pct,mem_mb,mem_limit_mb
#     kind=tenant   one row per running container named hermes-<instance uuid>
#     kind=host     name=host: cpu_pct = load average (1 min), mem_mb = used, mem_limit_mb = total
# It also replaces /var/lib/hermes-usage/node.json, the latest host snapshot for the admin Node page. The backend mounts
# that folder read-only and reads the file only when the page asks, so the backend itself measures nothing.
# The file is rotated by logrotate (hermes-usage.logrotate); nothing here contains customer data or secrets.
set -uo pipefail
OUT=${USAGE_FILE:-/var/log/hermes-usage.csv}
SNAP=${USAGE_SNAPSHOT:-/var/lib/hermes-usage/node.json}
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
[ -s "$OUT" ] || echo "ts_utc,kind,name,cpu_pct,mem_mb,mem_limit_mb" > "$OUT"

to_mb() { # "240.1MiB" / "1GiB" / "512KiB" -> integer MB
  python3 - "$1" <<'PY'
import re, sys
m = re.match(r'([\d.]+)\s*([KMGT]?i?B)', sys.argv[1])
if not m: print(0); sys.exit()
v, u = float(m.group(1)), m.group(2).upper()
f = {'B': 1/1048576, 'KIB': 1/1024, 'KB': 1/1024, 'MIB': 1, 'MB': 1, 'GIB': 1024, 'GB': 1024, 'TIB': 1048576, 'TB': 1048576}.get(u, 1)
print(int(v * f))
PY
}

tenants=0; tenant_mem=0
stats=$(docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}' 2>/dev/null | grep -E '^hermes-[0-9a-f]{8}-' || true)
while IFS='|' read -r name cpu mem; do
  [ -n "$name" ] || continue
  used=$(to_mb "${mem%% / *}"); limit=$(to_mb "${mem##* / }")
  echo "$ts,tenant,$name,${cpu%\%},$used,$limit" >> "$OUT"
  tenants=$((tenants + 1)); tenant_mem=$((tenant_mem + used))
done <<<"$stats"

read -r total used avail <<<"$(free -m | awk '/^Mem:/ {print $2, $3, $7}')"
load=$(cut -d' ' -f1 /proc/loadavg)
echo "$ts,host,host,$load,$used,$total" >> "$OUT"

read -r disk_total disk_used <<<"$(df -Pm / | awk 'NR==2 {print $2, $3}')"
read -r vol_total vol_used <<<"$(df -Pm /var/lib/docker/volumes 2>/dev/null | awk 'NR==2 {print $2, $3}')"
mkdir -p "$(dirname "$SNAP")"
printf '{"ts":"%s","cpus":%d,"load1":%s,"memTotalMb":%d,"memUsedMb":%d,"memAvailableMb":%d,"diskTotalMb":%d,"diskUsedMb":%d,"volumesTotalMb":%d,"volumesUsedMb":%d,"tenants":%d,"tenantMemMb":%d}\n' \
  "$ts" "$(nproc)" "$load" "$total" "$used" "$avail" "$disk_total" "$disk_used" "${vol_total:-0}" "${vol_used:-0}" "$tenants" "$tenant_mem" \
  > "$SNAP.tmp" && mv -f "$SNAP.tmp" "$SNAP"
