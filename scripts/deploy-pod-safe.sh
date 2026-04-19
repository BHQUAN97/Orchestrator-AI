#!/bin/bash
# deploy-pod-safe.sh — Deploy RunPod pod via REST API with strict spec validation.
#
# Usage: ./deploy-pod-safe.sh ["GPU TYPE"] [VOLUME_GB]
#   Accepted GPU types: "RTX 4090" (default), "RTX 4000 Ada", "L40S"
#   Volume size: minimum 60GB (default 60)
#
# On success: writes .orcai/pod-info.txt with POD_ID, POD_HOST, POD_PORT.
# Exit codes: 0=ok, 1=spec-fail, 2=ssh-fail, 3=api-fail, 4=bad-args
#
# Rationale: Round 5.5 hit GPU host contention + under-spec pods. We now
# validate the pod we got actually matches the spec we asked for (memoryInGb,
# vcpuCount), and tear down IMMEDIATELY if it doesn't — no silent underprovision.

set -u

GPU_ARG="${1:-RTX 4090}"
VOL_GB="${2:-60}"

KEY_FILE="$HOME/.runpod/api-key"
SSH_KEY="$HOME/.ssh/id_ed25519"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_FILE="$ROOT/.orcai/pod-info.txt"
mkdir -p "$ROOT/.orcai"

log() { echo "[$(date +%FT%T)] $*"; }

# ---- Validate args ----
if [ ! -f "$KEY_FILE" ]; then
  log "ERROR: API key missing at $KEY_FILE"; exit 4
fi
if [ "$VOL_GB" -lt 60 ] 2>/dev/null; then
  log "ERROR: volume size $VOL_GB < 60GB minimum"; exit 4
fi

# Map friendly GPU name -> RunPod gpuTypeId
case "$GPU_ARG" in
  "RTX 4090")      GPU_ID="NVIDIA GeForce RTX 4090" ;;
  "RTX 4000 Ada")  GPU_ID="NVIDIA RTX 4000 Ada Generation" ;;
  "L40S")          GPU_ID="NVIDIA L40S" ;;
  *)
    log "ERROR: unsupported GPU '$GPU_ARG' — accepted: 'RTX 4090', 'RTX 4000 Ada', 'L40S'"
    exit 4 ;;
esac

KEY=$(cat "$KEY_FILE")
API="https://rest.runpod.io/v1"
IMAGE="runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04"

log "Deploying pod: gpu='$GPU_ARG' vol=${VOL_GB}GB image=$IMAGE"

# ---- Create pod (SECURE cloud, On-Demand only, ports 22/tcp + 8888/http) ----
CREATE_BODY=$(cat <<EOF
{
  "name": "orcai-ft-$(date +%Y%m%d-%H%M)",
  "imageName": "$IMAGE",
  "gpuTypeIds": ["$GPU_ID"],
  "gpuCount": 1,
  "volumeInGb": $VOL_GB,
  "containerDiskInGb": 30,
  "volumeMountPath": "/workspace",
  "ports": ["22/tcp", "8888/http"],
  "cloudType": "SECURE",
  "computeType": "GPU",
  "interruptible": false,
  "supportPublicIp": true
}
EOF
)

RESP=$(curl -sS -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "$CREATE_BODY" "$API/pods" 2>&1)
POD_ID=$(echo "$RESP" | grep -oE '"id":"[^"]+"' | head -1 | sed 's/.*":"\(.*\)"/\1/')

if [ -z "$POD_ID" ]; then
  log "ERROR: pod create failed — $RESP"; exit 3
fi
log "Created pod $POD_ID — polling for RUNNING"

# ---- Poll every 15s up to 5 min for status=RUNNING ----
STATUS=""; DETAIL=""
for i in $(seq 1 20); do
  DETAIL=$(curl -sS -H "Authorization: Bearer $KEY" "$API/pods/$POD_ID" 2>&1)
  STATUS=$(echo "$DETAIL" | grep -oE '"desiredStatus":"[^"]+"' | head -1 | sed 's/.*":"\(.*\)"/\1/')
  log "  [$i/20] status=$STATUS"
  [ "$STATUS" = "RUNNING" ] && break
  sleep 15
done

if [ "$STATUS" != "RUNNING" ]; then
  log "ERROR: pod not RUNNING after 5 min — terminating"
  curl -sS -X DELETE -H "Authorization: Bearer $KEY" "$API/pods/$POD_ID" >/dev/null
  exit 3
fi

# ---- Verify spec from response (memoryInGb >= 30, vcpuCount >= 4) ----
MEM=$(echo "$DETAIL" | grep -oE '"memoryInGb":[0-9]+' | head -1 | grep -oE '[0-9]+$')
VCPU=$(echo "$DETAIL" | grep -oE '"vcpuCount":[0-9]+' | head -1 | grep -oE '[0-9]+$')
log "Pod spec: memoryInGb=$MEM vcpuCount=$VCPU"

if [ -z "$MEM" ] || [ -z "$VCPU" ] || [ "$MEM" -lt 30 ] || [ "$VCPU" -lt 4 ]; then
  log "ERROR: spec under-provisioned (need mem>=30 vcpu>=4) — TERMINATING"
  curl -sS -X DELETE -H "Authorization: Bearer $KEY" "$API/pods/$POD_ID" >/dev/null
  exit 1
fi

# ---- Extract host + port (port 22 mapping) ----
POD_HOST=$(echo "$DETAIL" | grep -oE '"publicIp":"[^"]*"' | head -1 | sed 's/.*":"\(.*\)"/\1/')
POD_PORT=$(echo "$DETAIL" | grep -oE '"portMappings":\{[^}]*\}' | grep -oE '"22":[0-9]+' | grep -oE '[0-9]+$')

if [ -z "$POD_HOST" ] || [ -z "$POD_PORT" ]; then
  log "ERROR: missing host/port in pod detail — TERMINATING"
  curl -sS -X DELETE -H "Authorization: Bearer $KEY" "$API/pods/$POD_ID" >/dev/null
  exit 3
fi

# ---- Wait for SSH daemon (retry 15s x 20) ----
log "Waiting for SSH on $POD_HOST:$POD_PORT"
SSH_OK=0
for i in $(seq 1 20); do
  if ssh -i "$SSH_KEY" -p "$POD_PORT" \
       -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 \
       -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
       "root@$POD_HOST" "echo OK" 2>/dev/null | grep -q OK; then
    SSH_OK=1
    log "  SSH ready (attempt $i)"
    break
  fi
  log "  [$i/20] SSH not ready — retry 15s"
  sleep 15
done

if [ "$SSH_OK" -ne 1 ]; then
  log "ERROR: SSH unreachable after 5 min — keeping pod RUNNING for debug"
  log "Manual cleanup: curl -X DELETE -H 'Authorization: Bearer \$KEY' $API/pods/$POD_ID"
  exit 2
fi

# ---- Write pod-info.txt and print ----
cat > "$OUT_FILE" <<EOF
POD_ID=$POD_ID
POD_HOST=$POD_HOST
POD_PORT=$POD_PORT
GPU=$GPU_ARG
MEM_GB=$MEM
VCPU=$VCPU
VOLUME_GB=$VOL_GB
DEPLOYED_AT=$(date +%FT%T)
EOF

echo "POD_ID=$POD_ID, POD_HOST=$POD_HOST, POD_PORT=$POD_PORT"
log "Deploy OK — pod-info written to $OUT_FILE"
exit 0
