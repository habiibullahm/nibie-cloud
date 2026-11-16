#!/usr/bin/env bash
# Copies the newest local database dump (hermes-db-backup) into the existing restic repository on Cloudflare R2.
# restic encrypts on the host, so nothing readable leaves the VPS. Reuses /etc/restic/r2/env (same credentials,
# repository and password file as hermes-r2-backup.sh); the snapshots carry the tag nibie-cloud-db.
# A local copy that is older than 26 hours is refused: the daily local job has failed and must be fixed first.
set -euo pipefail
umask 077
ENV_FILE=${RESTIC_ENV_FILE:-/etc/restic/r2/env}
DUMP_DIR=${DUMP_DIR:-/var/backups/hermes-cloud}
TAG=nibie-cloud-db
LOG_FILE=${LOG_FILE:-/var/log/hermes-db-offsite.log}

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG_FILE" >&2; }
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
: "${RESTIC_REPOSITORY:?}" "${RESTIC_PASSWORD_FILE:?}"

newest=$(ls -1t "$DUMP_DIR"/hermes-*.dump 2>/dev/null | head -n1 || true)
[ -n "$newest" ] || { log "ERROR: no local dump in $DUMP_DIR"; exit 1; }
age=$(( $(date +%s) - $(stat -c %Y "$newest") ))
[ "$age" -le $((26 * 3600)) ] || { log "ERROR: newest dump is $((age / 3600)) h old, refusing to upload it as fresh"; exit 1; }

if restic backup "$newest" --tag "$TAG" --quiet; then
  log "OK: uploaded $(basename "$newest")"
else
  log "ERROR: restic backup failed"; exit 1
fi
# Retention for this tag only (the business-runtime snapshots keep their own policy).
restic forget --tag "$TAG" --keep-daily 14 --keep-weekly 8 --prune --quiet >>"$LOG_FILE" 2>&1 || log "WARN: forget/prune failed"
restic check --read-data-subset=1/20 --quiet >>"$LOG_FILE" 2>&1 || { log "ERROR: restic check failed"; exit 1; }
