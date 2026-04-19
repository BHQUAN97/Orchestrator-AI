#!/bin/bash
# Local monitor for overnight Qwen 7B FT pipeline.
# Polls pod every 3 min for completion markers, then:
#   1. Downloads GGUF + adapter to local
#   2. Issues SSH shutdown to stop pod (kills GPU billing)
#   3. Writes status file for next Claude session to pick up
#
# Runs in background on the local (Windows git-bash) machine.
# Log:  .orcai/ft-output/monitor.log
# Final status: .orcai/ft-output/pipeline-final-status.txt

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SSH_KEY="/c/Users/buiho/.ssh/id_ed25519"
SSH_HOST="root@103.196.86.82"
SSH_PORT="19396"
SSH_OPTS="-i $SSH_KEY -p $SSH_PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=30"
# scp uses uppercase -P for port (not -p). Separate options var for scp.
SCP_OPTS="-i $SSH_KEY -P $SSH_PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=30"

POD_ID="f1brfsfulyw1kw"
RUNPOD_KEY_FILE="$HOME/.runpod/api-key"

terminate_pod() {
  if [ -f "$RUNPOD_KEY_FILE" ]; then
    local key
    key=$(cat "$RUNPOD_KEY_FILE")
    log "calling RunPod API to TERMINATE pod $POD_ID (deletes volume — $0 ongoing charge)"
    curl -sS -X DELETE -H "Authorization: Bearer $key" \
      "https://rest.runpod.io/v1/pods/$POD_ID" 2>&1 | tee -a "$LOG" || true
    echo >> "$LOG"
  else
    log "no RunPod API key at $RUNPOD_KEY_FILE — falling back to SSH shutdown (pod stays in Stopped state, $0.40/day volume)"
    ssh $SSH_OPTS $SSH_HOST 'shutdown -h +1 "auto" 2>/dev/null || poweroff' >/dev/null 2>&1 || true
  fi
}

stop_pod() {
  if [ -f "$RUNPOD_KEY_FILE" ]; then
    local key
    key=$(cat "$RUNPOD_KEY_FILE")
    log "calling RunPod API to STOP pod $POD_ID (keeps volume for debug)"
    curl -sS -X POST -H "Authorization: Bearer $key" \
      "https://rest.runpod.io/v1/pods/$POD_ID/stop" 2>&1 | tee -a "$LOG" || true
    echo >> "$LOG"
  else
    ssh $SSH_OPTS $SSH_HOST 'shutdown -h +1 "auto" 2>/dev/null || poweroff' >/dev/null 2>&1 || true
  fi
}

OUT="$ROOT/.orcai/ft-output"
LOG="$OUT/monitor.log"
STATUS_FILE="$OUT/pipeline-final-status.txt"

mkdir -p "$OUT"

log() { echo "[$(date +%FT%T)] $*" | tee -a "$LOG"; }

log "monitor started, polling pod every 180s"

# Poll up to 4 hours (240 minutes / 80 iterations of 3 min)
for i in $(seq 1 80); do
  STATE=$(ssh $SSH_OPTS $SSH_HOST 'cat /workspace/orchai/.orcai/ft-output/pipeline.done 2>/dev/null || echo RUNNING' 2>&1)
  PROG=$(ssh $SSH_OPTS $SSH_HOST 'tail -1 /workspace/orchai/.orcai/ft-output/pipeline.log 2>/dev/null | tr -d "\r" | tail -c 200' 2>&1)
  log "iter=$i state=$STATE progress=${PROG:0:120}"

  case "$STATE" in
    PIPELINE_OK)
      log "pipeline SUCCESS — downloading artifacts"
      break
      ;;
    PIPELINE_FAILED_*)
      log "pipeline FAILED — downloading log only"
      scp $SCP_OPTS "$SSH_HOST:/workspace/orchai/.orcai/ft-output/pipeline.log" "$OUT/pipeline.log" 2>&1 | tee -a "$LOG"
      echo "FAILED state=$STATE at=$(date +%FT%T)" > "$STATUS_FILE"
      log "stopping pod (keep volume for debug; user can inspect + terminate manually)"
      stop_pod
      exit 1
      ;;
    *)
      sleep 180
      ;;
  esac
done

if [ "$STATE" != "PIPELINE_OK" ]; then
  log "TIMEOUT after 4h, state=$STATE. Leaving pod running for manual intervention."
  echo "TIMEOUT state=$STATE at=$(date +%FT%T)" > "$STATUS_FILE"
  exit 2
fi

# Download artifacts
log "downloading GGUF Q4_K_M..."
scp $SCP_OPTS "$SSH_HOST:/workspace/orchai/.orcai/ft-output/qwen7b-ft-v1-Q4_K_M.gguf" "$OUT/" 2>&1 | tee -a "$LOG"

log "downloading LoRA adapter..."
ssh $SSH_OPTS $SSH_HOST 'tar czf /tmp/adapter.tgz -C /workspace/orchai/.orcai/ft-output qwen7b-lora-v1' 2>&1 | tee -a "$LOG"
scp $SCP_OPTS "$SSH_HOST:/tmp/adapter.tgz" "$OUT/qwen7b-lora-v1.tgz" 2>&1 | tee -a "$LOG"

log "downloading training logs..."
scp $SCP_OPTS "$SSH_HOST:/workspace/orchai/.orcai/ft-output/pipeline.log" "$OUT/" 2>&1 | tee -a "$LOG"

# Verify GGUF
if [ -f "$OUT/qwen7b-ft-v1-Q4_K_M.gguf" ]; then
  SIZE=$(du -h "$OUT/qwen7b-ft-v1-Q4_K_M.gguf" | cut -f1)
  BYTES=$(stat -c %s "$OUT/qwen7b-ft-v1-Q4_K_M.gguf" 2>/dev/null || wc -c < "$OUT/qwen7b-ft-v1-Q4_K_M.gguf")
  log "GGUF downloaded OK: $SIZE ($BYTES bytes)"

  # Sanity: a valid Q4_K_M GGUF for Qwen 7B is ~4.4 GB = ~4400 MB. Require >= 3 GB.
  if [ "$BYTES" -lt 3000000000 ]; then
    log "WARN: GGUF suspiciously small ($BYTES bytes). Falling back to STOP (keep volume for debug)."
    stop_pod
    echo "WARN_GGUF_TOO_SMALL bytes=$BYTES at=$(date +%FT%T)" > "$STATUS_FILE"
    exit 4
  fi

  log "GGUF sanity OK. Terminating pod (free volume)."
  terminate_pod

  cat > "$STATUS_FILE" <<EOF
SUCCESS at=$(date +%FT%T)
GGUF=$OUT/qwen7b-ft-v1-Q4_K_M.gguf ($SIZE, $BYTES bytes)
adapter=$OUT/qwen7b-lora-v1.tgz
pod=terminated via RunPod API (volume deleted, $0 ongoing charge)

Next steps (user manual):
1. Copy GGUF to LM Studio:
   cp .orcai/ft-output/qwen7b-ft-v1-Q4_K_M.gguf \\
      "\$USERPROFILE/.lmstudio/models/Qwen/Qwen2.5-Coder-7B-FT/"
2. LM Studio: rescan → load Qwen2.5-Coder-7B-FT
3. Re-bench: node test/coding-quality-bench-rag.js
EOF

  log "SUCCESS — monitor exiting"
else
  log "ERROR: GGUF missing after download"
  echo "ERROR_MISSING_GGUF at=$(date +%FT%T)" > "$STATUS_FILE"
  stop_pod
  exit 3
fi
