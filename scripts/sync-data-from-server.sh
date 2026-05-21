#!/bin/bash
# Sync data files from server to local meridian directory
# Usage: ./scripts/sync-data-from-server.sh

set -euo pipefail

REMOTE_HOST="root@167.71.209.135"
REMOTE_PATH="/opt/meridian"
LOCAL_PATH="/Users/faizal/Sites/games/aiagents/meridian"

FILES=(
  "user-config.json"
  "state.json"
  "pool-memory.json"
  "lessons.json"
  "decision-log.json"
  "signal-weights.json"
  "smart-wallets.json"
  "hivemind-cache.json"
  "discord-signals.json"
  "config-snapshots.json"
  "deployer-blacklist.json"
  "strategy-library.json"
)

echo "Syncing data from $REMOTE_HOST:$REMOTE_PATH to $LOCAL_PATH"

synced=0
failed=0
for f in "${FILES[@]}"; do
  if scp -q "$REMOTE_HOST:$REMOTE_PATH/$f" "$LOCAL_PATH/$f" 2>/dev/null; then
    echo "✓ $f"
    synced=$((synced + 1))
  else
    echo "✗ $f (not found)"
    failed=$((failed + 1))
  fi
done

echo ""
echo "Done: $synced synced, $failed not found"
