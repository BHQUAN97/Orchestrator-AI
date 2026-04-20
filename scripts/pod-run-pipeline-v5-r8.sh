#!/bin/bash
# Runs ON POD — Round 6 (v3) pipeline: continue-train seq 4096 → merge → convert GGUF.
# Requires: qwen7b-lora-v2 adapter tu R5.5 da duoc upload san vao /workspace/orchai/.orcai/ft-output/

set -o pipefail
ROOT="/workspace/orchai"
OUT="$ROOT/.orcai/ft-output"
LOG="$OUT/pipeline.log"

# Load persistent deps from /workspace/pypkgs (setup-pod.sh)
if [ -f /workspace/setup-env.sh ]; then
  # shellcheck disable=SC1091
  . /workspace/setup-env.sh
fi

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

  echo "[stage 1/3] TRAIN lora v5-r8 (Qwen 2.5 Coder 7B, rank=$R6_LORA_RANK epochs=$R6_EPOCHS seq=$R6_MAX_SEQ_LEN fresh=$R6_FRESH_START)"
  cd "$ROOT" && python3 scripts/train-lora-qwen7b-v5-r8.py
  TRC=$?
  if [ $TRC -ne 0 ]; then
    echo "PIPELINE_FAILED_AT=train rc=$TRC" | tee "$OUT/pipeline-r6.done" > "$OUT/pipeline.done"
    exit $TRC
  fi
  touch "$OUT/stage.train-r6.done" "$OUT/stage.train.done"

  echo "===== $(date -u +%FT%TZ) ====="
  echo "[stage 2/3] MERGE adapter v5-r8"
  cd "$ROOT" && python3 scripts/merge-lora-7b-v5-r8.py
  MRC=$?
  if [ $MRC -ne 0 ]; then
    echo "PIPELINE_FAILED_AT=merge rc=$MRC" | tee "$OUT/pipeline-r6.done" > "$OUT/pipeline.done"
    exit $MRC
  fi
  touch "$OUT/stage.merge-r6.done" "$OUT/stage.merge.done"

  echo "===== $(date -u +%FT%TZ) ====="
  echo "[stage 3/3] CONVERT merged-v5-r8 to GGUF Q4_K_M"
  apt-get update -q && apt-get install -y -q cmake build-essential git >/dev/null 2>&1
  cd "$ROOT" && bash scripts/convert-to-gguf-v5-r8.sh
  CRC=$?
  if [ $CRC -ne 0 ]; then
    echo "PIPELINE_FAILED_AT=convert rc=$CRC" | tee "$OUT/pipeline-r6.done" > "$OUT/pipeline.done"
    exit $CRC
  fi
  touch "$OUT/stage.convert-r6.done" "$OUT/stage.convert.done"

  echo "===== $(date -u +%FT%TZ) pipeline done ====="
  ls -lh "$OUT/qwen7b-ft-v5-r8-Q4_K_M.gguf" 2>&1
  echo "PIPELINE_OK" | tee "$OUT/pipeline-r6.done" > "$OUT/pipeline.done"
} >> "$LOG" 2>&1
