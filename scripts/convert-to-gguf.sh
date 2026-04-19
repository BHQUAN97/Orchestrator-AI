#!/bin/bash
# Convert merged HF model → GGUF Q4_K_M for LM Studio.
# Runs ON THE POD after merge-lora-7b.py completes.
#
# Input:  .orcai/ft-output/qwen7b-merged/
# Output: .orcai/ft-output/qwen7b-ft-v1-Q4_K_M.gguf  (~4.4 GB)

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MERGED_DIR="$ROOT/.orcai/ft-output/qwen7b-merged"
OUT_DIR="$ROOT/.orcai/ft-output"
F16_GGUF="$OUT_DIR/qwen7b-ft-v1-f16.gguf"
Q4_GGUF="$OUT_DIR/qwen7b-ft-v1-Q4_K_M.gguf"
LLAMA_CPP_DIR="$ROOT/third_party/llama.cpp"

if [ ! -d "$MERGED_DIR" ]; then
  echo "[err] merged model not found: $MERGED_DIR" >&2
  echo "      Run scripts/merge-lora-7b.py first." >&2
  exit 1
fi

# 1. Clone + build llama.cpp (once)
if [ ! -d "$LLAMA_CPP_DIR" ]; then
  echo "[llama.cpp] cloning..."
  mkdir -p "$ROOT/third_party"
  git clone --depth 1 https://github.com/ggerganov/llama.cpp "$LLAMA_CPP_DIR"
fi

# Install python deps for conversion (tokenizer, sentencepiece)
echo "[llama.cpp] installing python conversion deps..."
pip install --quiet sentencepiece protobuf gguf

# Build llama-quantize binary if missing
QUANTIZE_BIN="$LLAMA_CPP_DIR/build/bin/llama-quantize"
if [ ! -x "$QUANTIZE_BIN" ]; then
  echo "[llama.cpp] building llama-quantize..."
  cd "$LLAMA_CPP_DIR"
  cmake -B build -DGGML_CUDA=OFF -DLLAMA_CURL=OFF >/dev/null
  cmake --build build --config Release --target llama-quantize -j $(nproc)
  cd "$ROOT"
fi

# 2. Convert HF → GGUF f16
if [ ! -f "$F16_GGUF" ]; then
  echo "[convert] HF → GGUF f16..."
  python "$LLAMA_CPP_DIR/convert_hf_to_gguf.py" "$MERGED_DIR" \
    --outfile "$F16_GGUF" \
    --outtype f16
else
  echo "[convert] f16 GGUF already exists, skipping"
fi

# 3. Quantize f16 → Q4_K_M
echo "[quantize] f16 → Q4_K_M..."
"$QUANTIZE_BIN" "$F16_GGUF" "$Q4_GGUF" Q4_K_M

# 4. Cleanup intermediate f16 to save disk
echo "[cleanup] removing intermediate f16 GGUF..."
rm -f "$F16_GGUF"

echo
echo "=== GGUF READY ==="
echo "File:  $Q4_GGUF"
ls -lh "$Q4_GGUF"
echo
echo "Next: download to local and load in LM Studio."
