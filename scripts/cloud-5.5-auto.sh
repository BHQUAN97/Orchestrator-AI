#!/bin/bash
# Round 5.5 full automation. Runs entirely in background.
# Waits for SSH → upload → install deps → launch pipeline → poll → download → terminate pod.

set -u

POD_ID="jdm2xewb8eb1ev"
KEY_FILE="$HOME/.runpod/api-key"
KEY=$(cat "$KEY_FILE")
SSH_KEY="/c/Users/buiho/.ssh/id_ed25519"
REMOTE_ROOT="/workspace/orchai"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT="$ROOT/.orcai/ft-output-v2"
LOG="$OUT/auto.log"
STATUS_FILE="$OUT/pipeline-final-status.txt"
mkdir -p "$OUT"

log() { echo "[$(date +%FT%T)] $*" | tee -a "$LOG"; }

fetch_pod_info() {
  local detail ip port
  detail=$(curl -sS -H "Authorization: Bearer $KEY" "https://rest.runpod.io/v1/pods/$POD_ID")
  ip=$(echo "$detail" | grep -oE '"publicIp":"[^"]*"' | head -1 | sed 's/.*":"\(.*\)"/\1/')
  port=$(echo "$detail" | grep -oE '"portMappings":\{[^}]*\}' | grep -oE '"22":[0-9]+' | grep -oE '[0-9]+$')
  echo "$ip $port"
}

terminate_pod() {
  log "TERMINATE pod $POD_ID"
  curl -sS -X DELETE -H "Authorization: Bearer $KEY" "https://rest.runpod.io/v1/pods/$POD_ID" | tee -a "$LOG"
  echo >> "$LOG"
}

stop_pod() {
  log "STOP pod $POD_ID (keep volume)"
  curl -sS -X POST -H "Authorization: Bearer $KEY" "https://rest.runpod.io/v1/pods/$POD_ID/stop" | tee -a "$LOG"
  echo >> "$LOG"
}

# ==== Step 1: Wait for SSH ====
log "Step 1/7: waiting for SSH on pod $POD_ID"
POD_IP=""
POD_PORT=""
for i in $(seq 1 30); do
  read -r IP PORT <<< "$(fetch_pod_info)"
  if [ -n "$IP" ] && [ -n "$PORT" ]; then
    if ssh -i "$SSH_KEY" -p "$PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "root@$IP" "echo OK" 2>/dev/null | grep -q OK; then
      POD_IP="$IP"
      POD_PORT="$PORT"
      log "  SSH ready on $POD_IP:$POD_PORT (try $i)"
      break
    fi
  fi
  log "  [$i] status=pending ip=$IP port=$PORT — retry 20s"
  sleep 20
done

if [ -z "$POD_IP" ]; then
  log "TIMEOUT waiting for SSH after 10 min"
  echo "TIMEOUT_SSH at=$(date +%FT%T)" > "$STATUS_FILE"
  stop_pod
  exit 1
fi

SSH_OPTS="-i $SSH_KEY -p $POD_PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=30"
SCP_OPTS="-i $SSH_KEY -P $POD_PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=30"
SSH="ssh $SSH_OPTS root@$POD_IP"

# ==== Step 2: Create remote dirs ====
log "Step 2/7: creating remote dirs"
$SSH "mkdir -p $REMOTE_ROOT/.orcai/training $REMOTE_ROOT/scripts $REMOTE_ROOT/.orcai/ft-output"

# ==== Step 3: Upload training data + scripts ====
log "Step 3/7: uploading data + scripts"
scp $SCP_OPTS \
  .orcai/training/style.jsonl \
  .orcai/training/classifier.jsonl \
  .orcai/training/distill.jsonl \
  .orcai/training/distill-v2-merged.jsonl \
  "root@$POD_IP:$REMOTE_ROOT/.orcai/training/" 2>&1 | tail -5 | tee -a "$LOG"

scp $SCP_OPTS \
  scripts/train-lora-qwen7b-v2.py \
  scripts/merge-lora-7b-v2.py \
  scripts/convert-to-gguf.sh \
  scripts/pod-run-pipeline-v2.sh \
  "root@$POD_IP:$REMOTE_ROOT/scripts/" 2>&1 | tail -5 | tee -a "$LOG"

# ==== Step 4: Install deps (pinned versions!) ====
log "Step 4/7: installing deps (pinned)"
$SSH "pip install --quiet --no-cache-dir \
  transformers==4.46.3 \
  peft==0.13.2 \
  trl==0.11.4 \
  bitsandbytes==0.49.2 \
  datasets==3.0.2 \
  accelerate==1.13.0 \
  liger-kernel==0.3.0 \
  sentencepiece \
  protobuf 2>&1 | tail -3" | tee -a "$LOG"

