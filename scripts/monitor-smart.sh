#!/bin/bash
# monitor-smart.sh — Round 6+ smart monitor. Fixes TWO fatal bugs from v2:
#   1) Hardcoded 5h timeout (killed training at 92%)  → DYNAMIC timeout from observed step rate.
#   2) Auto-STOP on PIPELINE_FAILED_* (prevented recovery) → NEVER auto-stop on failure.
#
# Contract:
#   exit 0 = PIPELINE_OK + integrity OK → pod TERMINATED
#   exit 1 = pipeline failed            → pod KEPT RUNNING for user debug/retry
#   exit 2 = timeout                    → pod KEPT RUNNING (extend or user decides)
#   exit 3 = integrity mismatch         → pod STOPPED (volume preserved)
#
# Usage: monitor-smart.sh <POD_ID> [GGUF_NAME] <TOTAL_STEPS>

set -u

POD_ID="${1:?POD_ID required}"
GGUF_NAME="${2:-qwen7b-ft-v2-Q4_K_M.gguf}"
TOTAL_STEPS="${3:?TOTAL_STEPS required for ETA calc}"

ROOT="/e/DEVELOP/ai-orchestrator"
cd "$ROOT"

SSH_KEY="$HOME/.ssh/id_ed25519"
API_KEY="$(cat "$HOME/.runpod/api-key")"
API_BASE="https://rest.runpod.io/v1"

REMOTE_OUT="/workspace/orchai/.orcai/ft-output"
FT_OUT="$ROOT/.orcai/ft-output-v2"
STATUS_FILE="$ROOT/.orcai/monitor-status.md"
MON_LOG="$ROOT/.orcai/monitor.log"
POD_INFO="$ROOT/.orcai/pod-info.txt"
mkdir -p "$FT_OUT" "$ROOT/.orcai"

POD_HOST=""
POD_PORT=""
SSH_FAILS=0
POLL_INTERVAL=180          # 3 min
BUFFER_MERGE_CONVERT=1800  # 30 min buffer after training
SAFETY_MULTIPLIER=2        # dynamic timeout = 2× estimate
STARTED_AT=$(date +%s)
CUR_STEP=0
STEP_RATE=0                # sec/step, computed from tqdm
EST_TOTAL_SEC=0            # estimated total pipeline duration
DEADLINE=0                 # epoch seconds; 0 until estimated

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$MON_LOG"; }

refresh_pod_info() {
  local json port host
  json=$(curl -sS -H "Authorization: Bearer $API_KEY" "$API_BASE/pods/$POD_ID" 2>/dev/null || echo "")
  if [ -z "$json" ]; then return 1; fi
  # Port via documented sed pattern
  port=$(echo "$json" | sed -n 's/.*"portMappings":{"22":\([0-9]*\).*/\1/p' | head -1)
  # publicIp
  host=$(echo "$json" | python3 -c "import sys,json;d=json.loads(sys.stdin.read());print(d.get('publicIp') or (d.get('runtime',{}).get('ports',[{}])[0].get('ip','')))" 2>/dev/null || echo "")
  if [ -n "$port" ]; then
    if [ "$port" != "$POD_PORT" ]; then log "port: $POD_PORT -> $port"; fi
    POD_PORT="$port"
  fi
  if [ -n "$host" ]; then
    if [ "$host" != "$POD_HOST" ]; then log "host: $POD_HOST -> $host"; fi
    POD_HOST="$host"
  fi
  echo "POD_ID=$POD_ID" >  "$POD_INFO"
  echo "POD_HOST=$POD_HOST" >> "$POD_INFO"
  echo "POD_PORT=$POD_PORT" >> "$POD_INFO"
  [ -n "$POD_HOST" ] && [ -n "$POD_PORT" ]
}

ssh_cmd() {
  local opts="-i $SSH_KEY -p $POD_PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=30"
  ssh $opts "root@$POD_HOST" "$@" 2>&1
}

scp_cmd() {
  local opts="-i $SSH_KEY -P $POD_PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 -o ServerAliveInterval=30"
  scp $opts "$@" 2>&1
}

ssh_test() { ssh_cmd 'echo OK' 2>&1 | grep -q '^OK'; }

