#!/usr/bin/env bash
# Encrypt .env.<env> -> .env.<env>.enc
# Usage: bash scripts/secrets/encrypt.sh [prod|staging] (default: prod)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

ENV="${1:-prod}"
SRC=".env.$ENV"
DST=".env.$ENV.enc"

[[ ! -f "$SRC" ]] && { echo "FAIL: Khong tim thay $SRC"; exit 1; }
[[ ! -f .sops.yaml ]] && { echo "FAIL: Chua init SOPS. Chay init-repo.sh truoc"; exit 1; }
command -v sops &>/dev/null || { echo "FAIL: Chua cai sops"; exit 1; }

sops --encrypt "$SRC" > "$DST"
echo "[OK] $SRC -> $DST"
echo ""
echo "NEXT: git add $DST && git commit -m 'chore: update encrypted secrets'"
