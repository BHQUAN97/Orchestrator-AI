#!/bin/bash
# Recovery: pipeline succeeded but scp had a bug (fixed), pod is EXITED waiting for GPU free.
# Poll start API every 5 min for up to 12h. When RUNNING, SSH + download GGUF + terminate pod.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SSH_KEY="/c/Users/buiho/.ssh/id_ed25519"
SSH_HOST="root@103.196.86.82"
SSH_PORT="19396"
SSH_OPTS="-i $SSH_KEY -p $SSH_PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=30"
SCP_OPTS="-i $SSH_KEY -P $SSH_PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=30"
POD_ID="f1brfsfulyw1kw"
KEY_FILE="$HOME/.runpod/api-key"

OUT="$ROOT/.orcai/ft-output"
LOG="$OUT/recover.log"
STATUS_FILE="$OUT/pipeline-final-status.txt"

log() { echo "[$(date +%FT%T)] $*" | tee -a "$LOG"; }

log "recovery started — polling pod start every 300s for up to 12h"
echo "RECOVERING — waiting for 4090 host free at=$(date +%FT%T)" > "$STATUS_FILE"

KEY=$(cat "$KEY_FILE")

for i in $(seq 1 144); do  # 144 × 5min = 12h
  # Try start
  RES=$(curl -sS -X POST -H "Authorization: Bearer $KEY" "https://rest.runpod.io/v1/pods/$POD_ID/start" 2>&1)
  # Success if response contains "desiredStatus":"RUNNING"
  if echo "$RES" | grep -q '"desiredStatus":"RUNNING"'; then
    log "iter=$i POD START ACCEPTED — waiting for SSH"
    break
  fi
  # Else error (likely GPU busy)
  ERR=$(echo "$RES" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p' | head -c 100)
  log "iter=$i start err: $ERR"
  sleep 300
done

if ! echo "$RES" | grep -q '"desiredStatus":"RUNNING"'; then
  log "TIMEOUT: pod never resumed. Leaving as-is. User must decide (retrain or retry later)."
  echo "TIMEOUT_GPU_UNAVAILABLE_12H at=$(date +%FT%T)" > "$STATUS_FILE"
  exit 2
fi

# Wait for SSH to come up (pod boot ~60s)
log "waiting for SSH (up to 5 min)"
for j in $(seq 1 20); do
  sleep 15
  if ssh $SSH_OPTS $SSH_HOST 'echo ready' 2>/dev/null | grep -q ready; then
    log "SSH ready on try $j"
    break
  fi
  log "  SSH not ready (try $j)"
done

# Verify GGUF exists on pod
if ! ssh $SSH_OPTS $SSH_HOST 'test -f /workspace/orchai/.orcai/ft-output/qwen7b-ft-v1-Q4_K_M.gguf && ls -lh /workspace/orchai/.orcai/ft-output/qwen7b-ft-v1-Q4_K_M.gguf' 2>&1 | tee -a "$LOG"; then
  log "ERROR: GGUF not found on pod!"
  echo "ERROR_GGUF_MISSING_AFTER_RECOVERY at=$(date +%FT%T)" > "$STATUS_FILE"
  exit 3
fi

# Download GGUF
log "downloading GGUF (~4.4 GB)"
scp $SCP_OPTS "$SSH_HOST:/workspace/orchai/.orcai/ft-output/qwen7b-ft-v1-Q4_K_M.gguf" "$OUT/" 2>&1 | tee -a "$LOG"

# Download adapter
log "downloading LoRA adapter"
ssh $SSH_OPTS $SSH_HOST 'tar czf /tmp/adapter.tgz -C /workspace/orchai/.orcai/ft-output qwen7b-lora-v1' 2>&1 | tee -a "$LOG"
scp $SCP_OPTS "$SSH_HOST:/tmp/adapter.tgz" "$OUT/qwen7b-lora-v1.tgz" 2>&1 | tee -a "$LOG"

# Download pipeline log
scp $SCP_OPTS "$SSH_HOST:/workspace/orchai/.orcai/ft-output/pipeline.log" "$OUT/" 2>&1 | tee -a "$LOG"

# Verify
if [ ! -f "$OUT/qwen7b-ft-v1-Q4_K_M.gguf" ]; then
  log "ERROR: local GGUF missing after scp"
  echo "ERROR_SCP_FAILED at=$(date +%FT%T)" > "$STATUS_FILE"
  exit 4
fi

BYTES=$(stat -c %s "$OUT/qwen7b-ft-v1-Q4_K_M.gguf" 2>/dev/null || wc -c < "$OUT/qwen7b-ft-v1-Q4_K_M.gguf")
SIZE=$(du -h "$OUT/qwen7b-ft-v1-Q4_K_M.gguf" | cut -f1)
log "GGUF local size: $SIZE ($BYTES bytes)"

if [ "$BYTES" -lt 3000000000 ]; then
  log "WARN: GGUF too small, not terminating pod"
  echo "WARN_GGUF_TOO_SMALL bytes=$BYTES at=$(date +%FT%T)" > "$STATUS_FILE"
  exit 5
fi

# Terminate pod
log "TERMINATING pod $POD_ID via API"
curl -sS -X DELETE -H "Authorization: Bearer $KEY" "https://rest.runpod.io/v1/pods/$POD_ID" 2>&1 | tee -a "$LOG"
echo >> "$LOG"

cat > "$STATUS_FILE" <<EOF
SUCCESS_AFTER_RECOVERY at=$(date +%FT%T)
GGUF=$OUT/qwen7b-ft-v1-Q4_K_M.gguf ($SIZE, $BYTES bytes)
adapter=$OUT/qwen7b-lora-v1.tgz
pod=terminated via RunPod API

Notes:
- Pipeline originally succeeded at ~17:16 UTC 2026-04-18 (pod time)
- scp failed initially due to option -p vs -P bug (fixed in scripts)
- Recovery polled pod start every 5 min until 4090 host freed
- Total cost ~= original $0.69 + ~2h exited (volume $0.007/h = ~\$0.01) = ~\$0.70

Next steps (user manual):
1. Copy GGUF to LM Studio models dir:
   cp .orcai/ft-output/qwen7b-ft-v1-Q4_K_M.gguf \\
      "\$USERPROFILE/.lmstudio/models/Qwen/Qwen2.5-Coder-7B-FT/"
2. LM Studio: rescan → load Qwen2.5-Coder-7B-FT
3. Re-bench vs pre-FT 89.5: node test/coding-quality-bench-rag.js
EOF

log "SUCCESS — recovery complete"
