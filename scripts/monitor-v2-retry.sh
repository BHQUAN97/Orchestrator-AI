#!/bin/bash
# Monitor retry pod (4090) — FIXED bugs from overnight-monitor:
# - Correct POD_ID
# - Timeout 3h (was 5h but hit at 92% — now 3h since only 86 steps + merge + convert ~1h expected)
#   Actually use 4h to be safe
# - Only STOP on fail, TERMINATE on success
# - Handle port change via API on SSH fail

set -u
ROOT="/e/DEVELOP/ai-orchestrator"
cd "$ROOT"

POD_ID="csgp52btkz8q7k"
POD_HOST="213.173.110.137"
POD_PORT="10249"
SSH_KEY="$HOME/.ssh/id_ed25519"
API_KEY="$(cat $HOME/.runpod/api-key)"

STATUS_FILE="$ROOT/.orcai/retry-monitor-status.md"
MONITOR_LOG="$ROOT/.orcai/retry-monitor.log"
FT_OUT="$ROOT/.orcai/ft-output-v2"
mkdir -p "$FT_OUT"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$MONITOR_LOG"; }

write_status() {
  cat > "$STATUS_FILE" <<EOF
# Retry Monitor — $(date +%FT%T)
Pod: $POD_ID @ $POD_HOST:$POD_PORT
State: $1

Last 10 log lines:
\`\`\`
$(tail -10 "$MONITOR_LOG" 2>/dev/null)
\`\`\`
EOF
}

refresh_port() {
  local new_port
  new_port=$(curl -sS -H "Authorization: Bearer $API_KEY" \
    "https://rest.runpod.io/v1/pods/$POD_ID" 2>/dev/null | \
    sed -n 's/.*"portMappings":{"22":\([0-9]*\).*/\1/p')
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

log "=== Retry monitor start (PID $$) ==="
log "pod=$POD_ID host=$POD_HOST port=$POD_PORT"
write_status "STARTING"

# 4h timeout = 80 polls × 3min
for i in $(seq 1 80); do
  if ! ssh_test; then
    log "ssh fail $i — refreshing port"
    refresh_port
    if ! ssh_test; then
      log "ssh still fail after refresh"
      write_status "⚠️ SSH temp fail poll $i/80"
      sleep 60
      continue
    fi
    log "ssh recovered"
  fi

  STATE=$(ssh_cmd 'cat /workspace/orchai/.orcai/ft-output/pipeline.done 2>/dev/null || echo RUNNING' | tail -1 | tr -d '\r')

  case "$STATE" in
    PIPELINE_OK)
      log "✅ PIPELINE_OK — downloading artifacts"
      write_status "🟢 DOWNLOADING"

      scp_cmd "root@$POD_HOST:/workspace/orchai/.orcai/ft-output/qwen7b-ft-v2-Q4_K_M.gguf" "$FT_OUT/" || { log "scp gguf FAIL"; write_status "❌ download fail"; exit 1; }

      ssh_cmd 'cd /workspace/orchai/.orcai/ft-output && tar czf /tmp/adapter-v2-final.tgz qwen7b-lora-v2/' >/dev/null
      scp_cmd "root@$POD_HOST:/tmp/adapter-v2-final.tgz" "$FT_OUT/" || log "adapter warn"
      scp_cmd "root@$POD_HOST:/workspace/orchai/.orcai/ft-output/pipeline.log" "$FT_OUT/pipeline-v2-final.log" || log "log warn"

      LOCAL_SIZE=$(stat -c %s "$FT_OUT/qwen7b-ft-v2-Q4_K_M.gguf" 2>/dev/null || echo 0)
      REMOTE_SIZE=$(ssh_cmd 'stat -c %s /workspace/orchai/.orcai/ft-output/qwen7b-ft-v2-Q4_K_M.gguf' | tr -d '\r')
      log "local=$LOCAL_SIZE remote=$REMOTE_SIZE"

      if [ "$LOCAL_SIZE" = "$REMOTE_SIZE" ] && [ "$LOCAL_SIZE" -gt 1000000000 ]; then
        log "✅ integrity OK — TERMINATE pod"
        curl -sS -X DELETE -H "Authorization: Bearer $API_KEY" "https://rest.runpod.io/v1/pods/$POD_ID" >/dev/null
        log "pod terminated"
        write_status "🟢 DONE — pod terminated, running bench+finalize"
        bash "$ROOT/scripts/overnight-postprocess.sh" >> "$MONITOR_LOG" 2>&1
        exit 0
      else
        log "❌ MISMATCH — STOP pod"
        curl -sS -X POST -H "Authorization: Bearer $API_KEY" "https://rest.runpod.io/v1/pods/$POD_ID/stop" >/dev/null
        write_status "❌ integrity mismatch"
        exit 1
      fi
      ;;

    PIPELINE_FAILED_*)
      log "❌ PIPELINE FAILED: $STATE"
      scp_cmd "root@$POD_HOST:/workspace/orchai/.orcai/ft-output/pipeline.log" "$FT_OUT/pipeline-v2-failed-retry.log" || log "log warn"
      curl -sS -X POST -H "Authorization: Bearer $API_KEY" "https://rest.runpod.io/v1/pods/$POD_ID/stop" >/dev/null
      write_status "❌ FAILED: $STATE"
      exit 1
      ;;

    *)
      STEP_INFO=$(ssh_cmd 'tail -c 3000 /workspace/orchai/.orcai/ft-output/pipeline.log 2>/dev/null | tr "\r" "\n" | grep -oE "[0-9]+/786 \[[^]]+\]" | tail -1' | tr -d '\r' | head -c 80)
      STAGE=""
      ssh_cmd 'test -f /workspace/orchai/.orcai/ft-output/stage.train.done' >/dev/null 2>&1 && STAGE="$STAGE train✓"
      ssh_cmd 'test -f /workspace/orchai/.orcai/ft-output/stage.merge.done' >/dev/null 2>&1 && STAGE="$STAGE merge✓"
      ssh_cmd 'test -f /workspace/orchai/.orcai/ft-output/stage.convert.done' >/dev/null 2>&1 && STAGE="$STAGE convert✓"
      log "poll $i/80 — RUNNING${STAGE:+ [$STAGE]} step=$STEP_INFO"
      write_status "🟡 poll $i/80${STAGE:+ stages:$STAGE} $STEP_INFO"
      sleep 180
    ;;
  esac
done

log "⏰ TIMEOUT 4h — force stop"
curl -sS -X POST -H "Authorization: Bearer $API_KEY" "https://rest.runpod.io/v1/pods/$POD_ID/stop" >/dev/null
write_status "⏰ TIMEOUT 4h"
exit 2
