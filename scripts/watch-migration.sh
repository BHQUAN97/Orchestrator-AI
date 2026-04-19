#!/bin/bash
# Watch for migrated pod to come up RUNNING.
# When found: auto-run resume-launch with new pod ID.

set -u
KEY=$(cat ~/.runpod/api-key)
LOG="/e/DEVELOP/ai-orchestrator/.orcai/watch-migration.log"
STATUS="/e/DEVELOP/ai-orchestrator/.orcai/retry-start-status.md"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

log "=== watch-migration start ==="

for i in $(seq 1 80); do  # ~40 min max (30s * 80)
  PODS=$(curl -sS -H "Authorization: Bearer $KEY" "https://rest.runpod.io/v1/pods")

  # Look for RUNNING pod (any ID — migration creates new)
  # Parse out all pod IDs + their states
  RUNNING_ID=$(echo "$PODS" | python -c "
import sys, json
try:
    data = json.loads(sys.stdin.read())
    for p in data:
        if p.get('desiredStatus') == 'RUNNING':
            print(p.get('id', ''))
            break
except Exception as e:
    pass
" 2>/dev/null)

  # Fallback if python missing: grep ID-status pairs
  if [ -z "$RUNNING_ID" ]; then
    RUNNING_ID=$(echo "$PODS" | grep -oE '"id":"[^"]*"[^}]*"desiredStatus":"RUNNING"' | head -1 | grep -oE '"id":"[^"]*"' | head -1 | sed 's/"id":"//;s/"//')
  fi

  if [ -n "$RUNNING_ID" ]; then
    log "✅ RUNNING pod found: $RUNNING_ID"

    # Get details
    DETAIL=$(curl -sS -H "Authorization: Bearer $KEY" "https://rest.runpod.io/v1/pods/$RUNNING_ID")
    IP=$(echo "$DETAIL" | grep -oE '"publicIp":"[^"]*"' | head -1 | grep -oE '[0-9.]+')
    PORT=$(echo "$DETAIL" | grep -oE '"portMappings":\{[^}]*\}' | grep -oE '"22":[0-9]+' | grep -oE '[0-9]+')
    log "ip=$IP port=$PORT"

    if [ -z "$IP" ] || [ -z "$PORT" ]; then
      log "waiting for IP/port to propagate..."
      sleep 20
      continue
    fi

    # Wait for SSH
    SSH_OPTS="-i $HOME/.ssh/id_ed25519 -p $PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"
    for j in $(seq 1 20); do
      if ssh $SSH_OPTS root@$IP 'echo OK' 2>/dev/null | grep -q OK; then
        log "✅ SSH ready on new pod"
        break
      fi
      sleep 15
      log "ssh wait $j/20..."
    done

    cat > "$STATUS" <<EOF
# Migration complete — $(date +%FT%T)
✅ NEW POD RUNNING
- ID: $RUNNING_ID (migrated from gqczcmonbiodqy)
- IP: $IP
- Port: $PORT
- Next: running resume-launch automatically
EOF

    # Run resume-launch with new pod params
    log "triggering resume-launch.sh with new pod..."
    POD_ID="$RUNNING_ID" POD_HOST="$IP" POD_PORT="$PORT" \
      bash /e/DEVELOP/ai-orchestrator/scripts/resume-launch.sh >> "$LOG" 2>&1

    log "=== watch-migration DONE ==="
    exit 0
  fi

  log "poll $i/80 — no RUNNING pod yet"
  sleep 30
done

log "❌ TIMEOUT 40min — no RUNNING pod after migration"
exit 1
