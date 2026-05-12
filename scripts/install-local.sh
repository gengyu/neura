#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${NEURA_BIN_DIR:-$HOME/.local/bin}"
TARGET="$TARGET_DIR/neura"

mkdir -p "$TARGET_DIR"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required. Install it first: https://bun.sh"
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required. Install it first: https://pnpm.io"
  exit 1
fi

cd "$ROOT"
pnpm install
ln -sf "$ROOT/bin/neura.ts" "$TARGET"
chmod +x "$ROOT/bin/neura.ts"

echo "Neura installed:"
echo "  $TARGET -> $ROOT/bin/neura.ts"
echo ""
echo "If needed, add this to your shell profile:"
echo "  export PATH=\"$TARGET_DIR:\$PATH\""
echo ""
echo "Next:"
echo "  cp .env.example .env"
echo "  neura doctor"
echo "  neura start"
