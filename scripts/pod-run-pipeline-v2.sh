#!/bin/bash
# Runs ON POD — Round 5.5 pipeline (train v2 → merge → convert GGUF).
# CONTRACT with monitor (monitor-smart.sh):
#   - On failure: write "PIPELINE_FAILED_AT=<stage> rc=<code>" to $OUT/pipeline.done and exit.
#   - NEVER kill/stop/terminate the pod from here. Monitor never auto-stops on failure either —
#     the user decides recovery. Volume is preserved so user can inspect and resume.
#   - On success: write "PIPELINE_OK" to $OUT/pipeline.done. Monitor handles terminate.

set -o pipefail
ROOT="/workspace/orchai"
OUT="$ROOT/.orcai/ft-output"
LOG="$OUT/pipeline.log"

mkdir -p "$OUT"
echo $$ > "$OUT/pipeline.pid"

{
  echo "===== $(date -u +%FT%TZ) Round 5.5 pipeline start ====="
  echo "[stage 1/3] TRAIN lora v2 (Qwen 2.5 Coder 7B + 2097 pairs)"
  cd "$ROOT" && python3 scripts/train-lora-qwen7b-v2.py
  TRC=$?
  if [ $TRC -ne 0 ]; then
    echo "PIPELINE_FAILED_AT=train rc=$TRC" > "$OUT/pipeline.done"
    exit $TRC
  fi
  touch "$OUT/stage.train.done"

  echo "===== $(date -u +%FT%TZ) ====="
  echo "[stage 2/3] MERGE adapter v2"
  cd "$ROOT" && python3 scripts/merge-lora-7b-v2.py
  MRC=$?
  if [ $MRC -ne 0 ]; then
    echo "PIPELINE_FAILED_AT=merge rc=$MRC" > "$OUT/pipeline.done"
    exit $MRC
  fi
  touch "$OUT/stage.merge.done"

  echo "===== $(date -u +%FT%TZ) ====="
  echo "[stage 3/3] CONVERT merged-v2 → GGUF Q4_K_M"
  apt-get update -q && apt-get install -y -q cmake build-essential git >/dev/null 2>&1
  # Override convert script paths for v2
  export MERGED_DIR="$ROOT/.orcai/ft-output/qwen7b-merged-v2"
  export OUT_GGUF="$ROOT/.orcai/ft-output/qwen7b-ft-v2-Q4_K_M.gguf"
  cd "$ROOT" && bash scripts/convert-to-gguf-v2.sh
  CRC=$?
  if [ $CRC -ne 0 ]; then
    echo "PIPELINE_FAILED_AT=convert rc=$CRC" > "$OUT/pipeline.done"
    exit $CRC
  fi
  touch "$OUT/stage.convert.done"

  echo "===== $(date -u +%FT%TZ) pipeline done ====="
  ls -lh "$OUT/qwen7b-ft-v2-Q4_K_M.gguf" 2>&1
  echo "PIPELINE_OK" > "$OUT/pipeline.done"
} >> "$LOG" 2>&1
