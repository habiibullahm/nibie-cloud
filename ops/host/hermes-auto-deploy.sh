#!/usr/bin/env bash
# Deploys origin/main with deploy.sh, one run at a time, and only when a file that goes into the backend image or the stack
# changed since the running tag, the commit's `ci` run passed, and an earlier deploy of that commit did not fail.
# Started by the hermes-pull-deploy timer (the host pulls; no inbound port needed), or as the forced command of the GitHub
# Actions deploy key (`restrict,command="bash /usr/local/sbin/hermes-auto-deploy"`), which ignores what the client asks for.
# The repository and its Actions logs are public: the full deploy log stays on the host, only step lines are printed.
# Installed as a copy: sudo install -m 755 ops/host/hermes-auto-deploy.sh /usr/local/sbin/hermes-auto-deploy
set -euo pipefail
REPO=${REPO_DIR:-/opt/hermes-cloud}
ENV_FILE=${ENV_FILE:-/etc/hermes-cloud/backend.env}
LOG_DIR=/var/log/hermes-deploy
# A commit whose deploy failed is marked here and not tried again (each try dumps the database); delete the file to retry.
STATE_DIR=/var/lib/hermes-deploy
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
if [ -e "$STATE_DIR/failed-$target" ]; then
  echo "the deploy of $target failed before; waiting for a newer commit (or delete $STATE_DIR/failed-$target to retry)"
  exit 0
fi

# Only a commit whose `ci` run on a push passed. The repository is public, so the API needs no token.
slug=$(git remote get-url origin | sed -E 's#\.git$##; s#^.*github\.com[:/]##')
ci=$(curl -fsS --max-time 15 -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/$slug/actions/runs?head_sha=$(git rev-parse origin/main)&event=push&per_page=30" \
  | jq -r '[.workflow_runs[] | select(.name == "ci")][0] | if . == null then "missing" elif .status != "completed" then "pending" else .conclusion end') \
  || ci=unknown
if [ "$ci" != success ]; then
  echo "ci for $target is $ci; not deploying"
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
if [ "$status" -ne 0 ]; then
  sudo -n install -d -m 755 "$STATE_DIR"
  sudo -n touch "$STATE_DIR/failed-$target"
fi
exit "$status"
