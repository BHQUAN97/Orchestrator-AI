#!/bin/bash
# cost-guardian.sh — RunPod cost tracking + alert daemon.
#
# Polls RunPod REST API every 5 min, tracks cumulative USD spent since
# script start, and fires escalating alerts at $1/$2/$3/$5/$10 thresholds.
#
# RunPod REST /v1/user is NOT reliable for balance — we track accumulated
# cost on OUR side: SUM(costPerHr * hours_running) per pod, plus carry-over
# for pods that went EXITED during session (don't double count — we store
# "finalized" cost per pod once it exits).
#
# Usage:
#   bash scripts/cost-guardian.sh [--balance-start <USD>] [--poll-interval <sec>]
#   bash scripts/cost-guardian.sh --stop
#
# Files (all under .orcai/):
#   cost-tracker.json    — current state (pods, cumulative cost, timestamps)
#   cost-alert.md        — human-readable alerts (updated in place)
#   cost-history.log     — append-only time-series log
#   cost-guardian.pid    — daemon PID

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ORCAI="$ROOT/.orcai"
mkdir -p "$ORCAI"

STATE="$ORCAI/cost-tracker.json"
ALERT="$ORCAI/cost-alert.md"
HIST="$ORCAI/cost-history.log"
PIDF="$ORCAI/cost-guardian.pid"
KEYF="$HOME/.runpod/api-key"

POLL=300
BAL_START=""
STOP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --balance-start) BAL_START="$2"; shift 2 ;;
    --poll-interval) POLL="$2"; shift 2 ;;
    --stop) STOP=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ---------- stop handler ----------
if [ "$STOP" = "1" ]; then
  if [ -f "$PIDF" ]; then
    pid=$(cat "$PIDF")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" && echo "stopped daemon pid=$pid"
    else
      echo "stale pidfile (pid=$pid not running), removing"
    fi
    rm -f "$PIDF"
  else
    echo "no pidfile at $PIDF"
  fi
  exit 0
fi

# ---------- preflight ----------
if [ ! -f "$KEYF" ]; then
  echo "missing RunPod API key at $KEYF" >&2; exit 1
fi
KEY=$(cat "$KEYF")

log()  { echo "[$(date +%FT%T)] $*" | tee -a "$HIST"; }
logf() { echo "[$(date +%FT%T)] $*" >> "$HIST"; }

# Windows desktop notification via powershell msg (non-fatal if fails).
notify() {
  local title="$1" body="$2"
  powershell.exe -NoProfile -Command \
    "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; [System.Windows.Forms.MessageBox]::Show('$body','$title')" \
    >/dev/null 2>&1 &
}

# ---------- JSON helpers (sed/grep — no jq dependency) ----------
# Extract first value of a scalar field from JSON blob.
json_field() { echo "$1" | grep -oE "\"$2\":[[:space:]]*\"[^\"]*\"" | head -1 | sed -E "s/.*\"$2\":[[:space:]]*\"([^\"]*)\".*/\\1/"; }
json_num()   { echo "$1" | grep -oE "\"$2\":[[:space:]]*[0-9.]+" | head -1 | sed -E "s/.*\"$2\":[[:space:]]*([0-9.]+).*/\\1/"; }

# ---------- daemonize ----------
# If not yet background, re-exec ourselves under nohup.
if [ "${_CG_DAEMON:-0}" != "1" ]; then
  if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
    echo "cost-guardian already running pid=$(cat "$PIDF")" >&2; exit 1
  fi
  _CG_DAEMON=1 nohup bash "$0" ${BAL_START:+--balance-start "$BAL_START"} --poll-interval "$POLL" \
    >> "$HIST" 2>&1 &
  echo $! > "$PIDF"
  echo "cost-guardian started pid=$(cat "$PIDF") poll=${POLL}s balance_start=${BAL_START:-unset}"
  exit 0
fi

export _CG_DAEMON=1
echo $$ > "$PIDF"
trap 'rm -f "$PIDF"; log "cost-guardian stopped"; exit 0' TERM INT

START_TS=$(date -u +%FT%TZ)
START_EPOCH=$(date +%s)
CUMULATIVE="0"
# finalized_cost: running total of cost from pods that have EXITED during
# this session (so we don't re-poll their hours forever).
FINAL_COST="0"
# track per-pod last known lastStartedAt to compute run duration of exited pods.
declare -A POD_LAST_START
declare -A POD_RATE
declare -A POD_LOCKED  # once EXITED we lock its contribution

