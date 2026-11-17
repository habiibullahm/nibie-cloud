#!/usr/bin/env bash
# Records RAM and CPU of every tenant container and of the host, one CSV row each, every 5 minutes (systemd timer).
# The data decides when the VPS must grow: see docs/capacity.md. Read-only: it never touches a container.
#   /var/log/hermes-usage.csv:  ts_utc,kind,name,cpu_pct,mem_mb,mem_limit_mb
#     kind=tenant   one row per running container named hermes-<instance uuid>
#     kind=host     name=host: cpu_pct = load average (1 min), mem_mb = used, mem_limit_mb = total
# The file is rotated by logrotate (hermes-usage.logrotate); nothing here contains customer data or secrets.
set -uo pipefail
OUT=${USAGE_FILE:-/var/log/hermes-usage.csv}
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

docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}' 2>/dev/null | grep -E '^hermes-[0-9a-f]{8}-' | while IFS='|' read -r name cpu mem; do
  used=${mem%% / *}; limit=${mem##* / }
  echo "$ts,tenant,$name,${cpu%\%},$(to_mb "$used"),$(to_mb "$limit")" >> "$OUT"
done

read -r total used <<<"$(free -m | awk '/^Mem:/ {print $2, $3}')"
load=$(cut -d' ' -f1 /proc/loadavg)
echo "$ts,host,host,$load,$used,$total" >> "$OUT"