$SSH 'python3 -c "
import torch, transformers, peft, trl, bitsandbytes as bnb
from trl import SFTTrainer
print(\"torch\", torch.__version__, \"cuda\", torch.cuda.is_available())
print(\"GPU:\", torch.cuda.get_device_name(0) if torch.cuda.is_available() else \"none\")
print(\"VRAM\", round(torch.cuda.get_device_properties(0).total_memory/1e9,1),\"GB\")
print(\"SFTTrainer import OK\")
"' 2>&1 | tee -a "$LOG"

# ==== Step 5: Launch pipeline detached ====
log "Step 5/7: launching pipeline detached"
$SSH "cd $REMOTE_ROOT && chmod +x scripts/pod-run-pipeline-v2.sh scripts/convert-to-gguf.sh && \
  rm -f .orcai/ft-output/pipeline.log .orcai/ft-output/pipeline.pid .orcai/ft-output/pipeline.done .orcai/ft-output/stage.*.done && \
  setsid nohup bash scripts/pod-run-pipeline-v2.sh </dev/null >/dev/null 2>&1 & disown; \
  sleep 4 && cat .orcai/ft-output/pipeline.pid 2>/dev/null && echo LAUNCHED"

# ==== Step 6: Poll for completion ====
log "Step 6/7: polling for pipeline.done every 3 min"
for iter in $(seq 1 80); do   # 4h max
  # Re-fetch port in case pod restarted
  read -r CUR_IP CUR_PORT <<< "$(fetch_pod_info)"
  if [ "$CUR_PORT" != "$POD_PORT" ] && [ -n "$CUR_PORT" ]; then
    log "  port changed $POD_PORT → $CUR_PORT"
    POD_PORT="$CUR_PORT"
    SSH_OPTS="-i $SSH_KEY -p $POD_PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=30"
    SCP_OPTS="-i $SSH_KEY -P $POD_PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=30"
    SSH="ssh $SSH_OPTS root@$POD_IP"
  fi

  STATE=$($SSH "cat $REMOTE_ROOT/.orcai/ft-output/pipeline.done 2>/dev/null || echo RUNNING" 2>&1)
  PROG=$($SSH "tail -1 $REMOTE_ROOT/.orcai/ft-output/pipeline.log 2>/dev/null | tr -d '\\r' | tail -c 200" 2>&1)
  log "  iter=$iter state=$STATE prog=${PROG:0:100}"

  case "$STATE" in
    PIPELINE_OK)
      log "  SUCCESS — proceeding to download"
      break
      ;;
    PIPELINE_FAILED_*)
      log "  FAILED — downloading log only"
      scp $SCP_OPTS "root@$POD_IP:$REMOTE_ROOT/.orcai/ft-output/pipeline.log" "$OUT/" 2>&1 | tee -a "$LOG"
      echo "FAILED state=$STATE at=$(date +%FT%T)" > "$STATUS_FILE"
      stop_pod
      exit 1
      ;;
    *)
      sleep 180
      ;;
  esac
done

if [ "$STATE" != "PIPELINE_OK" ]; then
  log "TIMEOUT 4h"
  echo "TIMEOUT at=$(date +%FT%T)" > "$STATUS_FILE"
  exit 2
fi

# ==== Step 7: Download + verify + terminate ====
log "Step 7/7: download artifacts"
scp $SCP_OPTS "root@$POD_IP:$REMOTE_ROOT/.orcai/ft-output/qwen7b-ft-v2-Q4_K_M.gguf" "$OUT/" 2>&1 | tail -3 | tee -a "$LOG"

# Package adapter
$SSH "tar czf /tmp/adapter-v2.tgz -C $REMOTE_ROOT/.orcai/ft-output qwen7b-lora-v2" 2>&1 | tee -a "$LOG"
scp $SCP_OPTS "root@$POD_IP:/tmp/adapter-v2.tgz" "$OUT/qwen7b-lora-v2.tgz" 2>&1 | tail -3 | tee -a "$LOG"

# Download log
scp $SCP_OPTS "root@$POD_IP:$REMOTE_ROOT/.orcai/ft-output/pipeline.log" "$OUT/" 2>&1 | tail -3 | tee -a "$LOG"

# Verify integrity
if [ -f "$OUT/qwen7b-ft-v2-Q4_K_M.gguf" ]; then
  LOCAL=$(stat -c %s "$OUT/qwen7b-ft-v2-Q4_K_M.gguf")
  REMOTE=$($SSH "stat -c %s $REMOTE_ROOT/.orcai/ft-output/qwen7b-ft-v2-Q4_K_M.gguf" 2>&1)
  SIZE=$(du -h "$OUT/qwen7b-ft-v2-Q4_K_M.gguf" | cut -f1)

  if [ "$LOCAL" = "$REMOTE" ] && [ "$LOCAL" -gt 3000000000 ]; then
    log "integrity OK ($SIZE, $LOCAL bytes) — TERMINATING pod"
    terminate_pod
    cat > "$STATUS_FILE" <<EOF
SUCCESS at=$(date +%FT%T)
Round: 5.5
Data: v1 (1145) + v2 (952) = 2097 pairs
GGUF: $OUT/qwen7b-ft-v2-Q4_K_M.gguf ($SIZE, $LOCAL bytes)
adapter: $OUT/qwen7b-lora-v2.tgz
pod: terminated via RunPod API
cost_estimate: ~\$0.26/h × runtime

Next (user manual):
1. Copy to LM Studio:
   cp $OUT/qwen7b-ft-v2-Q4_K_M.gguf "\$USERPROFILE/.lmstudio/models/orcai/Qwen2.5-Coder-7B-FT-v2-GGUF/"
2. LM Studio rescan + load
3. Bench compare vs FT v1 (89.0) + baseline (89.5)
EOF
    log "ALL DONE"
  else
    log "INTEGRITY MISMATCH — STOP (keep volume)"
    stop_pod
    echo "INTEGRITY_FAIL local=$LOCAL remote=$REMOTE at=$(date +%FT%T)" > "$STATUS_FILE"
    exit 3
  fi
else
  log "ERROR: GGUF missing"
  stop_pod
  echo "ERROR_GGUF_MISSING at=$(date +%FT%T)" > "$STATUS_FILE"
  exit 4
fi
