#!/bin/bash
# Runs ON POD — Round 6 (v3) pipeline: continue-train seq 4096 → merge → convert GGUF.
# Requires: qwen7b-lora-v2 adapter tu R5.5 da duoc upload san vao /workspace/orchai/.orcai/ft-output/

set -o pipefail
ROOT="/workspace/orchai"
OUT="$ROOT/.orcai/ft-output"
LOG="$OUT/pipeline-r6.log"

mkdir -p "$OUT"
echo $$ > "$OUT/pipeline-r6.pid"

{
  echo "===== $(date -u +%FT%TZ) Round 6 pipeline start ====="

  # Pre-check: V2 adapter phai ton tai (continue-train)
  if [ ! -f "$OUT/qwen7b-lora-v2/adapter_config.json" ]; then
    echo "[warn] V2 adapter missing at $OUT/qwen7b-lora-v2"
    echo "[warn] R6 will train FROM SCRATCH unless R6_FRESH_START=1 is set"
    echo "[warn] If this is unintended, upload R5.5 adapter first then re-run"
  fi

  echo "[stage 1/3] TRAIN lora v3-r6 (Qwen 2.5 Coder 7B + 2097 pairs, seq 4096, continue from v2)"
  cd "$ROOT" && python3 scripts/train-lora-qwen7b-v3-r6.py
  TRC=$?
  if [ $TRC -ne 0 ]; then
    echo "PIPELINE_FAILED_AT=train rc=$TRC" > "$OUT/pipeline-r6.done"
    exit $TRC
  fi
  touch "$OUT/stage.train-r6.done"

  echo "===== $(date -u +%FT%TZ) ====="
  echo "[stage 2/3] MERGE adapter v3-r6"
  cd "$ROOT" && python3 scripts/merge-lora-7b-v3-r6.py
  MRC=$?
  if [ $MRC -ne 0 ]; then
    echo "PIPELINE_FAILED_AT=merge rc=$MRC" > "$OUT/pipeline-r6.done"
    exit $MRC
  fi
  touch "$OUT/stage.merge-r6.done"

  echo "===== $(date -u +%FT%TZ) ====="
  echo "[stage 3/3] CONVERT merged-v3-r6 → GGUF Q4_K_M"
  apt-get update -q && apt-get install -y -q cmake build-essential git >/dev/null 2>&1
  cd "$ROOT" && bash scripts/convert-to-gguf-v3-r6.sh
  CRC=$?
  if [ $CRC -ne 0 ]; then
    echo "PIPELINE_FAILED_AT=convert rc=$CRC" > "$OUT/pipeline-r6.done"
    exit $CRC
  fi
  touch "$OUT/stage.convert-r6.done"

  echo "===== $(date -u +%FT%TZ) pipeline done ====="
  ls -lh "$OUT/qwen7b-ft-v3-r6-Q4_K_M.gguf" 2>&1
  echo "PIPELINE_OK" > "$OUT/pipeline-r6.done"
} >> "$LOG" 2>&1