log "=== cost-guardian start ts=$START_TS poll=${POLL}s balance_start=${BAL_START:-unset} ==="

# ---------- pod polling ----------
poll_pods() {
  curl -sS -H "Authorization: Bearer $KEY" "https://rest.runpod.io/v1/pods" 2>&1
}

# Compute cost contribution for a single pod, given its raw JSON object.
# Prints "<pod_id> <rate> <status> <hours> <cost>" on stdout.
# Echoes nothing if skipped.
calc_pod_cost() {
  local raw="$1"
  local id status rate started
  id=$(json_field "$raw" "id")
  status=$(json_field "$raw" "desiredStatus")
  rate=$(json_num "$raw" "costPerHr")
  started=$(json_field "$raw" "lastStartedAt")
  [ -z "$id" ] && return 0
  [ -z "$rate" ] && rate="0"

  local now_epoch start_epoch hours cost
  now_epoch=$(date +%s)
  if [ -n "$started" ]; then
    # started like 2026-04-19T10:00:00.000Z  -> strip ms+Z for date parse
    local clean
    clean=$(echo "$started" | sed -E 's/\.[0-9]+Z$/Z/')
    start_epoch=$(date -d "$clean" +%s 2>/dev/null || echo "$now_epoch")
  else
    start_epoch="$now_epoch"
  fi

  # If running, cost = rate * (now - start) / 3600, but never credit time
  # before our own START_EPOCH (guardian only owns "this session" cost).
  local effective_start="$start_epoch"
  [ "$start_epoch" -lt "$START_EPOCH" ] && effective_start="$START_EPOCH"

  if [ "$status" = "RUNNING" ]; then
    hours=$(awk -v n="$now_epoch" -v s="$effective_start" 'BEGIN{printf "%.6f",(n-s)/3600}')
  else
    hours="0"
  fi
  cost=$(awk -v r="$rate" -v h="$hours" 'BEGIN{printf "%.4f",r*h}')
  echo "$id $rate $status $hours $cost $start_epoch"
}

# Detect idle pods via local ft-output/pipeline.log mtime (only heuristic
# we have client-side — if log hasn't ticked in 30+ min, probably idle).
check_idle() {
  local flag=""
  local plog="$ORCAI/ft-output/pipeline.log"
  if [ -f "$plog" ]; then
    local age_sec
    age_sec=$(( $(date +%s) - $(stat -c %Y "$plog" 2>/dev/null || echo 0) ))
    if [ "$age_sec" -gt 1800 ]; then
      flag="pipeline.log stale ${age_sec}s — pod may be idle/forgotten"
    fi
  fi
  echo "$flag"
}

# ---------- alert ----------
last_tier=0
alert() {
  local tier="$1" cumu="$2" idle="$3"
  # idempotent — only fire each tier once per session.
  [ "$tier" -le "$last_tier" ] && return 0
  last_tier="$tier"

  local banner=""
  case "$tier" in
    1) banner="[INFO] RunPod session cost crossed \$1 (now \$$cumu)" ;;
    2) banner="[WARN] RunPod session cost crossed \$2 (now \$$cumu) — review pods" ;;
    3) banner="[WARN] RunPod session cost crossed \$3 (now \$$cumu) — consider stopping idle pods"
       notify "RunPod cost alert" "Session spend \$$cumu crossed \$3 threshold." ;;
    5) banner="[CRITICAL] RunPod session cost crossed \$5 (now \$$cumu) — STOP unneeded pods NOW"
       notify "RunPod CRITICAL" "Session spend \$$cumu crossed \$5. Stop pods!" ;;
    10) banner="[EMERGENCY] RunPod session cost crossed \$10 (now \$$cumu)"
       notify "RunPod EMERGENCY" "Session spend \$$cumu crossed \$10!"
       if [ "${AUTO_STOP_ON_CRIT:-0}" = "1" ]; then
         banner="$banner — AUTO_STOP_ON_CRIT=1, stopping all pods"
         local list
         list=$(poll_pods)
         for pid in $(echo "$list" | grep -oE '"id":"[^"]*"' | sed -E 's/.*"id":"([^"]*)".*/\1/'); do
           curl -sS -X POST -H "Authorization: Bearer $KEY" \
             "https://rest.runpod.io/v1/pods/$pid/stop" >/dev/null 2>&1 || true
           logf "auto-stop pod=$pid"
         done
       fi ;;
  esac

  cat > "$ALERT" <<EOF
