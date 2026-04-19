#!/bin/bash
# Convert merged-v2 → GGUF Q4_K_M. Runs on pod after merge.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MERGED_DIR="$ROOT/.orcai/ft-output/qwen7b-merged-v2"
F16_GGUF="$ROOT/.orcai/ft-output/qwen7b-ft-v2-f16.gguf"
Q4_GGUF="$ROOT/.orcai/ft-output/qwen7b-ft-v2-Q4_K_M.gguf"
LLAMA_CPP_DIR="$ROOT/third_party/llama.cpp"

if [ ! -d "$MERGED_DIR" ]; then
  echo "[err] merged model not found: $MERGED_DIR" >&2
  exit 1
fi

if [ ! -d "$LLAMA_CPP_DIR" ]; then
  mkdir -p "$ROOT/third_party"
  git clone --depth 1 https://github.com/ggerganov/llama.cpp "$LLAMA_CPP_DIR"
fi

pip install --quiet sentencepiece protobuf gguf

QUANTIZE_BIN="$LLAMA_CPP_DIR/build/bin/llama-quantize"
if [ ! -x "$QUANTIZE_BIN" ]; then
  cd "$LLAMA_CPP_DIR"
  cmake -B build -DGGML_CUDA=OFF -DLLAMA_CURL=OFF >/dev/null
  cmake --build build --config Release --target llama-quantize -j $(nproc)
  cd "$ROOT"
fi

if [ ! -f "$F16_GGUF" ]; then
  python "$LLAMA_CPP_DIR/convert_hf_to_gguf.py" "$MERGED_DIR" --outfile "$F16_GGUF" --outtype f16
fi

"$QUANTIZE_BIN" "$F16_GGUF" "$Q4_GGUF" Q4_K_M
rm -f "$F16_GGUF"

echo "=== GGUF READY ==="
ls -lh "$Q4_GGUF"
