#!/bin/bash
set -e

# Ensure claude config directory exists
mkdir -p /data/claude/.claude

# Symlink claude home so credentials persist across deploys
export HOME=/data/claude

# Start the agent
exec npx tsx src/index.ts
