#!/bin/bash
# ============================================
# Ask — Goi model qua Analytics proxy (tu dong track cost)
#
# Usage:
#   bash ask.sh <model> "<prompt>" [project] [command]
#
# Examples:
#   bash ask.sh default "Viet NestJS guard" FashionEcom /build
#   bash ask.sh fast "Review code nay" VietNet2026 /review
#   bash ask.sh cheap "Viet JSDoc" WebPhoto /docs
#
# Models: default (Kimi), smart (Sonnet), fast (Gemini), cheap (DeepSeek)
# ============================================

ANALYTICS="http://localhost:9081"
MODEL="${1:-default}"
PROMPT="$2"
PROJECT="${3:-unknown}"
COMMAND="${4:-}"
SESSION="${SESSION_ID:-$(date +%Y%m%d-%H%M)}"
MAX_TOKENS="${MAX_TOKENS:-2000}"

if [ -z "$PROMPT" ]; then
  echo "Usage: bash ask.sh <model> \"<prompt>\" [project] [command]"
  echo ""
  echo "Models:"
  echo "  default  — Kimi K2.5 (general coding)"
  echo "  smart    — Claude Sonnet (architecture, spec)"
  echo "  fast     — Gemini Flash (review, scan)"
  echo "  cheap    — DeepSeek (docs, backend)"
  echo ""
  echo "All requests tracked at: http://localhost:9081/analytics"
  exit 1
fi

# Escape prompt cho JSON
ESCAPED=$(echo "$PROMPT" | jq -Rs .)

RESPONSE=$(curl -s "$ANALYTICS/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": $ESCAPED}],
    \"max_tokens\": $MAX_TOKENS,
    \"temperature\": 0.3,
    \"project\": \"$PROJECT\",
    \"session\": \"$SESSION\",
    \"command\": \"$COMMAND\"
  }" 2>&1)

# Extract content
CONTENT=$(echo "$RESPONSE" | jq -r '.choices[0].message.content // empty' 2>/dev/null)

if [ -n "$CONTENT" ]; then
  echo "$CONTENT"
else
  echo "ERROR: $(echo "$RESPONSE" | jq -r '.error.message // .error // "Unknown"' 2>/dev/null)" >&2
  exit 1
fi
