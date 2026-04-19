#!/bin/bash
# Auto-retry start pod until GPU available or timeout.
# Write status when success/fail.

set -u
POD_ID="gqczcmonbiodqy"
KEY=$(cat ~/.runpod/api-key)
LOG="/e/DEVELOP/ai-orchestrator/.orcai/retry-start.log"
STATUS="/e/DEVELOP/ai-orchestrator/.orcai/retry-start-status.md"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

log "=== retry-start start ==="

for i in $(seq 1 40); do
  RESP=$(curl -sS -X POST -H "Authorization: Bearer $KEY" "https://rest.runpod.io/v1/pods/$POD_ID/start" 2>&1)

  if echo "$RESP" | grep -q '"desiredStatus":"RUNNING"\|"desiredStatus":"STARTING"'; then
    log "✅ start OK on attempt $i"
    # Wait for RUNNING
    for j in $(seq 1 20); do
      sleep 15
      STATE=$(curl -sS -H "Authorization: Bearer $KEY" "https://rest.runpod.io/v1/pods/$POD_ID" 2>&1)
      if echo "$STATE" | grep -q '"desiredStatus":"RUNNING"'; then
        PORT=$(echo "$STATE" | grep -oE '"portMappings":\{[^}]*\}' | grep -oE '"22":[0-9]+' | grep -oE '[0-9]+')
        IP=$(echo "$STATE" | grep -oE '"publicIp":"[^"]*"' | head -1 | grep -oE '[0-9.]+')
        log "✅ RUNNING ip=$IP port=$PORT"
        cat > "$STATUS" <<EOF
# Pod restart status — $(date +%FT%T)
✅ RESTARTED OK — auto-running resume-launch
- ID: $POD_ID
- IP: $IP
- Port: $PORT (changed from original 24608)

## SSH
\`\`\`
ssh root@$IP -p $PORT -i ~/.ssh/id_ed25519
\`\`\`
EOF
        log "triggering resume-launch.sh..."
        bash /e/DEVELOP/ai-orchestrator/scripts/resume-launch.sh >> "$LOG" 2>&1
        log "resume-launch done, exit"
        exit 0
      fi
    done
  fi

  ERR=$(echo "$RESP" | grep -oE '"error":"[^"]+"' | head -c 150)
  log "attempt $i/40 — $ERR"
  cat > "$STATUS" <<EOF
# Pod restart status — $(date +%FT%T)
⏳ RETRYING ($i/40) — waiting for GPU

Last error: $ERR

Retry interval: 3min. Max 40 attempts = 2h.
EOF
  sleep 180
done

log "❌ TIMEOUT after 40 retries (2h) — GPU host still busy"
cat > "$STATUS" <<EOF
# Pod restart status — $(date +%FT%T)
❌ TIMEOUT 2h — GPU host still busy after 40 retries
Options:
1. Wait longer (continue retrying manually)
2. Terminate this pod + deploy new one (lose volume + checkpoint, restart scratch)
3. Accept incomplete training (92% done, no final adapter)
EOF
exit 1
