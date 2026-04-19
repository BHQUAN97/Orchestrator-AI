#!/bin/bash
# Runs ON THE POD. Full pipeline: train → merge → convert → mark done.
# Launched via nohup so survives SSH drops.
#
# Writes to /workspace/orchai/.orcai/ft-output/:
#   pipeline.log     — full stdout+stderr of all 3 stages
#   stage.{train,merge,convert}.done — progress markers
#   pipeline.done    — final marker (with exit code in content)
#   pipeline.pid     — PID of this script

set -o pipefail

ROOT="/workspace/orchai"
OUT="$ROOT/.orcai/ft-output"
LOG="$OUT/pipeline.log"

mkdir -p "$OUT"
echo $$ > "$OUT/pipeline.pid"

{
  echo "===== pipeline start: $(date -u +%FT%TZ) ====="
  echo "[stage 1/3] TRAIN lora 7b"
  cd "$ROOT" && python3 scripts/train-lora-qwen7b.py
  TRAIN_RC=$?
  echo "[stage 1/3] train rc=$TRAIN_RC"
  if [ $TRAIN_RC -ne 0 ]; then
    echo "PIPELINE_FAILED_AT=train rc=$TRAIN_RC" > "$OUT/pipeline.done"
    exit $TRAIN_RC
  fi
  touch "$OUT/stage.train.done"

  echo "===== $(date -u +%FT%TZ) ====="
  echo "[stage 2/3] MERGE adapter into base"
  cd "$ROOT" && python3 scripts/merge-lora-7b.py
  MERGE_RC=$?
  echo "[stage 2/3] merge rc=$MERGE_RC"
  if [ $MERGE_RC -ne 0 ]; then
    echo "PIPELINE_FAILED_AT=merge rc=$MERGE_RC" > "$OUT/pipeline.done"
    exit $MERGE_RC
  fi
  touch "$OUT/stage.merge.done"

  echo "===== $(date -u +%FT%TZ) ====="
  echo "[stage 3/3] CONVERT merged → GGUF Q4_K_M"
  apt-get update -q && apt-get install -y -q cmake build-essential git >/dev/null 2>&1
  cd "$ROOT" && bash scripts/convert-to-gguf.sh
  CONV_RC=$?
  echo "[stage 3/3] convert rc=$CONV_RC"
  if [ $CONV_RC -ne 0 ]; then
    echo "PIPELINE_FAILED_AT=convert rc=$CONV_RC" > "$OUT/pipeline.done"
    exit $CONV_RC
  fi
  touch "$OUT/stage.convert.done"

  echo "===== pipeline done: $(date -u +%FT%TZ) ====="
  ls -lh "$OUT/qwen7b-ft-v1-Q4_K_M.gguf" 2>&1
  echo "PIPELINE_OK" > "$OUT/pipeline.done"
} >> "$LOG" 2>&1
