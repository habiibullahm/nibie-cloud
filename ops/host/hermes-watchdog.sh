#!/usr/bin/env bash
# Host watchdog for Nibie Cloud. Run every minute by hermes-watchdog.timer. It never touches tenant containers;
# the only thing it restarts is the backend container, only after 3 failed /readyz checks in a row, at most 3 times per hour.
# It alerts to Telegram when something needs a human and says so again when it is fixed. Alerts repeat at most hourly.
# Config: /etc/hermes-cloud/ops.env (mode 600), names only here:
#   OPS_TELEGRAM_BOT_TOKEN, OPS_TELEGRAM_CHAT_ID   (both empty: only the journal gets the message)
#   OPS_HEARTBEAT_URL   (optional; called after every fully green run, for an external uptime monitor)
#   OPS_API_HOST        (public API host name, for the public and certificate checks)
set -uo pipefail
umask 077
ENV_FILE=${OPS_ENV_FILE:-/etc/hermes-cloud/ops.env}
STATE=${OPS_STATE_DIR:-/var/lib/hermes-watchdog}
BACKEND=${OPS_BACKEND_CONTAINER:-hermes-cloud-backend-1}
READYZ=${OPS_READYZ_URL:-http://127.0.0.1:3000/readyz}
DUMP_DIR=${DUMP_DIR:-/var/backups/hermes-cloud}
OFFSITE_LOG=${OFFSITE_LOG:-/var/log/hermes-db-offsite.log}
TENANT_BACKUP_LOG=${TENANT_BACKUP_LOG:-/var/log/hermes-tenant-backup.log}
REPEAT_SECS=3600
mkdir -p "$STATE"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }
HOST_NAME=$(hostname)

now=$(date +%s)
log() { echo "watchdog: $*"; }

send_telegram() {
  [ -n "${OPS_TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${OPS_TELEGRAM_CHAT_ID:-}" ] || return 0
  # The token goes through stdin (curl --config -) so it never appears in the process list.
  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$OPS_TELEGRAM_BOT_TOKEN" \
    | curl -fsS --max-time 10 --config - --data-urlencode "chat_id=$OPS_TELEGRAM_CHAT_ID" --data-urlencode "text=$1" >/dev/null 2>&1 \
    || log "telegram send failed"
}

# alert KEY MESSAGE: first time, or again after an hour. recover KEY MESSAGE: once, when it was alerting.
alert() {
  local key=$1 msg=$2 f="$STATE/alert.$1" last=0
  [ -f "$f" ] && last=$(cat "$f")
  if [ $((now - last)) -ge $REPEAT_SECS ]; then
    log "ALERT $key: $msg"; send_telegram "[Nibie Cloud] MASALAH ($HOST_NAME) $msg"; echo "$now" > "$f"
  fi
}
recover() {
  local key=$1 msg=$2 f="$STATE/alert.$1"
  if [ -f "$f" ]; then log "RECOVERED $key"; send_telegram "[Nibie Cloud] PULIH ($HOST_NAME) $msg"; rm -f "$f"; fi
}

green=1

# 1. Backend readiness, with a guarded restart.
fails=0; [ -f "$STATE/readyz.fails" ] && fails=$(cat "$STATE/readyz.fails")
if body=$(curl -fsS --max-time 5 "$READYZ" 2>/dev/null); then
  echo 0 > "$STATE/readyz.fails"; recover readyz "backend siap lagi"
else
  green=0; fails=$((fails + 1)); echo "$fails" > "$STATE/readyz.fails"
  log "readyz failed ($fails in a row)"
  if [ "$fails" -ge 3 ]; then
    hist="$STATE/restarts"; touch "$hist"
    awk -v cutoff=$((now - 3600)) '$1 >= cutoff' "$hist" > "$hist.tmp" && mv "$hist.tmp" "$hist"
    if [ "$(wc -l < "$hist")" -lt 3 ]; then
      alert readyz "backend tidak siap $fails kali berturut-turut, dijalankan restart otomatis"
      docker restart "$BACKEND" >/dev/null 2>&1 && echo "$now" >> "$hist"
      echo 0 > "$STATE/readyz.fails"
    else
      alert readyz-giveup "backend masih tidak siap setelah 3 restart dalam 1 jam; butuh tindakan manual"
    fi
  fi
fi

# 2. Core containers running.
for c in "$BACKEND" hermes-cloud-redis-1 hermes-cloud-caddy-1; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = "true" ]; then recover "container-$c" "container $c jalan lagi"
  else green=0; alert "container-$c" "container $c tidak berjalan"; fi
done

# 3. Disk usage.
for mnt in / /var/lib/docker/volumes; do
  pct=$(df --output=pcent "$mnt" 2>/dev/null | tail -n1 | tr -dc '0-9')
  [ -n "$pct" ] || continue
  if [ "$pct" -ge 85 ]; then green=0; alert "disk-$mnt" "disk $mnt terisi ${pct}%"; else recover "disk-$mnt" "disk $mnt turun ke ${pct}%"; fi
