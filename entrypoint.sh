#!/bin/bash
set -e

# Ensure data directories exist
mkdir -p /data/claude/.claude /data/brain

# Symlink claude home so credentials persist across deploys
export HOME=/data/claude

# Start the agent
exec npx tsx src/index.ts
