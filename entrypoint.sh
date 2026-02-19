#!/bin/bash
set -e

# Ensure data directories exist
mkdir -p /data/claude/.claude /data/brain /data/gmail

# Symlink claude home so credentials persist across deploys
export HOME=/data/claude

# Configure git remote for self-improve worker (if GITHUB_REPO is set)
if [ -n "$GITHUB_REPO" ]; then
  cd /app
  if ! git remote get-url origin >/dev/null 2>&1; then
    if [ -n "$GH_TOKEN" ]; then
      git remote add origin "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPO}.git"
    else
      git remote add origin "https://github.com/${GITHUB_REPO}.git"
    fi
  fi
  echo "[entrypoint] Git remote set to github.com/${GITHUB_REPO}"
fi

# ── Boot counter for crash recovery ──
# The counter tracks consecutive crashes. A clean deploy resets it via DEPLOY_ID.
BOOT_COUNTER_FILE="/data/brain/boot-counter"
DEPLOY_ID_FILE="/data/brain/deploy-id"
BOOT_COUNT=0

# Detect fresh deployment by comparing image/commit ID
CURRENT_DEPLOY="${COOLIFY_RESOURCE_UUID:-unknown}-$(date -r /app/package.json +%s 2>/dev/null || echo 'na')"
LAST_DEPLOY=""
if [ -f "$DEPLOY_ID_FILE" ]; then
  LAST_DEPLOY=$(cat "$DEPLOY_ID_FILE" 2>/dev/null || echo "")
fi

if [ "$CURRENT_DEPLOY" != "$LAST_DEPLOY" ]; then
  echo "[entrypoint] Fresh deployment detected, resetting boot counter"
  BOOT_COUNT=0
  echo "$CURRENT_DEPLOY" > "$DEPLOY_ID_FILE"
else
  if [ -f "$BOOT_COUNTER_FILE" ]; then
    BOOT_COUNT=$(cat "$BOOT_COUNTER_FILE" 2>/dev/null || echo "0")
  fi
fi

BOOT_COUNT=$((BOOT_COUNT + 1))
echo "$BOOT_COUNT" > "$BOOT_COUNTER_FILE"

echo "[entrypoint] Boot count: $BOOT_COUNT (deploy: ${CURRENT_DEPLOY})"

# If boot counter > 2, a repeated crash occurred — run recovery in background
# We start the app immediately so healthcheck passes, recovery runs alongside
if [ "$BOOT_COUNT" -gt 2 ]; then
  echo "[entrypoint] Repeated crashes detected (boot #$BOOT_COUNT), running recovery worker in background..."
  (timeout 300 npx tsx src/self-improve.ts --recover 2>&1 || echo "[entrypoint] Recovery worker exited with code $?") &
  RECOVERY_PID=$!
  echo "[entrypoint] Recovery worker started (PID: $RECOVERY_PID), continuing with app startup..."
fi

# Start the agent (reset boot counter on clean exit via trap)
trap 'echo "0" > "$BOOT_COUNTER_FILE"; exit 0' SIGTERM

exec npx tsx src/index.ts
