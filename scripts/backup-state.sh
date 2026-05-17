#!/bin/bash
# Meridian daily state backup
# Runs via system cron at 3am MYT
# Retention: 7 days

set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$BASE_DIR/backups"
TODAY=$(date +%F)
DEST="$BACKUP_DIR/$TODAY"

# Files to backup
FILES=(
  "state.json"
  "user-config.json"
  "lessons.json"
  "decision-log.json"
  "pool-memory.json"
  "signal-weights.json"
  "smart-wallets.json"
  "hivemind-cache.json"
)

mkdir -p "$DEST"

backed=0
for f in "${FILES[@]}"; do
  src="$BASE_DIR/$f"
  if [ -f "$src" ]; then
    cp "$src" "$DEST/"
    backed=$((backed + 1))
  fi
done

echo "[$(date -Iseconds)] Backed up $backed files to $DEST"

# Retention: remove backups older than 7 days
find "$BACKUP_DIR" -maxdepth 1 -type d -name "20*" -mtime +7 -exec rm -rf {} + 2>/dev/null || true