ensure_ssh() {
  if ssh_test; then SSH_FAILS=0; return 0; fi
  SSH_FAILS=$((SSH_FAILS+1))
  log "ssh fail #$SSH_FAILS — refresh port via API"
  refresh_pod_info || true
  if ssh_test; then SSH_FAILS=0; log "ssh recovered (port=$POD_PORT)"; return 0; fi
  log "ssh still failing after refresh (fails=$SSH_FAILS)"
  return 1
}

# Parse tqdm output: "<step>/<total> [MM:SS<MM:SS, <it/s> it/s]"
# Returns current step; sets STEP_RATE when enough data.
poll_pipeline() {
  local tail_out step_line step
  tail_out=$(ssh_cmd "tail -c 5000 $REMOTE_OUT/pipeline.log 2>/dev/null | tr '\r' '\n'")
  step_line=$(echo "$tail_out" | grep -oE "[0-9]+/${TOTAL_STEPS} \[[^]]+\]" | tail -1)
  if [ -n "$step_line" ]; then
    step=$(echo "$step_line" | grep -oE "^[0-9]+")
    if [ -n "$step" ] && [ "$step" -gt 0 ]; then
      CUR_STEP="$step"
    fi
  fi
  LAST_STEP_LINE="$step_line"
}

estimate_eta() {
  # Compute step_rate = elapsed / cur_step, then total_sec = total_steps * rate + buffer.
  # Dynamic deadline = started + SAFETY_MULTIPLIER × total_sec.
  if [ "$CUR_STEP" -lt 5 ]; then return; fi
  local now elapsed
  now=$(date +%s)
  elapsed=$((now - STARTED_AT))
  STEP_RATE=$((elapsed / CUR_STEP))
  if [ "$STEP_RATE" -lt 1 ]; then STEP_RATE=1; fi
  EST_TOTAL_SEC=$(( TOTAL_STEPS * STEP_RATE + BUFFER_MERGE_CONVERT ))
  local new_deadline=$(( STARTED_AT + SAFETY_MULTIPLIER * EST_TOTAL_SEC ))
  # Extend-only: never shrink deadline once set.
  if [ "$new_deadline" -gt "$DEADLINE" ]; then DEADLINE="$new_deadline"; fi
}

fmt_hm() { # seconds -> H:MM
  local s=${1:-0}; printf "%d:%02d" $((s/3600)) $(((s%3600)/60))
}

