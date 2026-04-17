#!/usr/bin/env bash
# Decrypt .env.<env>.enc -> .env.<env>
# Chay tren VPS khi deploy, hoac local khi can edit
# Usage: bash scripts/secrets/decrypt.sh [prod|staging] (default: prod)
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

ENV="${1:-prod}"
SRC=".env.$ENV.enc"
DST=".env.$ENV"

[[ ! -f "$SRC" ]] && { echo "FAIL: Khong tim thay $SRC"; exit 1; }
command -v sops &>/dev/null || { echo "FAIL: Chua cai sops"; exit 1; }

# Check age key co san khong
if [[ -z "${SOPS_AGE_KEY_FILE:-}" ]]; then
  # Thu vi tri mac dinh
  for p in \
    "$HOME/.config/sops/age/keys.txt" \
    "$HOME/AppData/Roaming/sops/age/keys.txt" \
    "/root/.config/sops/age/keys.txt"; do
    [[ -f "$p" ]] && export SOPS_AGE_KEY_FILE="$p" && break
  done
fi

if [[ -z "${SOPS_AGE_KEY_FILE:-}" ]] || [[ ! -f "$SOPS_AGE_KEY_FILE" ]]; then
  echo "FAIL: Khong tim thay age private key."
  echo "  Set env: export SOPS_AGE_KEY_FILE=/path/to/keys.txt"
  echo "  Hoac copy key vao: ~/.config/sops/age/keys.txt"
  exit 1
fi

sops --decrypt "$SRC" > "$DST"
chmod 600 "$DST"
echo "[OK] $SRC -> $DST (chmod 600)"
