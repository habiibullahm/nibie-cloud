#!/usr/bin/env bash
# Deploys the backend on the VPS: dump the database, update the checkout, build, migrate, recreate, wait for
# /readyz, and roll back to the previous image if the new one does not become ready.
# Run by a person, on the VPS:   /opt/hermes-cloud/ops/host/deploy.sh [git-ref]      (default: origin/main)
#   DRY_RUN=1 deploy.sh          prints what it would do and changes nothing
# Database migrations are NOT rolled back (they are forward-only); the dump taken first is the way back for data.
# Never prints values from /etc/hermes-cloud/backend.env.
set -euo pipefail
REPO=${REPO_DIR:-/opt/hermes-cloud}
ENV_FILE=${ENV_FILE:-/etc/hermes-cloud/backend.env}
COMPOSE=(sudo docker compose --env-file "$ENV_FILE" -f "$REPO/deploy/compose.prod.yaml")
# Fleet mode: a host with a fleet manifest keeps the overlay on every deploy and rollback. Without it the
# recreated backend would forget the remote nodes and lose the routing of their instances.
if sudo test -f /etc/hermes-cloud/fleet/fleet.json; then COMPOSE+=(-f "$REPO/deploy/compose.fleet.yaml"); fi
READYZ=${READYZ_URL:-http://127.0.0.1:3000/readyz}
REF=${1:-origin/main}
DRY=${DRY_RUN:-0}

step() { echo "==> $*"; }
run() { if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }

wait_ready() {
  local i
  for i in $(seq 1 40); do
    if curl -fsS --max-time 3 "$READYZ" >/dev/null 2>&1; then return 0; fi
    sleep 3
  done
  return 1
}

cd "$REPO"
previous_tag=$(sudo grep -m1 '^BACKEND_TAG=' "$ENV_FILE" | cut -d= -f2-)
[ -n "$previous_tag" ] || { echo "BACKEND_TAG missing in $ENV_FILE" >&2; exit 1; }
step "current image tag: $previous_tag"
if ! sudo docker image inspect "hermes-cloud-backend:$previous_tag" >/dev/null 2>&1; then
  echo "previous image hermes-cloud-backend:$previous_tag is not on this host, so a rollback would be impossible; stopping" >&2
  exit 1
fi
[ -z "$(git status --porcelain)" ] || { echo "the checkout in $REPO has local changes; stopping" >&2; exit 1; }

step "fetching $REF"
run git fetch -q origin
target_sha=$(git rev-parse --short "$REF" 2>/dev/null || echo "?")
echo "target commit: $target_sha"
[ "$target_sha" != "$previous_tag" ] || echo "note: the target equals the running tag; rebuilding anyway"

step "database dump (the way back for data)"
run sudo /usr/local/sbin/hermes-db-backup

step "checkout $REF"
if [ "$DRY" = 1 ]; then echo "[dry-run] git checkout --detach $REF"; else git checkout -q --detach "$REF"; fi
new_tag=$(git rev-parse --short HEAD)

set_tag() { sudo sed -i "s/^BACKEND_TAG=.*/BACKEND_TAG=$1/" "$ENV_FILE"; }

step "build image $new_tag"
if [ "$DRY" = 1 ]; then echo "[dry-run] set BACKEND_TAG=$new_tag; compose build backend"; else
  set_tag "$new_tag"
  "${COMPOSE[@]}" build backend 2>&1 | tail -3
fi

step "apply migrations"
if [ "$DRY" = 1 ]; then echo "[dry-run] prisma migrate deploy"; else
  if ! "${COMPOSE[@]}" run --rm --no-deps backend node_modules/.bin/prisma migrate deploy 2>&1 | tail -5; then
    echo "migration failed; keeping the running backend on $previous_tag" >&2
    set_tag "$previous_tag"; git checkout -q --detach "$previous_tag" 2>/dev/null || true
    exit 1
  fi
fi

step "recreate backend and caddy"
run "${COMPOSE[@]}" up -d --force-recreate backend caddy

if [ "$DRY" = 1 ]; then echo "[dry-run] wait for $READYZ"; echo "done (dry run)"; exit 0; fi
if wait_ready; then
  echo "OK: backend $new_tag is ready (previous tag was $previous_tag, kept on disk for a manual rollback)"
  exit 0
fi

echo "NOT READY after 2 minutes: rolling back to $previous_tag" >&2
set_tag "$previous_tag"
"${COMPOSE[@]}" up -d --force-recreate backend
if wait_ready; then
  echo "ROLLED BACK: backend $previous_tag is ready again. Migrations from $new_tag stay applied; check that the old code tolerates them." >&2
else
  echo "ROLLBACK FAILED: backend is still not ready. Check: sudo docker logs hermes-cloud-backend-1" >&2
fi
exit 1
