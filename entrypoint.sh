#!/bin/bash
set -e

# Ensure data directories exist
mkdir -p /data/claude/.claude /data/brain /data/gmail

# Install Python 3 + SEO skill dependencies (if not already present)
if ! command -v python3 &>/dev/null; then
  echo "[entrypoint] Installing Python 3 and SEO skill dependencies..."
  apt-get update -qq && apt-get install -y -qq python3 python3-pip >/dev/null 2>&1
  pip3 install --break-system-packages -q beautifulsoup4 requests lxml Pillow validators matplotlib openpyxl 2>/dev/null
  echo "[entrypoint] Python 3 installed"
fi

# Install Gmail MCP server (if not already present)
if ! npm list -g @gongrzhe/server-gmail-autoauth-mcp &>/dev/null; then
  echo "[entrypoint] Installing Gmail MCP server..."
  npm install -g @gongrzhe/server-gmail-autoauth-mcp >/dev/null 2>&1
  echo "[entrypoint] Gmail MCP server installed"
fi

# Install SEO skills (if not already present)
if [ ! -d "/data/claude/.claude/skills/seo" ]; then
  echo "[entrypoint] Installing SEO skills..."
  mkdir -p /data/claude/.claude/skills /data/claude/.claude/agents
  TEMP_SEO=$(mktemp -d)
  git clone --depth 1 https://github.com/AgriciDaniel/claude-seo.git "$TEMP_SEO/claude-seo" 2>/dev/null
  git clone --depth 1 https://github.com/aaron-he-zhu/seo-geo-claude-skills.git "$TEMP_SEO/seo-geo" 2>/dev/null
  mkdir -p /data/claude/.claude/skills/seo
  cp -r "$TEMP_SEO/claude-seo/skills/seo/"* /data/claude/.claude/skills/seo/ 2>/dev/null
  cp "$TEMP_SEO/claude-seo/agents/"*.md /data/claude/.claude/agents/ 2>/dev/null
  cp -r "$TEMP_SEO/seo-geo" /data/claude/.claude/skills/seo-geo/ 2>/dev/null
  rm -rf "$TEMP_SEO"
  echo "[entrypoint] SEO skills installed"
fi

# Symlink claude home so credentials persist across deploys
export HOME=/data/claude

# Set owner email for action verifier (allows sending email to Gillis)
export OWNER_EMAIL="${OWNER_EMAIL:-gillis.haasnoot@gmail.com}"

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
# Only counts boots within a 10-minute window to avoid false alarms from
# routine restarts that happen hours apart.
BOOT_COUNTER_FILE="/data/brain/boot-counter"
BOOT_TIMESTAMP_FILE="/data/brain/boot-timestamp"
DEPLOY_ID_FILE="/data/brain/deploy-id"
BOOT_COUNT=0
CRASH_WINDOW=600  # 10 minutes — boots outside this window reset the counter

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
  # Reset counter if last boot was outside the crash window
  if [ -f "$BOOT_TIMESTAMP_FILE" ]; then
    LAST_BOOT_TS=$(cat "$BOOT_TIMESTAMP_FILE" 2>/dev/null || echo "0")
    NOW_TS=$(date +%s)
    ELAPSED=$((NOW_TS - LAST_BOOT_TS))
    if [ "$ELAPSED" -gt "$CRASH_WINDOW" ]; then
      echo "[entrypoint] Last boot was ${ELAPSED}s ago (>${CRASH_WINDOW}s), resetting counter (was $BOOT_COUNT)"
      BOOT_COUNT=0
    fi
  fi
fi

BOOT_COUNT=$((BOOT_COUNT + 1))
echo "$BOOT_COUNT" > "$BOOT_COUNTER_FILE"
date +%s > "$BOOT_TIMESTAMP_FILE"

echo "[entrypoint] Boot count: $BOOT_COUNT (deploy: ${CURRENT_DEPLOY})"

# If boot counter > 2, a repeated crash occurred — run recovery in background
# We start the app immediately so healthcheck passes, recovery runs alongside
# Skip recovery when brain is disabled (respects the master kill switch)
if [ "$BOOT_COUNT" -gt 2 ]; then
  BRAIN_CONFIG="/data/brain/config.json"
  BRAIN_OFF="false"
  if [ -f "$BRAIN_CONFIG" ]; then
    BRAIN_ENABLED=$(python3 -c "import json; print(json.load(open('$BRAIN_CONFIG')).get('enabled', True))" 2>/dev/null || echo "True")
    if [ "$BRAIN_ENABLED" = "False" ] || [ "$BRAIN_ENABLED" = "false" ]; then
      BRAIN_OFF="true"
    fi
  fi

  if [ "$BRAIN_OFF" = "true" ]; then
    echo "[entrypoint] Repeated crashes detected (boot #$BOOT_COUNT), but brain is DISABLED — skipping recovery worker"
  else
    # Deterministic recovery: revert the last self-improve merge on a branch,
    # open a PR and push it through the verified merge path (tsc + vitest in a
    # worktree, capped at 10 min). The worker budgets 840 s internally, so the
    # outer timeout must stay above that.
    echo "[entrypoint] Repeated crashes detected (boot #$BOOT_COUNT), running recovery worker in background..."
    (timeout 900 npx tsx backend/self-improve.ts --recover 2>&1 || echo "[entrypoint] Recovery worker exited with code $?") &
    RECOVERY_PID=$!
    echo "[entrypoint] Recovery worker started (PID: $RECOVERY_PID), continuing with app startup..."
  fi
fi

# Start the agent. Run node directly (tsx as a loader) so Coolify's SIGTERM
# (`docker stop -t 30`) reaches the process: through `npx tsx` the signal was
# swallowed, the app never released its instance lease, and every handover
# waited for the lock to go stale. (A shell trap cannot run after exec; the
# boot counter is reset by the app's own clean-exit path.)

exec node --import tsx backend/index.ts
