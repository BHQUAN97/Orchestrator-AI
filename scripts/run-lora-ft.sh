#!/bin/bash
# Master launcher for LoRA FT pipeline.
# Usage: bash scripts/run-lora-ft.sh
#
# Prereq:
#   - .venv-ft exists with deps installed (torch, transformers, peft, trl, bitsandbytes)
#   - LM Studio server STOPPED (release ~5 GB VRAM)
#
# Flow:
#   1. Sanity check: CUDA + VRAM free + training data present
#   2. Run train-lora-qwen3b.py (1-2h on GTX 1060)
#   3. Run merge-lora.py (~10 min — loads fp16 base)
#   4. Print GGUF conversion instructions (requires llama.cpp)

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PY="$ROOT/.venv-ft/Scripts/python.exe"
[ ! -x "$PY" ] && PY="$ROOT/.venv-ft/bin/python"

if [ ! -x "$PY" ]; then
  echo "[err] venv Python not found. Run: python -m venv .venv-ft && pip install ..." >&2
  exit 1
fi

echo "[sanity] Python: $($PY --version)"
echo "[sanity] CUDA check..."
"$PY" -c "import torch; assert torch.cuda.is_available(), 'CUDA missing'; print('  device:', torch.cuda.get_device_name(0)); print('  VRAM total:', round(torch.cuda.get_device_properties(0).total_memory/1e9,2),'GB')"

echo "[sanity] VRAM free check (require >= 4.5 GB free — STOP LM Studio if less)..."
free_mb=$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits | head -1)
echo "  free: ${free_mb} MB"
if [ "$free_mb" -lt 4500 ]; then
  echo "[err] VRAM < 4.5 GB free. Stop LM Studio and retry." >&2
  exit 1
fi

echo "[sanity] training data..."
for f in .orcai/training/style.jsonl .orcai/training/classifier.jsonl .orcai/training/distill.jsonl; do
  if [ -f "$f" ]; then
    echo "  ✓ $f ($(wc -l < "$f") pairs)"
  else
    echo "  ✗ MISSING $f"
  fi
done

echo
echo "[train] starting LoRA FT — this will take 1-2 hours."
echo "        live log: tail -f .orcai/ft-output/train.log"
mkdir -p .orcai/ft-output
"$PY" scripts/train-lora-qwen3b.py 2>&1 | tee .orcai/ft-output/train.log

echo
echo "[merge] merging adapter into base model..."
"$PY" scripts/merge-lora.py 2>&1 | tee .orcai/ft-output/merge.log

echo
echo "=== FT pipeline complete ==="
echo "Adapter:       .orcai/ft-output/qwen3b-lora-v1/"
echo "Merged HF:     .orcai/ft-output/qwen3b-merged/"
echo
echo "Next (manual — requires llama.cpp):"
echo "  1) git clone https://github.com/ggerganov/llama.cpp third_party/llama.cpp"
echo "  2) python third_party/llama.cpp/convert_hf_to_gguf.py .orcai/ft-output/qwen3b-merged \\"
echo "       --outfile .orcai/ft-output/qwen3b-lora-v1-f16.gguf --outtype f16"
echo "  3) Copy GGUF to LM Studio models dir and reload."
