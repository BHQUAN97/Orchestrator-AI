#!/bin/bash
# Bench all local models sequentially. Log score + PC health.
# Output: .orcai/bench-all-models-<timestamp>.md

set -u
TS=$(date +%Y%m%d-%H%M%S)
OUT=".orcai/bench-all-models-${TS}.md"
LMS="/c/Users/buiho/.lmstudio/bin/lms"

# Models to bench: (lms_name, identifier_for_bench, expected_vram_gb, max_bench_minutes)
MODELS=(
  "qwen2.5-coder-1.5b-instruct|Qwen 2.5 Coder 1.5B|1|15"
  "qwen2.5-coder-3b-instruct|Qwen 2.5 Coder 3B|2|15"
  "qwen2.5-coder-7b-instruct|Qwen 2.5 Coder 7B (baseline)|4.4|25"
  "qwen2.5-coder-7b-ft-v1|Qwen 2.5 Coder 7B FT v1 (Round 5)|4.4|25"
  "unsloth/qwen3.5-9b|Qwen 3.5 9B (thinking, slow)|6|90"
)

{
  echo "# Bench All Models — $TS"
  echo ""
  echo "| Model | Score | Latency total | Notes |"
  echo "|---|---|---|---|"
} > "$OUT"

for entry in "${MODELS[@]}"; do
  IFS='|' read -r KEY NAME VRAM MAX_MIN <<< "$entry"

  echo ""
  echo "===== $NAME ====="
  echo "key=$KEY vram_est=${VRAM}GB max=${MAX_MIN}min"
  date

  # Unload all
  "$LMS" unload --all 2>&1 | tail -2

  # Pre-bench PC state
  echo "pre-load GPU/RAM:"
  nvidia-smi --query-gpu=memory.free,memory.used,temperature.gpu,power.draw --format=csv,noheader
  powershell -Command "Get-CimInstance Win32_OperatingSystem | Select-Object @{N='FreeRAM_MB';E={[math]::Round(\$_.FreePhysicalMemory/1024)}} | Format-List" 2>&1 | grep FreeRAM

  # Load with identifier local-heavy
  echo "loading..."
  timeout 180 "$LMS" load "$KEY" --identifier local-heavy --gpu max --context-length 4096 -y 2>&1 | tail -2
  if [ $? -ne 0 ]; then
    echo "LOAD FAILED — skip"
    echo "| $NAME | LOAD_FAILED | — | Failed to load |" >> "$OUT"
    continue
  fi

  # Warm-up inference (1 request to JIT)
  curl -s -m 30 http://localhost:1234/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{"model":"local-heavy","messages":[{"role":"user","content":"Say OK"}],"max_tokens":10}' >/dev/null

  # Run bench
  echo "running bench (timeout ${MAX_MIN} min)..."
  BENCH_START=$(date +%s)

  timeout ${MAX_MIN}m bash -c "
    LITELLM_URL=http://localhost:1234 \
    LITELLM_KEY= \
    BENCH_TIMEOUT_MS=120000 \
    BENCH_RAG_MAX_EXAMPLES=2 \
    BENCH_RAG_MIN_SIMILARITY=0.72 \
    BENCH_NO_HINTS=1 \
    node test/coding-quality-bench-rag.js --problem-set realistic --models local-heavy 2>&1 | tail -40
  " > /tmp/bench-${KEY//\//_}.log 2>&1

  BENCH_END=$(date +%s)
  DUR_MIN=$(( (BENCH_END - BENCH_START) / 60 ))
  DUR_SEC=$(( (BENCH_END - BENCH_START) % 60 ))

  # Extract score from bench output
  SCORE=$(grep -oE '\| local-heavy \| yes \| [0-9]+/200' /tmp/bench-${KEY//\//_}.log | tail -1 | grep -oE '[0-9]+/200')
  if [ -z "$SCORE" ]; then
    SCORE=$(grep -oE 'score=[0-9]+/[0-9]+' /tmp/bench-${KEY//\//_}.log | tail -20 | awk -F'=' '{split($2, a, "/"); s+=a[1]; m+=a[2]} END{if(m>0) print s"/"m}')
  fi

  # Post-bench PC state
  echo "post-bench GPU temp:"
  nvidia-smi --query-gpu=temperature.gpu,power.draw --format=csv,noheader

  # Report
  echo "| $NAME | ${SCORE:-TIMEOUT} | ${DUR_MIN}m${DUR_SEC}s | $(tail -3 /tmp/bench-${KEY//\//_}.log | head -1 | tr -d '|' | head -c 60) |" >> "$OUT"

  date
  echo "===== DONE $NAME ====="
done

"$LMS" unload --all 2>&1 | tail -2

echo ""
echo "===== SUMMARY ====="
cat "$OUT"
echo ""
echo "Full logs: /tmp/bench-*.log"
