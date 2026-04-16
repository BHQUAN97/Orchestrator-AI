#!/bin/bash
# ============================================
# AI Orchestrator CLI — Goi model qua LiteLLM
# Dung trong Claude Code commands hoac terminal
#
# Usage:
#   bash cli.sh <model> "<prompt>"
#   bash cli.sh fast "Review code nay: ..."
#   bash cli.sh cheap "Viet JSDoc cho function: ..."
#   bash cli.sh default "Fix bug: ..."
#
# Models: default, smart, fast, cheap
# ============================================

PROXY="http://localhost:5002"
KEY="sk-master-change-me"
MODEL="${1:-default}"
PROMPT="$2"
MAX_TOKENS="${3:-4000}"

if [ -z "$PROMPT" ]; then
  echo "Usage: bash cli.sh <model> \"<prompt>\" [max_tokens]"
  echo "Models: default (DeepSeek), smart (Sonnet), fast (Gemini), cheap (GPT Mini), architect (Opus)"
  exit 1
fi

# Check LiteLLM running
if ! curl -s "$PROXY/health" -H "Authorization: Bearer $KEY" > /dev/null 2>&1; then
  echo "ERROR: LiteLLM not running. Start: cd E:/DEVELOP/ai-orchestrator && docker compose up -d litellm"
  exit 1
fi

# Call API
RESPONSE=$(curl -s "$PROXY/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": $(echo "$PROMPT" | jq -Rs .)}],
    \"max_tokens\": $MAX_TOKENS,
    \"temperature\": 0.3
  }" 2>&1)

# Extract content
CONTENT=$(echo "$RESPONSE" | jq -r '.choices[0].message.content // empty')

if [ -n "$CONTENT" ]; then
  echo "$CONTENT"
else
  # Error
  ERROR=$(echo "$RESPONSE" | jq -r '.error.message // .error // "Unknown error"')
  echo "ERROR ($MODEL): $ERROR" >&2
  exit 1
fi
