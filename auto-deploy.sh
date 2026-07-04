#!/usr/bin/env sh
# Self-deploy: if origin/main has commits we haven't SUCCESSFULLY deployed, pull them
# and rebuild the container.
# Safe to run on a 1-minute timer (flock-guarded against overlap) OR by hand (`./auto-deploy.sh`).
# Lives in the repo so it self-updates on the next deploy. VM-only — the pob-agent on the
# Main PC is a separate machine and only changes rarely (you'll be told when).
#
# One-time install on the VM (run from the repo dir):
#   chmod +x auto-deploy.sh
#   (crontab -l 2>/dev/null | grep -v auto-deploy.sh; \
#     echo "* * * * * flock -n /tmp/poe-deploy.lock $(pwd)/auto-deploy.sh >> /tmp/poe-deploy.log 2>&1") | crontab -
# Watch it:  tail -f /tmp/poe-deploy.log
set -eu
# cron runs with a bare PATH — make sure docker/git resolve.
export PATH="/usr/local/bin:/usr/bin:/bin:/snap/bin:$PATH"
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

# Compare origin/main against the last sha that FULLY deployed (pull + build OK),
# NOT against HEAD: a failed build after a successful pull leaves HEAD == origin/main,
# so a HEAD comparison makes every later run exit "already current" while the VM keeps
# serving the old container. VM-local untracked state file; delete it to force a redeploy.
STATE_FILE=".last-deployed-sha"

git fetch -q origin main
TARGET="$(git rev-parse origin/main)"
if [ -f "$STATE_FILE" ] && [ "$(cat "$STATE_FILE")" = "$TARGET" ]; then
  exit 0   # already deployed this sha — nothing to do
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] new commit $(git rev-parse --short "$TARGET") — deploying…"
git pull --ff-only -q origin main          # --ff-only = refuse to clobber if the VM repo diverged
docker compose up -d --build
git rev-parse HEAD > "$STATE_FILE"         # record success ONLY after the build came up (set -e skips this on failure)
docker image prune -f                      # dangling layers from repeated --build pile up otherwise
echo "[$(date '+%Y-%m-%d %H:%M:%S')] deployed $(git rev-parse --short HEAD)."
