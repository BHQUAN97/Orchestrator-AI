#!/bin/bash
# Overnight monitor for Round 5.5 FT pipeline.
# - Poll pipeline.done every 3min
# - Handle SSH port change via RunPod API
# - On success: download GGUF + adapter + log, TERMINATE pod
# - On fail: download log, STOP pod (keep volume for debug)
# - After download: auto-run bench + memory update
# - Write status file so user can check on wake

set -u
ROOT="/e/DEVELOP/ai-orchestrator"
cd "$ROOT"

POD_ID="gqczcmonbiodqy"
POD_HOST="157.157.221.29"
POD_PORT="24608"
SSH_KEY="$HOME/.ssh/id_ed25519"
API_KEY="$(cat $HOME/.runpod/api-key)"

STATUS_FILE="$ROOT/.orcai/overnight-status.md"
MONITOR_LOG="$ROOT/.orcai/overnight-monitor.log"
FT_OUT="$ROOT/.orcai/ft-output-v2"
mkdir -p "$FT_OUT"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$MONITOR_LOG"; }

write_status() {
  cat > "$STATUS_FILE" <<EOF
# Round 5.5 Overnight Status

Last update: $(date +%FT%T)
Monitor PID: $$
Pod: $POD_ID @ $POD_HOST:$POD_PORT

## Current state
$1

## Monitor log tail
\`\`\`
$(tail -20 "$MONITOR_LOG" 2>/dev/null)
\`\`\`
EOF
}

refresh_port() {
  # Query RunPod API for current SSH port (port changes on restart)
  local new_port
  new_port=$(curl -sS -H "Authorization: Bearer $API_KEY" \
    "https://rest.runpod.io/v1/pods/$POD_ID" 2>/dev/null | \
    python3 -c "import sys, json; d=json.loads(sys.stdin.read()); print(d.get('portMappings',{}).get('22',''))" 2>/dev/null)
  if [ -n "$new_port" ] && [ "$new_port" != "$POD_PORT" ]; then
    log "port changed: $POD_PORT -> $new_port"
    POD_PORT="$new_port"
  fi
}

ssh_cmd() {
  local opts="-i $SSH_KEY -p $POD_PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=30"
  ssh $opts "root@$POD_HOST" "$@" 2>&1
}

scp_cmd() {
  local opts="-i $SSH_KEY -P $POD_PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 -o ServerAliveInterval=30"
  scp $opts "$@" 2>&1
}

ssh_test() {
  ssh_cmd "echo OK" 2>&1 | grep -q "^OK"
}

log "=== Overnight monitor start (PID $$) ==="
log "pod=$POD_ID host=$POD_HOST port=$POD_PORT"
write_status "🟡 STARTING — monitor launched"

# Poll loop — max 5 hours (100 * 3min)
for i in $(seq 1 100); do
  # Refresh port if SSH fails
  if ! ssh_test; then
    log "ssh fail on attempt $i — refreshing port via API"
    refresh_port
    if ! ssh_test; then
      log "ssh still fail after port refresh — sleep 60 then continue"
      write_status "🟠 SSH temporarily failing (attempt $i/100) — retrying"
      sleep 60
      continue
    fi
    log "ssh recovered with port $POD_PORT"
  fi

  STATE=$(ssh_cmd 'cat /workspace/orchai/.orcai/ft-output/pipeline.done 2>/dev/null || echo RUNNING' | tail -1 | tr -d '\r')
  LOG_TAIL=$(ssh_cmd 'tail -3 /workspace/orchai/.orcai/ft-output/pipeline.log 2>/dev/null | tr -d "\r"')

  case "$STATE" in
    PIPELINE_OK)
      log "✅ PIPELINE_OK detected — downloading artifacts"
      write_status "🟢 DOWNLOADING — pipeline succeeded, downloading GGUF"

      # Download GGUF
      scp_cmd "root@$POD_HOST:/workspace/orchai/.orcai/ft-output/qwen7b-ft-v2-Q4_K_M.gguf" "$FT_OUT/" || { log "scp gguf FAILED"; write_status "❌ Download GGUF failed"; exit 1; }

      # Download adapter tgz
      ssh_cmd 'cd /workspace/orchai/.orcai/ft-output && tar czf /tmp/adapter-v2.tgz qwen7b-lora-v2/ 2>/dev/null' >/dev/null
      scp_cmd "root@$POD_HOST:/tmp/adapter-v2.tgz" "$FT_OUT/" || log "adapter tgz scp warn"

      # Download pipeline log
      scp_cmd "root@$POD_HOST:/workspace/orchai/.orcai/ft-output/pipeline.log" "$FT_OUT/pipeline-v2.log" || log "log scp warn"

      # Verify integrity
      LOCAL_SIZE=$(stat -c %s "$FT_OUT/qwen7b-ft-v2-Q4_K_M.gguf" 2>/dev/null || echo 0)
      REMOTE_SIZE=$(ssh_cmd 'stat -c %s /workspace/orchai/.orcai/ft-output/qwen7b-ft-v2-Q4_K_M.gguf' | tr -d '\r')
      log "local=$LOCAL_SIZE remote=$REMOTE_SIZE"

      if [ "$LOCAL_SIZE" = "$REMOTE_SIZE" ] && [ "$LOCAL_SIZE" -gt 1000000000 ]; then
        log "✅ integrity OK ($LOCAL_SIZE bytes) — TERMINATE pod"
        curl -sS -X DELETE -H "Authorization: Bearer $API_KEY" "https://rest.runpod.io/v1/pods/$POD_ID"
        log "pod terminated"
        write_status "🟢 DOWNLOAD OK — pod TERMINATED. Running bench + memory update next."

        # Trigger bench + memory update
        bash "$ROOT/scripts/overnight-postprocess.sh" >> "$MONITOR_LOG" 2>&1
        exit 0
      else
        log "❌ integrity MISMATCH — STOP pod (keep volume)"
        curl -sS -X POST -H "Authorization: Bearer $API_KEY" "https://rest.runpod.io/v1/pods/$POD_ID/stop"
        write_status "❌ Integrity mismatch local=$LOCAL_SIZE remote=$REMOTE_SIZE — pod STOPPED (volume kept)"
        exit 1
      fi
      ;;

    PIPELINE_FAILED_*)
      log "❌ PIPELINE FAILED: $STATE"
      scp_cmd "root@$POD_HOST:/workspace/orchai/.orcai/ft-output/pipeline.log" "$FT_OUT/pipeline-v2-failed.log" || log "log scp warn"
      curl -sS -X POST -H "Authorization: Bearer $API_KEY" "https://rest.runpod.io/v1/pods/$POD_ID/stop"
      log "pod stopped (volume kept for debug)"
      write_status "❌ PIPELINE FAILED: $STATE — pod STOPPED, log downloaded to ft-output-v2/"
      exit 1
      ;;

    *)
      # Get training progress indicator
      STEP_INFO=$(ssh_cmd 'grep -oE "[0-9]+/[0-9]+.*it/s" /workspace/orchai/.orcai/ft-output/pipeline.log 2>/dev/null | tail -1 | tr -d "\r"' | head -c 100)
      STAGE=""
      ssh_cmd 'test -f /workspace/orchai/.orcai/ft-output/stage.train.done' >/dev/null 2>&1 && STAGE="$STAGE train✓"
      ssh_cmd 'test -f /workspace/orchai/.orcai/ft-output/stage.merge.done' >/dev/null 2>&1 && STAGE="$STAGE merge✓"
      ssh_cmd 'test -f /workspace/orchai/.orcai/ft-output/stage.convert.done' >/dev/null 2>&1 && STAGE="$STAGE convert✓"
      log "poll $i/100 — RUNNING${STAGE:+ [$STAGE]} step=$STEP_INFO"
      write_status "🟡 RUNNING (poll $i/100)${STAGE:+ stages:$STAGE} progress: $STEP_INFO"
      sleep 180
      ;;
  esac
done

log "⏰ TIMEOUT after 5h — force stop pod"
curl -sS -X POST -H "Authorization: Bearer $API_KEY" "https://rest.runpod.io/v1/pods/$POD_ID/stop"
write_status "⏰ TIMEOUT after 5h — pod STOPPED. Check ft-output-v2/ and log."
exit 2
