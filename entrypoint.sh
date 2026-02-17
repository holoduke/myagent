#!/bin/bash
set -e

# Ensure data directories exist
mkdir -p /data/claude/.claude /data/brain

# Symlink claude home so credentials persist across deploys
export HOME=/data/claude

# ── Boot counter for crash recovery ──
BOOT_COUNTER_FILE="/data/brain/boot-counter"
BOOT_COUNT=0

if [ -f "$BOOT_COUNTER_FILE" ]; then
  BOOT_COUNT=$(cat "$BOOT_COUNTER_FILE" 2>/dev/null || echo "0")
fi

BOOT_COUNT=$((BOOT_COUNT + 1))
echo "$BOOT_COUNT" > "$BOOT_COUNTER_FILE"

echo "[entrypoint] Boot count: $BOOT_COUNT"

# If boot counter > 1, a previous crash occurred — run recovery worker
if [ "$BOOT_COUNT" -gt 1 ]; then
  echo "[entrypoint] Crash detected (boot #$BOOT_COUNT), running recovery worker..."
  # Run recovery with a timeout (5 minutes max), don't fail entrypoint if it errors
  timeout 300 npx tsx src/self-improve.ts --recover || echo "[entrypoint] Recovery worker exited with code $?"
  echo "[entrypoint] Recovery worker finished, starting main app..."
fi

# Start the agent
exec npx tsx src/index.ts
