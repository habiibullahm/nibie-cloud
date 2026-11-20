#!/usr/bin/env bash
# Restore drill: restores a database dump into a throwaway Postgres container with no network and checks
# that the core tables have rows. Proves the dump is readable, not just present.
#   hermes-restore-drill.sh               use the newest local dump
#   hermes-restore-drill.sh --from-r2     restore the newest nibie-cloud-db snapshot from the R2 restic repo first
# Exit status is non-zero on any failure. Touches nothing but its own container and temp directory.
set -euo pipefail
umask 077
DUMP_DIR=${DUMP_DIR:-/var/backups/hermes-cloud}
NAME=hc-restore-drill
work=$(mktemp -d)
cleanup() { docker rm -fv "$NAME" >/dev/null 2>&1 || true; rm -rf "$work"; }  # -v: postgres:17 makes an anonymous data volume
trap cleanup EXIT

if [ "${1:-}" = "--from-r2" ]; then
  # shellcheck disable=SC1090
  set -a; . "${RESTIC_ENV_FILE:-/etc/restic/r2/env}"; set +a
  restic restore latest --tag nibie-cloud-db --target "$work/restore" --quiet
  dump=$(find "$work/restore" -name 'hermes-*.dump' | head -n1)
  [ -n "$dump" ] || { echo "no dump found in the latest restic snapshot" >&2; exit 1; }
  echo "source: R2 snapshot, $(basename "$dump")"
else
  dump=$(ls -1t "$DUMP_DIR"/hermes-*.dump | head -n1); echo "source: $dump"
fi

docker run -d --name "$NAME" --network none -e POSTGRES_PASSWORD=drill -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 30); do docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 3
docker exec "$NAME" psql -U postgres -qc "create role anon nologin; create role authenticated nologin; create role service_role nologin; create role supabase_auth_admin nologin; create extension if not exists pgcrypto;" >/dev/null
docker exec -i "$NAME" pg_restore -U postgres -d postgres --no-owner --no-privileges < "$dump"
counts=$(docker exec "$NAME" psql -U postgres -Atc 'select (select count(*) from hermes."Plan"), (select count(*) from hermes."Tenant"), (select count(*) from hermes."Instance"), (select count(*) from auth.users)')
echo "rows (plans|tenants|instances|users): $counts"
plans=${counts%%|*}
[ "$plans" -ge 1 ] || { echo "restore drill FAILED: no plans in the restored database" >&2; exit 1; }
echo "restore drill OK"
