#!/usr/bin/env bash
# Auto-upload .env.<env> len GitHub Actions Secrets
# Usage: bash scripts/secrets/sync-gh.sh [prod|staging] (default: prod)
# Yeu cau: gh auth login da chay truoc do
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

ENV="${1:-prod}"
ENV_FILE=".env.$ENV"
ENCRYPTED=".env.$ENV.enc"
CLEANUP=false

command -v gh &>/dev/null || { echo "FAIL: Chua cai gh CLI"; exit 1; }
gh auth status &>/dev/null || { echo "FAIL: Chua login gh. Chay: gh auth login"; exit 1; }

# Neu chi co encrypted, decrypt tam
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$ENCRYPTED" ]]; then
    echo "[..] Decrypt $ENCRYPTED tam thoi..."
    bash "$(dirname "$0")/decrypt.sh" "$ENV"
    CLEANUP=true
  else
    echo "FAIL: Khong tim thay $ENV_FILE hoac $ENCRYPTED"
    exit 1
  fi
fi

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null) || {
  echo "FAIL: Khong phai GitHub repo hoac chua set remote"
  exit 1
}

echo "=== Sync secrets -> $REPO (env: $ENV) ==="

# Optional: prefix theo env (vi du PROD_DATABASE_URL)
# PREFIX="$(echo "$ENV" | tr '[:lower:]' '[:upper:]')_"
PREFIX=""

COUNT=0
FAIL_COUNT=0

while IFS= read -r line || [[ -n "$line" ]]; do
  # Bo comment va dong trong
  [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
  [[ ! "$line" =~ = ]] && continue

  key="${line%%=*}"
  value="${line#*=}"

  # Trim whitespace o key
  key="${key#"${key%%[![:space:]]*}"}"
  key="${key%"${key##*[![:space:]]}"}"

  # Bo quote bao quanh value
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"

  # Skip neu key khong hop le
  [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && { echo "  [SKIP] Key khong hop le: $key"; continue; }

  full_key="${PREFIX}${key}"
  printf "  %-40s ... " "$full_key"
  if printf '%s' "$value" | gh secret set "$full_key" --repo "$REPO" --body - 2>/dev/null; then
    echo "OK"
    COUNT=$((COUNT+1))
  else
    echo "FAIL"
    FAIL_COUNT=$((FAIL_COUNT+1))
  fi
done < "$ENV_FILE"

echo ""
echo "=== Ket qua: $COUNT OK, $FAIL_COUNT fail ==="

# Cleanup plaintext neu tu decrypt
if $CLEANUP; then
  rm -f "$ENV_FILE"
  echo "[OK] Da xoa $ENV_FILE tam thoi"
fi