write_status() {
  local state="$1"
  local now remaining eta_str dl_str
  now=$(date +%s)
  if [ "$DEADLINE" -gt 0 ]; then
    remaining=$((DEADLINE - now))
    dl_str="$(date -d @$DEADLINE +%FT%T 2>/dev/null || echo "epoch=$DEADLINE")"
  else
    remaining=0; dl_str="(estimating)"
  fi
  eta_str="rate=${STEP_RATE}s/step  est_total=$(fmt_hm $EST_TOTAL_SEC)  remaining=$(fmt_hm $remaining)"
  cat > "$STATUS_FILE" <<EOF
# Monitor Smart — $(date +%FT%T)

Pod: $POD_ID @ $POD_HOST:$POD_PORT
State: $state
Step: $CUR_STEP / $TOTAL_STEPS
ETA: $eta_str
Deadline: $dl_str
Stages: ${STAGES:-}
LastTqdm: ${LAST_STEP_LINE:-}

## Last 15 monitor-log lines
\`\`\`
$(tail -15 "$MON_LOG" 2>/dev/null)
\`\`\`
EOF
}

stages_str() {
  local s=""
  ssh_cmd "test -f $REMOTE_OUT/stage.train.done"   >/dev/null 2>&1 && s="$s train"
  ssh_cmd "test -f $REMOTE_OUT/stage.merge.done"   >/dev/null 2>&1 && s="$s merge"
  ssh_cmd "test -f $REMOTE_OUT/stage.convert.done" >/dev/null 2>&1 && s="$s convert"
  echo "$s"
}

download_artifacts() {
  log "downloading artifacts to $FT_OUT/"
  scp_cmd "root@$POD_HOST:$REMOTE_OUT/$GGUF_NAME" "$FT_OUT/" || { log "scp gguf FAILED"; return 1; }
  ssh_cmd "cd $REMOTE_OUT && tar czf /tmp/adapter.tgz qwen7b-lora-v2/ 2>/dev/null" >/dev/null || true
  scp_cmd "root@$POD_HOST:/tmp/adapter.tgz" "$FT_OUT/adapter-smart.tgz" || log "adapter tgz scp warn"
  scp_cmd "root@$POD_HOST:$REMOTE_OUT/pipeline.log" "$FT_OUT/pipeline-smart.log" || log "log scp warn"
}

verify_integrity() {
  local local_size remote_size
  local_size=$(stat -c %s "$FT_OUT/$GGUF_NAME" 2>/dev/null || echo 0)
  remote_size=$(ssh_cmd "stat -c %s $REMOTE_OUT/$GGUF_NAME" | tr -d '\r' | tail -1)
  log "integrity: local=$local_size remote=$remote_size"
  [ "$local_size" = "$remote_size" ] && [ "$local_size" -gt 1000000000 ]
}

# ================================ main ================================
log "=== monitor-smart start (PID $$) pod=$POD_ID total_steps=$TOTAL_STEPS gguf=$GGUF_NAME ==="
refresh_pod_info || { log "initial API fetch FAILED — retry in 30s"; sleep 30; refresh_pod_info || { log "abort: no pod info"; exit 1; }; }
log "pod endpoint: $POD_HOST:$POD_PORT"
write_status "STARTING"

while :; do
  if ! ensure_ssh; then
    write_status "SSH_FAIL #$SSH_FAILS"
    if [ "$SSH_FAILS" -ge 5 ]; then
      log "5 consecutive SSH fails — giving up this iteration, sleep $POLL_INTERVAL"
      SSH_FAILS=0
    fi
    sleep 60
    continue
  fi

  STATE=$(ssh_cmd "cat $REMOTE_OUT/pipeline.done 2>/dev/null || echo RUNNING" | tr -d '\r' | tail -1)
  STAGES="$(stages_str)"
  poll_pipeline
  estimate_eta

  case "$STATE" in
    PIPELINE_OK)
      log "PIPELINE_OK — downloading + verifying"
      write_status "DOWNLOADING"
      if ! download_artifacts; then
        log "download failed — pod KEPT RUNNING for retry"
        write_status "DOWNLOAD_FAIL — pod kept"
        exit 1
      fi
      if verify_integrity; then
        log "integrity OK — TERMINATE pod (only success path does this)"
        curl -sS -X DELETE -H "Authorization: Bearer $API_KEY" "$API_BASE/pods/$POD_ID" >/dev/null || log "terminate API call warn"
        write_status "DONE — pod terminated"
        exit 0
      else
        log "integrity MISMATCH — STOP pod (preserve volume)"
        curl -sS -X POST -H "Authorization: Bearer $API_KEY" "$API_BASE/pods/$POD_ID/stop" >/dev/null || true
        write_status "INTEGRITY_MISMATCH — pod stopped, volume preserved"
        exit 3
      fi
      ;;

    PIPELINE_FAILED_*)
      log "pipeline failure reported: $STATE"
      scp_cmd "root@$POD_HOST:$REMOTE_OUT/pipeline.log" "$FT_OUT/pipeline-smart-failed.log" || log "log scp warn"
      log "NO AUTO-STOP — pod kept RUNNING. User can inspect, retry, or manually stop."
      log "  manual stop: curl -sS -X POST -H 'Authorization: Bearer \$KEY' $API_BASE/pods/$POD_ID/stop"
      write_status "FAILED: $STATE — pod KEPT RUNNING, log in $FT_OUT/pipeline-smart-failed.log"
      exit 1
      ;;

    *)
      NOW=$(date +%s)
      if [ "$DEADLINE" -gt 0 ] && [ "$NOW" -ge "$DEADLINE" ]; then
        # Soft timeout: extend by one more estimate cycle + warn. Do NOT stop.
        NEW_DL=$(( NOW + EST_TOTAL_SEC ))
        log "WARN: past dynamic deadline (est=$(fmt_hm $EST_TOTAL_SEC)) — extending to $(date -d @$NEW_DL +%FT%T). Pod kept."
        DEADLINE="$NEW_DL"
        write_status "TIMEOUT_EXTENDED — pod kept, new deadline $(date -d @$DEADLINE +%FT%T)"
        # Give user a chance: exit 2 after 2nd overrun would be possible, but default: keep running forever until user intervenes.
      else
        log "poll step=$CUR_STEP/$TOTAL_STEPS rate=${STEP_RATE}s est=$(fmt_hm $EST_TOTAL_SEC) stages=[$STAGES]"
        write_status "RUNNING"
      fi
      sleep "$POLL_INTERVAL"
      ;;
  esac
done
