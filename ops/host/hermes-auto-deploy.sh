#!/usr/bin/env bash
# Forced command of the GitHub Actions deploy key (`restrict,command="bash /usr/local/sbin/hermes-auto-deploy"` in
# ~ubuntu/.ssh/authorized_keys). It ignores what the client asks for and always deploys origin/main with deploy.sh,
# one run at a time, and only when a file that goes into the backend image or the stack changed since the running tag.
# The repository and its Actions logs are public: the full deploy log stays on the host, only step lines go back.
# Installed as a copy: sudo install -m 755 ops/host/hermes-auto-deploy.sh /usr/local/sbin/hermes-auto-deploy
set -euo pipefail
REPO=${REPO_DIR:-/opt/hermes-cloud}
ENV_FILE=${ENV_FILE:-/etc/hermes-cloud/backend.env}
LOG_DIR=/var/log/hermes-deploy
# Paths whose change needs a new image or a recreate; docs and the frontends deploy elsewhere.
BACKEND_PATHS=(src prisma package.json pnpm-lock.yaml tsconfig.json deploy)

exec 9>/run/lock/hermes-deploy.lock
flock -w 1800 9 || { echo "another deploy held the lock for 30 minutes; stopping" >&2; exit 1; }

cd "$REPO"
git fetch -q origin
running=$(sudo -n grep -m1 '^BACKEND_TAG=' "$ENV_FILE" | cut -d= -f2-)
target=$(git rev-parse --short origin/main)
if git cat-file -e "${running}^{commit}" 2>/dev/null && git diff --quiet "$running" origin/main -- "${BACKEND_PATHS[@]}"; then
  echo "no backend change between $running and $target; nothing to deploy"
  exit 0
fi

sudo -n install -d -m 750 "$LOG_DIR"
log="$LOG_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$target.log"
set +e
bash "$REPO/ops/host/deploy.sh" origin/main 2>&1 | sudo -n tee "$log" >/dev/null
status=${PIPESTATUS[0]}
set -e
sudo -n grep -E '^(==>|target commit:|OK:|NOT READY|ROLLED BACK|ROLLBACK FAILED|migration failed|the checkout|previous image|BACKEND_TAG missing)' "$log" || true
echo "exit $status; full log on the host: $log"
exit "$status"
