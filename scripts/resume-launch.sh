#!/bin/bash
# Resume training on pod after restart.
# - Reads new port from retry-start-status
# - Re-uploads modified train script (with resume_from_checkpoint logic)
# - Installs deps (in case container reset)
# - Verifies checkpoint exists
# - Launches pipeline detached
# - Kicks off new monitor (with LONGER timeout)

set -u
ROOT="/e/DEVELOP/ai-orchestrator"
cd "$ROOT"

POD_ID="${POD_ID:-gqczcmonbiodqy}"
POD_HOST="${POD_HOST:-}"
POD_PORT="${POD_PORT:-}"
SSH_KEY="$HOME/.ssh/id_ed25519"
KEY=$(cat ~/.runpod/api-key)

echo "=== Resume launch ==="

# If host/port not passed in, fetch via API
if [ -z "$POD_HOST" ] || [ -z "$POD_PORT" ]; then
  STATE=$(curl -sS -H "Authorization: Bearer $KEY" "https://rest.runpod.io/v1/pods/$POD_ID")
  POD_HOST=$(echo "$STATE" | grep -oE '"publicIp":"[^"]*"' | head -1 | grep -oE '[0-9.]+')
  POD_PORT=$(echo "$STATE" | grep -oE '"portMappings":\{[^}]*\}' | grep -oE '"22":[0-9]+' | grep -oE '[0-9]+')
  STATUS=$(echo "$STATE" | grep -oE '"desiredStatus":"[^"]+"' | head -1)
fi
echo "pod=$POD_ID host=$POD_HOST port=$POD_PORT"

if [ -z "$POD_PORT" ] || [ -z "$POD_HOST" ]; then
  echo "❌ pod not ready yet — abort"
  exit 1
fi

SSH_OPTS="-i $SSH_KEY -p $POD_PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o ServerAliveInterval=30"
SCP_OPTS="-i $SSH_KEY -P $POD_PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 -o ServerAliveInterval=30"

# Wait for SSH
echo "=== Wait SSH ==="
for i in $(seq 1 20); do
  if ssh $SSH_OPTS root@$POD_HOST 'echo OK' 2>/dev/null | grep -q OK; then
    echo "✅ ssh ready"
    break
  fi
  sleep 15
  echo "ssh wait $i/20..."
done

# Verify checkpoints
echo "=== Checkpoints ==="
CHECKPOINTS=$(ssh $SSH_OPTS root@$POD_HOST 'ls /workspace/orchai/.orcai/ft-output/qwen7b-lora-v2/ 2>/dev/null | grep checkpoint- | sort -V' | tr '\n' ' ')
echo "available: $CHECKPOINTS"

if [ -z "$CHECKPOINTS" ]; then
  echo "❌ NO CHECKPOINTS FOUND — will train from scratch"
else
  LATEST=$(echo "$CHECKPOINTS" | tr ' ' '\n' | tail -1)
  echo "✅ latest: $LATEST"
fi

# Re-upload modified train script (has resume logic)
echo "=== Upload modified train script ==="
scp $SCP_OPTS scripts/train-lora-qwen7b-v2.py root@$POD_HOST:/workspace/orchai/scripts/ || { echo "❌ scp fail"; exit 1; }

# Re-install deps (in case container was reset — volume preserves /workspace but not /usr)
echo "=== Reinstall deps ==="
ssh $SSH_OPTS root@$POD_HOST 'python3 -c "import trl, peft, bitsandbytes" 2>&1 | head -5'
DEPS_OK=$?
if [ $DEPS_OK -ne 0 ]; then
  echo "reinstalling pinned deps..."
  ssh $SSH_OPTS root@$POD_HOST "pip install --quiet --no-cache-dir \
    transformers==4.46.3 peft==0.13.2 trl==0.11.4 bitsandbytes==0.49.2 \
    datasets==3.0.2 accelerate==1.13.0 liger-kernel==0.3.0 rich \
    sentencepiece protobuf 2>&1 | tail -3"
fi

# Launch pipeline detached (cleans pipeline.log + stage flags but KEEPS checkpoints)
echo "=== Launch pipeline ==="
ssh $SSH_OPTS root@$POD_HOST 'cd /workspace/orchai && \
  rm -f .orcai/ft-output/pipeline.log .orcai/ft-output/pipeline.pid .orcai/ft-output/pipeline.done .orcai/ft-output/stage.*.done && \
  setsid nohup bash scripts/pod-run-pipeline-v2.sh </dev/null >/dev/null 2>&1 & disown; \
  sleep 3 && ps -ef | grep -E "pod-run|train-lora" | grep -v grep'

echo ""
echo "=== SAVE NEW POD INFO ==="
cat > "$ROOT/.orcai/pod-info.txt" <<EOF
POD_ID=$POD_ID
POD_HOST=$POD_HOST
POD_PORT=$POD_PORT
RESTARTED=$(date +%FT%T)
EOF
echo "saved to .orcai/pod-info.txt"
echo ""
echo "✅ Resume launched. Monitor manually or via cron every 10min."
