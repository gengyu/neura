#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${NEURA_BIN_DIR:-$HOME/.local/bin}"
TARGET="$TARGET_DIR/neura"

if [ -L "$TARGET" ] || [ -f "$TARGET" ]; then
  rm -f "$TARGET"
  echo "Removed $TARGET"
else
  echo "No local neura command found at $TARGET"
fi

echo "Data, backups, exports, and .env were left untouched."
