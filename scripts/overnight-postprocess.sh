#!/bin/bash
# Post-download: import to LM Studio, run bench, update memory.
# Runs after monitor confirms GGUF downloaded + pod terminated.

set -u
ROOT="/e/DEVELOP/ai-orchestrator"
cd "$ROOT"

LMS="/c/Users/buiho/.lmstudio/bin/lms"
LMS_MODELS_DIR="/c/Users/buiho/.lmstudio/models"
FT_OUT="$ROOT/.orcai/ft-output-v2"
LOG="$ROOT/.orcai/overnight-postprocess.log"
STATUS_FILE="$ROOT/.orcai/overnight-status.md"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

update_status() {
  cat >> "$STATUS_FILE" <<EOF

## Post-process ($(date +%H:%M:%S))
$1
EOF
}

log "=== Post-process start ==="
update_status "🟡 POSTPROCESS start"

# 1. Import GGUF into LM Studio models dir
MODEL_NAME="qwen2.5-coder-7b-ft-v2"
IMPORT_DIR="$LMS_MODELS_DIR/local/$MODEL_NAME"
mkdir -p "$IMPORT_DIR"
cp "$FT_OUT/qwen7b-ft-v2-Q4_K_M.gguf" "$IMPORT_DIR/qwen7b-ft-v2-Q4_K_M.gguf"
log "copied gguf to $IMPORT_DIR"

# 2. Unload all + load v2 as local-heavy
"$LMS" unload --all 2>&1 | tail -2 | tee -a "$LOG"
sleep 3
log "loading $MODEL_NAME as local-heavy..."
"$LMS" load "local/$MODEL_NAME" --identifier local-heavy --gpu max --context-length 4096 -y 2>&1 | tail -3 | tee -a "$LOG"

# 3. Warm-up
log "warm-up inference..."
curl -s -m 60 http://localhost:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"local-heavy","messages":[{"role":"user","content":"Say OK"}],"max_tokens":30}' | head -c 200 >> "$LOG"
echo "" >> "$LOG"

# 4. Run bench
log "running bench 40 realistic problems (timeout 25min)..."
BSTART=$(date +%s)
timeout 25m bash -c "
  LITELLM_URL=http://localhost:1234 \
  LITELLM_KEY= \
  BENCH_TIMEOUT_MS=120000 \
  BENCH_RAG_MAX_EXAMPLES=2 \
  BENCH_RAG_MIN_SIMILARITY=0.72 \
  BENCH_NO_HINTS=1 \
  node test/coding-quality-bench-rag.js --problem-set realistic --models local-heavy 2>&1 | tail -30
" > "$FT_OUT/bench-ft-v2.log" 2>&1
BEND=$(date +%s)
DUR=$((BEND - BSTART))
log "bench done in ${DUR}s"

# 5. Extract score
SCORE=$(grep -oE 'local-heavy\s*\|\s*yes\s*\|\s*[0-9]+/200' "$FT_OUT/bench-ft-v2.log" | tail -1 | grep -oE '[0-9]+/200')
log "SCORE: ${SCORE:-unknown}"

# 6. Write result file
PCT=""
if [ -n "$SCORE" ]; then
  NUM=$(echo "$SCORE" | cut -d/ -f1)
  PCT=$(awk "BEGIN { printf \"%.1f\", $NUM/2 }")
fi
cat > "$FT_OUT/bench-ft-v2-result.md" <<EOF
# Round 5.5 FT v2 Bench Result

Date: $(date +%FT%T)
Model: Qwen 2.5-Coder-7B + LoRA v2 (DoRA, 2097 pairs)
Score: **${SCORE:-unknown}** ${PCT:+(${PCT}%)}
Duration: ${DUR}s

## Leaderboard update

| Model | Score | Speed |
|---|---|---|
| Qwen 2.5-Coder-7B base | 173/200 (86.5%) | 8m07s |
| Qwen 2.5-Coder-7B FT v1 (R5) | 174/200 (87.0%) | 9m20s |
| **Qwen 2.5-Coder-7B FT v2 (R5.5)** | **${SCORE:-?}** ${PCT:+(${PCT}%)} | ${DUR}s |
| Qwen 3.5-9B (heavy) | 180/200 (90.0%) | 25m34s |

## Verdict
$(
  if [ -n "$SCORE" ]; then
    NUM=$(echo "$SCORE" | cut -d/ -f1)
    if [ "$NUM" -ge 180 ]; then
      echo "🎉 MATCHES 3.5-9B — can ship as workhorse"
    elif [ "$NUM" -ge 176 ]; then
      echo "✅ Significant gain over baseline — ship"
    elif [ "$NUM" -ge 174 ]; then
      echo "⚠️ Marginal (≤+1pt over R5) — noise level, consider not shipping FT"
    else
      echo "❌ Regression vs baseline — discard FT, investigate"
    fi
  else
    echo "❓ Could not extract score — check bench-ft-v2.log"
  fi
)
EOF
log "result saved to $FT_OUT/bench-ft-v2-result.md"

# 7. Unload to free VRAM
"$LMS" unload --all 2>&1 | tail -1 | tee -a "$LOG"

update_status "✅ BENCH DONE: ${SCORE:-err} ${PCT:+(${PCT}%)} — see ft-output-v2/bench-ft-v2-result.md"

# 8. Trigger finalize (memory + handoff + push)
log "triggering finalize..."
bash "$ROOT/scripts/overnight-finalize.sh" >> "$LOG" 2>&1 || log "finalize warn (non-fatal)"

log "=== Post-process end ==="
