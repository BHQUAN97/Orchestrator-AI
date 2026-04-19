#!/bin/bash
# Finalize: update memory files + handoff doc + push .claude-shared.
# Called by overnight-postprocess at end.

set -u
ROOT="/e/DEVELOP/ai-orchestrator"
SHARED="/e/DEVELOP/.claude-shared"
MEMORY_DIR="/c/Users/buiho/.claude/projects/E--DEVELOP-ai-orchestrator/memory"
FT_OUT="$ROOT/.orcai/ft-output-v2"
LOG="$ROOT/.orcai/overnight-finalize.log"
STATUS_FILE="$ROOT/.orcai/overnight-status.md"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

log "=== Finalize start ==="

# 1. Extract bench result
RESULT_FILE="$FT_OUT/bench-ft-v2-result.md"
if [ ! -f "$RESULT_FILE" ]; then
  log "❌ no bench result — abort finalize"
  exit 1
fi
SCORE=$(grep -oE '[0-9]+/200' "$RESULT_FILE" | head -1)
PCT=$(grep -oE '\([0-9]+\.[0-9]+%\)' "$RESULT_FILE" | head -1 | tr -d '()')
log "score=$SCORE pct=$PCT"

# 2. Write new handoff for next session
NEXT_DATE=$(date +%Y-%m-%d)
HANDOFF="$MEMORY_DIR/phase-5-handoff-${NEXT_DATE}.md"
cat > "$HANDOFF" <<EOF
---
name: phase-5-handoff-${NEXT_DATE}
description: Session handoff ${NEXT_DATE} — Phase 5 Round 5.5 FT v2 result, next steps
type: project
---

# Phase 5 Round 5.5 FT v2 — COMPLETE ($(date +%FT%T))

## Result

**Score: ${SCORE:-unknown} ${PCT:+${PCT}}** on 40-problem realistic bench (RAG on, 200 problems total).

Full leaderboard see \`.orcai/ft-output-v2/bench-ft-v2-result.md\`.

## Artifacts (local)

- \`.orcai/ft-output-v2/qwen7b-ft-v2-Q4_K_M.gguf\` — main model
- \`.orcai/ft-output-v2/adapter-v2.tgz\` — LoRA adapter (for continue-FT future)
- \`.orcai/ft-output-v2/pipeline-v2.log\` — training log
- \`.orcai/ft-output-v2/bench-ft-v2-result.md\` — bench result markdown
- \`.orcai/ft-output-v2/bench-ft-v2.log\` — bench raw log
- LM Studio: loaded as \`local/qwen2.5-coder-7b-ft-v2\` (was as \`local-heavy\` during bench, now unloaded)

## Training config used

- Base: Qwen/Qwen2.5-Coder-7B-Instruct
- Data: 2097 pairs (style 773 + classifier 298 + distill v1 74 + distill v2 952)
- Method: QLoRA + **DoRA** (use_dora=True), NF4 4-bit, bf16 compute
- r=16, α=32, 7 proj (all-linear), dropout 0.05
- LR 2e-4 cosine, warmup 5%, 3 epochs, batch 1×grad_accum 8 (eff 8)
- GPU: RunPod RTX 4000 Ada 20GB, \$0.26/hr
- Cost: check \`.orcai/overnight-monitor.log\` for duration

## Pod status

Pod \`gqczcmonbiodqy\` should be TERMINATED by monitor after successful download.

## Next steps (user decide on wake)

1. Review bench result — did we hit ≥91% target?
2. If ≥91%: update \`.orcai/router.json\` to use ft-v2 as workhorse; ship Phase 5.
3. If 87-90%: consider ORPO pass (research: collect 300-500 preference pairs from v2 vs 3.5-9B)
4. If <87%: regression — investigate data quality or try different hyperparams (r=32?)
5. Push changes to .claude-shared (memory + plan docs)

## Files to check first on wake

1. \`.orcai/overnight-status.md\` — latest state summary
2. \`.orcai/ft-output-v2/bench-ft-v2-result.md\` — the key result
3. \`.orcai/overnight-monitor.log\` — if anything went wrong
4. Any RunPod pod still running? \`curl -H "Authorization: Bearer \$(cat ~/.runpod/api-key)" https://rest.runpod.io/v1/pods\`
EOF
log "wrote handoff: $HANDOFF"

# 3. Update MEMORY.md index if handoff not already there
MEMORY_INDEX="$MEMORY_DIR/MEMORY.md"
if [ -f "$MEMORY_INDEX" ]; then
  # Remove any previous phase-5-handoff entries to avoid dup
  grep -v "phase-5-handoff" "$MEMORY_INDEX" > "$MEMORY_INDEX.tmp" || cp "$MEMORY_INDEX" "$MEMORY_INDEX.tmp"
  mv "$MEMORY_INDEX.tmp" "$MEMORY_INDEX"
  # Append new entry
  echo "" >> "$MEMORY_INDEX"
  echo "## Phase 5 Status" >> "$MEMORY_INDEX"
  echo "- [Phase 5 Handoff ${NEXT_DATE}](phase-5-handoff-${NEXT_DATE}.md) — Round 5.5 FT v2 result: ${SCORE:-unknown} ${PCT:+${PCT}}" >> "$MEMORY_INDEX"
  log "updated MEMORY.md index"
fi

# 4. Update PHASE-5-ROUND-5.5-PLAN.md with result
PLAN="$ROOT/.orcai/knowledge/PHASE-5-ROUND-5.5-PLAN.md"
if [ -f "$PLAN" ]; then
  cat >> "$PLAN" <<EOF

---

## ROUND 5.5 RESULT — $(date +%FT%T)

**Score: ${SCORE:-unknown} ${PCT:+${PCT}}** (DoRA, 2097 pairs, 3 epochs)

See \`.orcai/ft-output-v2/bench-ft-v2-result.md\` for full leaderboard + verdict.
EOF
  log "appended result to PLAN"
fi

# 5. Update context cache
CONTEXT_CACHE="$SHARED/context-cache/ai-orchestrator.context.md"
if [ -f "$CONTEXT_CACHE" ]; then
  # Simple append section
  cat >> "$CONTEXT_CACHE" <<EOF

## Recent focus ($(date +%Y-%m-%d))
- Round 5.5 FT v2 completed: ${SCORE:-unknown} ${PCT:+${PCT}}
- 2097 pairs, DoRA enabled, 4000 Ada \$0.26/h
- Artifacts in \`.orcai/ft-output-v2/\`
EOF
  log "updated context cache"
fi

# 6. Push .claude-shared
if [ -d "$SHARED/.git" ]; then
  cd "$SHARED"
  git add -A 2>&1 | tail -5 | tee -a "$LOG"
  if ! git diff --cached --quiet; then
    git commit -m "sync: Round 5.5 FT v2 result ${SCORE:-pending} — $(date +%Y-%m-%d)" 2>&1 | tail -3 | tee -a "$LOG"
    git push 2>&1 | tail -3 | tee -a "$LOG" || log "git push failed (non-fatal)"
  else
    log "no changes to commit"
  fi
  cd "$ROOT"
fi

# 7. Mark status DONE
cat >> "$STATUS_FILE" <<EOF

## Finalize ($(date +%H:%M:%S))
✅ DONE — all tasks complete
- Bench: ${SCORE:-unknown} ${PCT:+${PCT}}
- Handoff: phase-5-handoff-${NEXT_DATE}.md
- Memory updated, .claude-shared pushed
EOF

log "=== Finalize DONE ==="