done

# 4. The newest local database dump must be fresh (the daily job runs at 19:00 UTC).
newest=$(ls -1t "$DUMP_DIR"/hermes-*.dump 2>/dev/null | head -n1 || true)
if [ -n "$newest" ] && [ $((now - $(stat -c %Y "$newest"))) -le $((26 * 3600)) ]; then recover backup "backup database harian normal lagi"
else green=0; alert backup "backup database lokal lebih tua dari 26 jam atau tidak ada"; fi

# 4b. The dump must also reach R2 (hermes-db-offsite, 19:30 UTC), and the weekly restore drill from R2 must pass.
# A failed oneshot unit stays "failed" until its next successful run, so the alert lasts exactly that long.
last_ok=$(grep -o '^\[[0-9TZ:-]*\] OK: uploaded' "$OFFSITE_LOG" 2>/dev/null | tail -n1 | cut -d']' -f1 | tr -d '[')
if [ -n "$last_ok" ] && [ $((now - $(date -d "$last_ok" +%s 2>/dev/null || echo 0))) -le $((26 * 3600)) ]; then recover offsite "salinan backup database ke R2 normal lagi"
else green=0; alert offsite "salinan backup database ke R2 terakhir berhasil lebih dari 26 jam lalu atau tidak ada; lihat $OFFSITE_LOG"; fi
if systemctl is-failed --quiet hermes-restore-drill.service; then green=0; alert restore-drill "uji restore database dari R2 gagal; lihat journalctl -u hermes-restore-drill"
else recover restore-drill "uji restore database dari R2 lulus lagi"; fi

# 4c. Tenant volume backups, on hosts where hermes-tenant-backup.timer (20:00 UTC) is enabled: the last run in which no volume
# failed must be under 26 hours old. The weekly verify and the fleet retention units must not be failed (where installed).
if systemctl is-enabled --quiet hermes-tenant-backup.timer 2>/dev/null; then
  tenant_ok=$(grep -o '^\[[0-9TZ:-]*\] done: [0-9]* ok, 0 failed' "$TENANT_BACKUP_LOG" 2>/dev/null | tail -n1 | cut -d']' -f1 | tr -d '[')
  if [ -n "$tenant_ok" ] && [ $((now - $(date -d "$tenant_ok" +%s 2>/dev/null || echo 0))) -le $((26 * 3600)) ]; then recover tenant-backup "backup volume tenant normal lagi"
  else green=0; alert tenant-backup "backup volume tenant tanpa kegagalan terakhir lebih dari 26 jam lalu atau tidak ada; lihat $TENANT_BACKUP_LOG"; fi
fi
for unit in hermes-tenant-verify hermes-tenant-retention; do
  if systemctl is-failed --quiet "$unit.service"; then green=0; alert "$unit" "$unit gagal; lihat journalctl -u $unit"
  else recover "$unit" "$unit normal lagi"; fi
done

# 5. Public path and certificate age (once an hour is plenty).
if [ -n "${OPS_API_HOST:-}" ] && [ ! -f "$STATE/public.checked" -o $((now - $(stat -c %Y "$STATE/public.checked" 2>/dev/null || echo 0))) -ge 3600 ]; then
  touch "$STATE/public.checked"
  if curl -fsS --max-time 10 -o /dev/null "https://$OPS_API_HOST/healthz"; then recover public "API publik menjawab lagi"
  else green=0; alert public "API publik https://$OPS_API_HOST/healthz tidak menjawab"; fi
  end=$(echo | openssl s_client -servername "$OPS_API_HOST" -connect "$OPS_API_HOST:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [ -n "$end" ]; then
    days=$(( ($(date -d "$end" +%s) - now) / 86400 ))
    if [ "$days" -lt 14 ]; then green=0; alert cert "sertifikat TLS $OPS_API_HOST habis dalam $days hari"; else recover cert "sertifikat TLS normal lagi"; fi
  fi
fi

# 6. Daily summary at 09:00 WIB (02:00 UTC). A missing summary is itself a signal.
if [ "$(date -u +%H%M)" = "0200" ]; then
  send_telegram "[Nibie Cloud] Ringkasan harian ($HOST_NAME): backend $([ "$green" = 1 ] && echo sehat || echo BERMASALAH); dump terakhir: $(basename "${newest:-tidak ada}")"
fi

# 7. Heartbeat for an external uptime monitor, only when everything above was green.
if [ "$green" = 1 ] && [ -n "${OPS_HEARTBEAT_URL:-}" ]; then curl -fsS --max-time 10 -o /dev/null "$OPS_HEARTBEAT_URL" || log "heartbeat failed"; fi
exit 0
