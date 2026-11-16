#!/usr/bin/env bash
# Restore drill: restores a database dump into a throwaway Postgres container with no network and checks
# that the core tables have rows. Proves the dump is readable, not just present.
#   hermes-restore-drill.sh               use the newest local dump
#   hermes-restore-drill.sh --from-r2     download and decrypt the newest object from R2 first (needs r2.env)
# Exit status is non-zero on any failure. Touches nothing but its own container and temp directory.
set -euo pipefail
umask 077
DUMP_DIR=${DUMP_DIR:-/var/backups/hermes-cloud}
NAME=hc-restore-drill
work=$(mktemp -d)
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

if [ "${1:-}" = "--from-r2" ]; then
  # shellcheck disable=SC1090
  set -a; . "${R2_ENV_FILE:-/etc/hermes-cloud/r2.env}"; set +a
  AWSCLI_IMAGE=${AWSCLI_IMAGE:-amazon/aws-cli:2.15.0}
  aws() { docker run --rm --network host -v "$work:/work" -e AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" -e AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" -e AWS_DEFAULT_REGION=auto "$AWSCLI_IMAGE" --endpoint-url "$R2_ENDPOINT" "$@"; }
  key=$(aws s3api list-objects-v2 --bucket "$R2_BUCKET" --prefix db/ --query 'sort_by(Contents,&LastModified)[-1].Key' --output text)
  [ -n "$key" ] && [ "$key" != None ] || { echo "no object under db/ in the bucket" >&2; exit 1; }
  aws s3 cp "s3://$R2_BUCKET/$key" /work/dump.gpg --only-show-errors
  gpg --batch --quiet --decrypt --passphrase-file "$BACKUP_PASSPHRASE_FILE" -o "$work/dump" "$work/dump.gpg"
  dump="$work/dump"; echo "source: R2 $key"
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
