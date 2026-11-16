#!/usr/bin/env bash
# Copies the newest local database dump to a private Cloudflare R2 bucket, encrypted on the host first.
# Runs after hermes-db-backup (see hermes-backup-offsite.service). Needs /etc/hermes-cloud/r2.env (mode 600):
#   R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
#   R2_BUCKET=<bucket>
#   R2_ACCESS_KEY_ID=...        (token limited to this bucket, object read and write)
#   R2_SECRET_ACCESS_KEY=...
#   BACKUP_PASSPHRASE_FILE=/etc/hermes-cloud/backup.passphrase   (mode 600, also kept in the password manager)
# Without the passphrase an encrypted dump cannot be opened again. Never print any of these values.
set -euo pipefail
umask 077
ENV_FILE=${R2_ENV_FILE:-/etc/hermes-cloud/r2.env}
DUMP_DIR=${DUMP_DIR:-/var/backups/hermes-cloud}
KEEP=${KEEP:-30}
AWSCLI_IMAGE=${AWSCLI_IMAGE:-amazon/aws-cli:2.15.0}

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
: "${R2_ENDPOINT:?}" "${R2_BUCKET:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}" "${BACKUP_PASSPHRASE_FILE:?}"
[ -s "$BACKUP_PASSPHRASE_FILE" ] || { echo "passphrase file missing or empty" >&2; exit 1; }

newest=$(ls -1t "$DUMP_DIR"/hermes-*.dump 2>/dev/null | head -n1 || true)
[ -n "$newest" ] || { echo "no local dump found in $DUMP_DIR" >&2; exit 1; }
# Refuse a stale dump: the local job runs daily, so anything older than 26 hours means it failed.
age=$(( $(date +%s) - $(stat -c %Y "$newest") ))
[ "$age" -le $((26 * 3600)) ] || { echo "newest dump is $((age / 3600)) h old, refusing to upload it as fresh" >&2; exit 1; }

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
name=$(basename "$newest").gpg
gpg --batch --yes --quiet --symmetric --cipher-algo AES256 --passphrase-file "$BACKUP_PASSPHRASE_FILE" -o "$work/$name" "$newest"
sum=$(sha256sum "$work/$name" | cut -d' ' -f1)

aws() {
  docker run --rm --network host -v "$work:/work:ro" \
    -e AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" -e AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" -e AWS_DEFAULT_REGION=auto \
    "$AWSCLI_IMAGE" --endpoint-url "$R2_ENDPOINT" "$@"
}
aws s3 cp "/work/$name" "s3://$R2_BUCKET/db/$name" --only-show-errors
# Verify what landed: same size as the local encrypted file.
remote=$(aws s3api head-object --bucket "$R2_BUCKET" --key "db/$name" --query ContentLength --output text)
local_size=$(stat -c %s "$work/$name")
[ "$remote" = "$local_size" ] || { echo "size mismatch after upload (remote $remote, local $local_size)" >&2; exit 1; }
echo "uploaded db/$name ($local_size bytes, sha256 $sum)"

# Retention: keep the newest $KEEP objects under db/.
aws s3api list-objects-v2 --bucket "$R2_BUCKET" --prefix db/ --query 'sort_by(Contents,&LastModified)[].Key' --output text \
  | tr '\t' '\n' | head -n -"$KEEP" | while read -r key; do
    [ -n "$key" ] && aws s3 rm "s3://$R2_BUCKET/$key" --only-show-errors && echo "pruned $key"
  done
