#!/bin/bash
# When pod becomes RUNNING (likely on CPU): SSH in, verify + tar + download checkpoint.

set -u
POD_ID="gqczcmonbiodqy"
SSH_KEY="$HOME/.ssh/id_ed25519"
KEY=$(cat ~/.runpod/api-key)
ROOT="/e/DEVELOP/ai-orchestrator"
BACKUP_DIR="$ROOT/.orcai/ft-output-v2"
LOG="$ROOT/.orcai/extract-checkpoint.log"
STATUS="$ROOT/.orcai/retry-start-status.md"

mkdir -p "$BACKUP_DIR"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

log "=== extract-checkpoint start ==="

# Wait for pod RUNNING + port
for i in $(seq 1 30); do
  STATE=$(curl -sS -H "Authorization: Bearer $KEY" "https://rest.runpod.io/v1/pods/$POD_ID")
  STATUS_NOW=$(echo "$STATE" | grep -oE '"desiredStatus":"[^"]+"' | head -1)
  IP=$(echo "$STATE" | grep -oE '"publicIp":"[^"]*"' | head -1 | grep -oE '[0-9.]+')
  PORT=$(echo "$STATE" | grep -oE '"portMappings":\{[^}]*\}' | grep -oE '"22":[0-9]+' | grep -oE '[0-9]+')
  log "poll $i — $STATUS_NOW ip=$IP port=$PORT"

  if echo "$STATUS_NOW" | grep -q RUNNING && [ -n "$IP" ] && [ -n "$PORT" ]; then
    log "✅ pod RUNNING"
    break
  fi
  sleep 20
done

if [ -z "$IP" ] || [ -z "$PORT" ]; then
  log "❌ pod not RUNNING after 10min"
  exit 1
fi

SSH_OPTS="-i $SSH_KEY -p $PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"
SCP_OPTS="-i $SSH_KEY -P $PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30"

# Wait SSH
for j in $(seq 1 20); do
  if ssh $SSH_OPTS root@$IP 'echo OK' 2>/dev/null | grep -q OK; then
    log "✅ SSH ready"
    break
  fi
  sleep 15
  log "ssh wait $j/20..."
done

# Verify checkpoint
CKPT_LIST=$(ssh $SSH_OPTS root@$IP 'ls /workspace/orchai/.orcai/ft-output/qwen7b-lora-v2/ 2>/dev/null | grep checkpoint- | sort -V' | tr '\n' ' ')
log "checkpoints: $CKPT_LIST"

if [ -z "$CKPT_LIST" ]; then
  log "❌ NO CHECKPOINTS FOUND"
  cat > "$STATUS" <<EOF
# CPU pod status — $(date +%FT%T)
❌ NO CHECKPOINTS on volume — training may have been interrupted before first save (step 50)
Need to start training from scratch on new pod.
EOF
  exit 1
fi

LATEST=$(echo "$CKPT_LIST" | tr ' ' '\n' | grep -v '^$' | tail -1)
log "latest: $LATEST"

# Size check
CKPT_SIZE=$(ssh $SSH_OPTS root@$IP "du -sh /workspace/orchai/.orcai/ft-output/qwen7b-lora-v2/$LATEST 2>/dev/null | cut -f1")
log "$LATEST size: $CKPT_SIZE"

# Tar checkpoint dir on remote (save ALL checkpoints in output dir)
log "creating tar on pod..."
ssh $SSH_OPTS root@$IP 'cd /workspace/orchai/.orcai/ft-output && tar czf /tmp/lora-v2-checkpoints.tgz qwen7b-lora-v2/' || { log "❌ tar failed"; exit 1; }
TAR_SIZE=$(ssh $SSH_OPTS root@$IP 'du -h /tmp/lora-v2-checkpoints.tgz | cut -f1')
log "tar size: $TAR_SIZE"

# Download
log "downloading to local..."
scp $SCP_OPTS "root@$IP:/tmp/lora-v2-checkpoints.tgz" "$BACKUP_DIR/" || { log "❌ scp failed"; exit 1; }
LOCAL_SIZE=$(du -h "$BACKUP_DIR/lora-v2-checkpoints.tgz" | cut -f1)
log "✅ downloaded: $LOCAL_SIZE"

cat > "$STATUS" <<EOF
# CPU pod status — $(date +%FT%T)
✅ CHECKPOINT EXTRACTED & DOWNLOADED
- Remote checkpoints: $CKPT_LIST
- Latest: $LATEST
- Local file: $BACKUP_DIR/lora-v2-checkpoints.tgz ($LOCAL_SIZE)

## Next steps
1. Terminate CPU pod (optional, ~\$0.04/h)
2. Deploy new GPU pod (try 4090 or L40S if 4000 Ada unavailable)
3. Upload checkpoint.tgz → resume training
EOF

log "=== DONE ==="