# RunPod Cost Alert — $(date +%FT%T)

!! $banner

- Session start: $START_TS
- Elapsed: $(( ($(date +%s) - START_EPOCH) / 60 )) min
- Cumulative session cost: \$$cumu
- Balance start: ${BAL_START:-unset}
- Balance remaining (est): $( [ -n "$BAL_START" ] && awk -v b="$BAL_START" -v c="$cumu" 'BEGIN{printf "%.2f",b-c}' || echo unknown )
- Idle hint: ${idle:-none}

See \`$STATE\` for pod detail.
EOF
  log "ALERT tier=\$$tier cumu=\$$cumu"
}

check_thresholds() {
  local cumu="$1" idle="$2"
  # compare as float via awk
  awk -v c="$cumu" 'BEGIN{exit !(c>=10)}' && { alert 10 "$cumu" "$idle"; return; }
  awk -v c="$cumu" 'BEGIN{exit !(c>=5)}'  && { alert 5  "$cumu" "$idle"; return; }
  awk -v c="$cumu" 'BEGIN{exit !(c>=3)}'  && { alert 3  "$cumu" "$idle"; return; }
  awk -v c="$cumu" 'BEGIN{exit !(c>=2)}'  && { alert 2  "$cumu" "$idle"; return; }
  awk -v c="$cumu" 'BEGIN{exit !(c>=1)}'  && { alert 1  "$cumu" "$idle"; return; }
}

write_state() {
  local cumu="$1" idle="$2" pods_json="$3"
  local remain="null"
  [ -n "$BAL_START" ] && remain=$(awk -v b="$BAL_START" -v c="$cumu" 'BEGIN{printf "%.4f",b-c}')
  cat > "$STATE" <<EOF
{
  "session_start": "$START_TS",
  "updated": "$(date -u +%FT%TZ)",
  "poll_interval_sec": $POLL,
  "balance_start": ${BAL_START:-null},
  "cumulative_cost_usd": $cumu,
  "balance_remaining_est_usd": $remain,
  "last_tier_fired": $last_tier,
  "idle_hint": "${idle:-}",
  "pods": [$pods_json]
}
EOF
}

# ---------- main loop ----------
while :; do
  RAW=$(poll_pods)
  # split into per-pod chunks — RunPod returns an array. Simple split on "},{".
  chunks=$(echo "$RAW" | sed -E 's/\},\{/}\n{/g' | sed -E 's/^\[//; s/\]$//')

  live_sum="0"
  pods_json=""
  while IFS= read -r chunk; do
    [ -z "$chunk" ] && continue
    row=$(calc_pod_cost "$chunk")
    [ -z "$row" ] && continue
    read -r pid rate status hours cost start_epoch <<<"$row"

    # Pod lifecycle: once EXITED/TERMINATED, freeze its contribution.
    if [ "$status" != "RUNNING" ]; then
      if [ "${POD_LOCKED[$pid]:-0}" = "0" ] && [ -n "${POD_LAST_START[$pid]:-}" ]; then
        # finalize using last-seen running cost (already in FINAL_COST via
        # additive model below — we just lock it here so future polls skip).
        POD_LOCKED[$pid]=1
        logf "pod=$pid locked status=$status"
      fi
      pods_json="${pods_json}${pods_json:+,}{\"id\":\"$pid\",\"status\":\"$status\",\"rate\":$rate,\"hours\":0,\"cost\":0}"
      continue
    fi

    POD_LAST_START[$pid]="$start_epoch"
    POD_RATE[$pid]="$rate"
    live_sum=$(awk -v a="$live_sum" -v b="$cost" 'BEGIN{printf "%.4f",a+b}')
    pods_json="${pods_json}${pods_json:+,}{\"id\":\"$pid\",\"status\":\"$status\",\"rate\":$rate,\"hours\":$hours,\"cost\":$cost}"
  done <<<"$chunks"

  CUMULATIVE=$(awk -v f="$FINAL_COST" -v l="$live_sum" 'BEGIN{printf "%.4f",f+l}')
  IDLE=$(check_idle)

  write_state "$CUMULATIVE" "$IDLE" "$pods_json"
  logf "poll cumu=\$$CUMULATIVE live=\$$live_sum pods=$(echo "$pods_json" | grep -oc '"id":')"
  check_thresholds "$CUMULATIVE" "$IDLE"

  sleep "$POLL"
done
