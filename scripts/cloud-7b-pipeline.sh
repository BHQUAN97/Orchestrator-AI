#!/bin/bash
# Orchestrator for Qwen 7B LoRA FT on RunPod RTX 4090.
# Runs LOCALLY (on Windows git-bash). Coordinates everything via SSH.
#
# Prereq on cloud pod (RunPod PyTorch 2.4.0 image):
#   - CUDA 12.4, Python 3.11, torch pre-installed
#   - /workspace mounted (60 GB volume)
#
# Usage:
#   bash scripts/cloud-7b-pipeline.sh <ssh-host> <ssh-port>
#
# Example (RunPod SSH format: "ssh root@123.45.67.89 -p 12345"):
#   bash scripts/cloud-7b-pipeline.sh 123.45.67.89 12345
#
# Flow:
#   1. Test SSH connection
#   2. rsync training data + scripts → /workspace/orchai
#   3. SSH: install extra deps (peft, trl, bitsandbytes, datasets)
#   4. SSH: run train-lora-qwen7b.py (~2h)
#   5. SSH: run merge-lora-7b.py (~15 min)
#   6. SSH: run convert-to-gguf.sh (~20 min, includes clone+build llama.cpp)
#   7. scp download Q4_K_M GGUF to local
#   8. Print instructions to stop pod

set -e

if [ $# -lt 2 ]; then
  echo "Usage: $0 <ssh-host> <ssh-port>" >&2
  echo "  Example: $0 123.45.67.89 12345" >&2
  exit 1
fi

SSH_HOST="$1"
SSH_PORT="$2"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
REMOTE_ROOT="/workspace/orchai"

# Quieter SSH options
SSH_OPTS="-i $SSH_KEY -p $SSH_PORT -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=60"
RSYNC_SSH="ssh $SSH_OPTS"

# =========== Step 1: test SSH ===========
echo "[1/8] testing SSH to $SSH_USER@$SSH_HOST:$SSH_PORT..."
ssh $SSH_OPTS "$SSH_USER@$SSH_HOST" "echo '  ✓ connected, $(hostname) $(python3 --version)'"

# =========== Step 2: rsync code + data ===========
echo "[2/8] uploading code + training data..."
ssh $SSH_OPTS "$SSH_USER@$SSH_HOST" "mkdir -p $REMOTE_ROOT/.orcai/training $REMOTE_ROOT/scripts $REMOTE_ROOT/.orcai/ft-output"

rsync -avz --progress -e "$RSYNC_SSH" \
  .orcai/training/style.jsonl \
  .orcai/training/classifier.jsonl \
  .orcai/training/distill.jsonl \
  "$SSH_USER@$SSH_HOST:$REMOTE_ROOT/.orcai/training/"

rsync -avz --progress -e "$RSYNC_SSH" \
  scripts/train-lora-qwen7b.py \
  scripts/merge-lora-7b.py \
  scripts/convert-to-gguf.sh \
  "$SSH_USER@$SSH_HOST:$REMOTE_ROOT/scripts/"

# =========== Step 3: install deps ===========
echo "[3/8] installing deps on pod..."
ssh $SSH_OPTS "$SSH_USER@$SSH_HOST" bash -c "'
  set -e
  cd $REMOTE_ROOT
  pip install --quiet --no-cache-dir \
    peft==0.13.2 \
    trl==0.11.4 \
    bitsandbytes==0.44.1 \
    datasets==3.0.2 \
    accelerate==1.0.1 \
    sentencepiece \
    protobuf
  echo \"  ✓ deps installed\"
  python3 -c \"import torch; print(\\\"  cuda:\\\", torch.cuda.get_device_name(0), \\\"vram:\\\", round(torch.cuda.get_device_properties(0).total_memory/1e9,1), \\\"GB\\\")\"
'"

# =========== Step 4: train ===========
echo "[4/8] TRAINING (expect ~2h on RTX 4090)..."
echo "      live log on pod: /workspace/orchai/.orcai/ft-output/train.log"
ssh $SSH_OPTS "$SSH_USER@$SSH_HOST" bash -c "'
  set -e
  cd $REMOTE_ROOT
  mkdir -p .orcai/ft-output
  python3 scripts/train-lora-qwen7b.py 2>&1 | tee .orcai/ft-output/train.log
'"

# =========== Step 5: merge ===========
echo "[5/8] merging adapter..."
ssh $SSH_OPTS "$SSH_USER@$SSH_HOST" bash -c "'
  set -e
  cd $REMOTE_ROOT
  python3 scripts/merge-lora-7b.py 2>&1 | tee .orcai/ft-output/merge.log
'"

# =========== Step 6: convert GGUF ===========
echo "[6/8] converting to GGUF Q4_K_M..."
ssh $SSH_OPTS "$SSH_USER@$SSH_HOST" bash -c "'
  set -e
  cd $REMOTE_ROOT
  apt-get update -q && apt-get install -y -q cmake build-essential git >/dev/null
  bash scripts/convert-to-gguf.sh 2>&1 | tee .orcai/ft-output/convert.log
'"

# =========== Step 7: download GGUF ===========
echo "[7/8] downloading GGUF to local..."
mkdir -p .orcai/ft-output
rsync -avz --progress -e "$RSYNC_SSH" \
  "$SSH_USER@$SSH_HOST:$REMOTE_ROOT/.orcai/ft-output/qwen7b-ft-v1-Q4_K_M.gguf" \
  .orcai/ft-output/

# Also grab the LoRA adapter (small, keep for future)
rsync -avz --progress -e "$RSYNC_SSH" \
  "$SSH_USER@$SSH_HOST:$REMOTE_ROOT/.orcai/ft-output/qwen7b-lora-v1/" \
  .orcai/ft-output/qwen7b-lora-v1/

echo
echo "=== PIPELINE COMPLETE ==="
ls -lh .orcai/ft-output/qwen7b-ft-v1-Q4_K_M.gguf
echo
echo "[8/8] NEXT STEPS (MANUAL):"
echo "  1) Copy GGUF to LM Studio models dir:"
echo "     cp .orcai/ft-output/qwen7b-ft-v1-Q4_K_M.gguf \\"
echo "        \"\$USERPROFILE/.lmstudio/models/Qwen/Qwen2.5-Coder-7B-FT/\""
echo "  2) LM Studio → rescan models → load Qwen2.5-Coder-7B-FT"
echo "  3) Re-bench: node test/coding-quality-bench-rag.js"
echo
echo "  4) STOP POD (avoid ongoing charge):"
echo "     RunPod web → Pods → your pod → Stop (or Terminate if done)"
echo "     Cost so far: \$0.69/hr × training time"
