#!/bin/bash
# Auto: wait for Qwen 3.5-4B download → load → bench → report
set -u

LMS="/c/Users/buiho/.lmstudio/bin/lms"
TARGET_FILE="/c/Users/buiho/.lmstudio/models/lmstudio-community/Qwen3.5-4B-GGUF/Qwen3.5-4B-Q4_K_M.gguf"
LOG=".orcai/bench-4b-auto.log"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

log "waiting for 3.5-4B download"
while [ ! -f "$TARGET_FILE" ]; do
  sleep 60
done
log "download complete: $(du -h "$TARGET_FILE" | cut -f1)"

# Unload everything, load 4B as local-heavy
log "loading 3.5-4B as local-heavy..."
"$LMS" unload --all 2>&1 | tail -2 | tee -a "$LOG"
sleep 3
"$LMS" load qwen/qwen3.5-4b --identifier local-heavy --gpu max --context-length 4096 -y 2>&1 | tail -3 | tee -a "$LOG"

# Verify + warm-up
log "warm-up inference..."
curl -s -m 60 http://localhost:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"local-heavy","messages":[{"role":"user","content":"/no_think Say OK"}],"max_tokens":30}' | head -c 300 | tee -a "$LOG"
echo | tee -a "$LOG"

# Run bench
log "running bench 40 realistic problems..."
BSTART=$(date +%s)
LITELLM_URL=http://localhost:1234 \
LITELLM_KEY= \
BENCH_TIMEOUT_MS=180000 \
BENCH_RAG_MAX_EXAMPLES=2 \
BENCH_RAG_MIN_SIMILARITY=0.72 \
BENCH_NO_HINTS=1 \
node test/coding-quality-bench-rag.js --problem-set realistic --models local-heavy 2>&1 | tail -20 | tee -a "$LOG"

BEND=$(date +%s)
DUR=$((BEND - BSTART))
log "bench done in ${DUR}s"

# Extract final score
SCORE=$(grep -oE 'local-heavy\s*\|\s*yes\s*\|\s*[0-9]+/200' "$LOG" | tail -1 | grep -oE '[0-9]+/200')
log "SCORE: ${SCORE:-unknown}"

# Save to summary
cat > .orcai/bench-4b-result.md <<EOF
# Qwen 3.5-4B Zero-Shot Bench Result

Date: $(date +%FT%T)
Score: **${SCORE:-unknown}** (out of 200)
Duration: ${DUR}s
Model file: $TARGET_FILE

## Compare to other models

| Model | Score | Speed |
|---|---|---|
| Qwen 2.5-Coder-1.5B | 155/200 (77.5%) | 4m07s |
| Qwen 2.5-Coder-3B | 158/200 (79.0%) | 7m07s |
| **Qwen 3.5-4B** | **${SCORE:-?}** | ${DUR}s |
| Qwen 2.5-Coder-7B baseline | 173/200 (86.5%) | 8m07s |
| Qwen 2.5-Coder-7B FT v1 | 174/200 (87.0%) | 9m20s |
| Qwen 3.5-9B | 180/200 (90.0%) | 25m34s |

## Decision

If score ≥ 160/200 (80%): **proceed to cloud FT**
If score < 160: consider Qwen 3-8B instead
EOF

log "result saved to .orcai/bench-4b-result.md"
