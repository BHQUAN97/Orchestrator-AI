# Business Flows

## 1. CLI Flow — Luồng chính

### 1.1 One-shot Mode

```bash
orcai "fix bug login không redirect"
```

```
1. Commander.parse() — đọc CLI args
2. Config.load() — merge settings.json + env vars
3. printBanner() — hiển thị project/model/role
4. initMCP() — kết nối MCP servers (async, best-effort)
5. BudgetTracker.init() — set cap USD nếu có --budget
6. HookRunner.load() — nạp hooks từ 3 sources
7. buildSystemPrompt() — scan repo + CLAUDE.md + MCP hints
   └── RepoCache.getSummary() (1hr TTL, invalidate theo git HEAD)
8. AgentLoop.run(systemPrompt, userPrompt)
   └── [xem 2. Agent Loop Flow]
9. printResult() — hiển thị kết quả + stats
10. printCacheStats() — token count + cache hit rate + cost
```

### 1.2 Interactive Mode

```bash
orcai -i -p /path/to/project
```

```
1-7. Giống one-shot
8. InputQueue.start() — persistent readline (always-on)
9. Session.create() / resume — ConversationManager
   ├── Auto warm-context: inject files từ session trước (< 30min, same git HEAD)
   └── LocalAssistant.bootstrap() — Qwen 7B + nomic embed (background)
10. Loop:
    ┌─────────────────────────────────────┐
    │  render StatusLine (model/budget)   │
    │  InputQueue.next("❯ ")             │
    │  if Ctrl+C → interrupt agent        │
    │  if slash command → handle          │
    │  if @mention → expandMentions()     │
    │                                     │
    │  Stage 1: RequestAnalyzer.analyze() │
    │  → { goal, complexity, changes }   │
    │  agent.setHintFiles(changes)        │
    │                                     │
    │  Stage 2: LocalAssistant context    │
    │  → buildContextBlock() parallel     │
    │                                     │
    │  AgentLoop.run() / continueWith()   │
    │                                     │
    │  printResult() + printCacheStats()  │
    │  ContextGuard.verify(summary)       │
    │  ConversationManager.save()         │
    │  SessionContinuity.onTurn()         │
    └─────────────────────────────────────┘
11. inputQueue.close()
12. Session summary + bye
```

---

## 2. Agent Loop Flow

```
AgentLoop.run(systemPrompt, userPrompt)
│
├── [reset] messages=[], iteration=0, toolResultCache.clear()
│
├── HermesBridge.selectModel() ← LUÔN chạy (không cần flag)
│   ├── SmartRouter.score() — 5 factors (task/files/keywords/context/cost)
│   └── SLMClassifier (opt-in --use-classifier)
│   → model alias: cheap / fast / smart / architect
│
├── HermesBridge.getRelevantMemories(userPrompt)
│   ├── local TF-IDF search (lessons.jsonl)
│   └── cross-project search (opt-in HERMES_CROSS_PROJECT=1)
│   → inject vào system prompt
│
├── HermesBridge.formatLocksForPrompt()
│   → inject locked decisions vào system prompt
│
├── messages.push(system + user)
│
└── _runLoop(tools):
    │
    ├── HookRunner.run('SessionStart') — fire once
    │
    └── WHILE (iteration < 30 && !completed && !aborted):
        │
        ├── interrupt check (Ctrl+C)
        ├── budget.isExceeded() → abort
        │
        ├── _applyRagIfNeeded(messages) → copy enriched (non-mutating)
        │   └── RagPromptBuilder.build() nếu local model / stage role
        │
        ├── _sanitizeMessagesForCloud(messages) → redact sensitive content
        │   └── Chỉ áp dụng cho cloud model; local model nhận raw
        │
        ├── _trimMessages() — TokenManager rolling 80 messages
        │
        ├── fetchWithRetry(LiteLLM) — retries: 3, backoff jitter
        │   ├── streaming → SSE chunks → onText() real-time
        │   └── non-streaming → JSON response
        │
        ├── _updateCacheStats() → BudgetTracker.record()
        │
        ├── message.tool_calls?
        │   ├── NO → completed=true, break
        │   └── YES → _executeToolBatch(toolCalls)
        │       │
        │       ├── isBatchReadSafe() → parallel (Promise.all)
        │       │                    → serial (for loop)
        │       │
        │       └── _executeSingleToolCall(tc):
        │           ├── Tool result cache check (Map LRU, 50 entries)
        │           ├── StuckDetector.record() — TRƯỚC execute
        │           ├── HookRunner.run('PreToolUse')
        │           │   └── exit != 0 → BLOCK tool call
        │           ├── ToolExecutor.execute(tc) → result
        │           ├── HookRunner.run('PostToolUse')
        │           ├── Tool result cache store (read-safe tools)
        │           ├── StuckDetector.recordResult() — SAU execute
        │           ├── [stuck?] MODEL_ESCALATION: cheap→smart→architect
        │           │   └── onRouting({ method: 'stuck-escalation' })
        │           └── SelfHealer.observe() → auto-gotcha
        │               └── suggestion → inject vào messages[] NGAY (không chờ iteration sau)
        │
        ├── executor.userAborted? → abort
        ├── task_complete tool? → completed=true
        ├── consecutiveErrors >= 3 → abort
        └── _injectAutoVerify() — nhắc chạy test sau edit
    │
    ├── onComplete() — flush text buffer
    └── HookRunner.run('Stop')
```

---

## 3. Routing Decision Flow

```
Mỗi prompt → HermesBridge.selectModel({ task, prompt, files })
│
├── useClassifier=true?
│   └── SLMClassifier.classify(prompt)
│       ├── local-classifier (Qwen 1.5B) — 3s timeout
│       └── fallback: cheap (GPT-5.4 Mini) — 5s timeout
│       → intent + complexity → INTENT_MODEL_MAP lookup
│
└── useClassifier=false (default):
    SmartRouter.score({ task, prompt, files })
    │
    ├── Factor 1: Task match (40%)
    │   task='builder' → cheap best, opus worst
    │   task='reviewer' → fast best
    │   task='architect' → opus required
    │
    ├── Factor 2: File domain (25%)
    │   *.tsx/*.vue/*.css → fe-dev preferred models
    │   *.py/*.go/*.rs → be-dev preferred models
    │   *.sql/migration/* → cheap (structured, deterministic)
    │
    ├── Factor 3: Keywords (20%)
    │   'security/auth/payment' → smart/architect bump
    │   'fix typo/rename/format' → cheap bump
    │   'design/architecture/refactor all' → architect bump
    │
    ├── Factor 4: Context size constraint
    │   contextSize > model.max_context → penalize
    │
    └── Factor 5: Cost bonus (10%)
        Cheaper model = slight score bonus
    
    → Top score wins → { model, method, reasons }

Privacy override:
    forceLocalForPaths(files) → nếu match pattern
    (.env, secrets.*, *_private.*, credentials.*) → local-heavy
```

---

## 4. Memory Flow

```
Khi agent hoàn thành task thành công:
AgentLoop._runLoop() → memoryStore.append({
    type: 'lesson',
    prompt_summary: userPrompt.slice(0, 300),
    summary: completionSummary.slice(0, 500),
    files_changed: [...executor.filesChanged],
    iterations, model
})

Khi tool lỗi 3 lần liên tiếp:
SelfHealer.observe(toolName, args, result)
→ errorStreak >= 3
→ memoryStore.append({ type: 'gotcha', ... })
→ messages.push({ role: 'user', content: '[Self-healer] ...' })
  ← inject NGAY vào session hiện tại (không phải session sau)

Khi bắt đầu run mới:
HermesBridge.getRelevantMemories(userPrompt)
→ MemoryStore.search(query, topK=3)
    TF-IDF scoring (inline < 100 entries, worker_threads >= 100)
→ cross-project search (nếu HERMES_CROSS_PROJECT=1, score >= 0.65)
→ formatMemoriesForPrompt() → inject vào system prompt
```

---

## 5. Orchestrator Pipeline Flow (Full Multi-Agent)

Kích hoạt qua `--via-orchestrator` hoặc POST `/api/run`.

```
User request
│
├── 1. SCANNER (cheap/GPT-5.4-Mini)
│   ├── Đọc file structure, package.json
│   ├── Tìm relevant files bằng glob patterns
│   └── Output: { stack, relevant_files, existing_patterns, potential_issues }
│
├── 2. PLANNER (cheap)
│   ├── Nhận: scan results + user request + locked decisions
│   ├── Stage-RAG auto-inject (planner là stage role)
│   └── Output: { subtasks[], model_assignments[], dependencies }
│
├── 3. TECH LEAD AGENT (cheap)
│   ├── Quick review (no API): check misassignment, circular deps, oversized
│   ├── Full review (API): deep analysis nếu quick review thấy vấn đề
│   ├── APPROVE → continue
│   ├── MODIFY → revise plan, re-submit
│   └── REJECT → abort, explain
│   → Lock critical decisions vào .sdd/decisions.lock.json
│
├── 4. PARALLEL EXECUTION
│   ├── Dependency graph → topological sort
│   ├── Dev agents chạy song song (theo dependencies)
│   ├── Mỗi agent nhận structured JSON context (chuẩn hóa)
│   ├── DecisionLock.check() trước mỗi write → warn
│   └── Escalation khi stuck:
│       Dev Agent → TechLead (GUIDE/REDIRECT/TAKE_OVER/ESCALATE_ARCHITECT)
│                → Architect (Opus 4.6) [max 3 escalations]
│
└── 5. SYNTHESIZER (fast/Gemini 3 Flash)
    ├── Merge all results
    ├── Final consistency check
    └── Output: { summary, files_changed, cost_usd, trace_id }
```

---

## 6. Interrupt & Amendment Flow

```
User nhấn Ctrl+C trong khi agent đang chạy:
│
├── InputQueue nhận SIGINT → agent.interrupt()
├── Agent loop: _interruptRequested=true
├── Sau iteration hiện tại: aborted=true, reason='interrupted'
│
└── orcai check result.reason === 'interrupted':
    ├── inputQueue.hasQueued()?
    │   YES → dùng queued message làm amendment (user đã gõ sẵn)
    │   NO → hỏi user: "Bổ sung context? (Enter để bỏ qua)"
    │
    └── amendment?.trim()?
        YES → agent.continueWith("[Bổ sung context]: " + amendment)
        NO → dừng, hiển thị partial result
```

---

## 7. Decision Lock Flow

```
TechLead phát hiện critical decision trong plan:
→ DecisionLock.create({ scope, decision, relatedFiles, ttl=4h })
→ Lưu vào .sdd/decisions.lock.json

Khi agent chuẩn bị ghi file:
→ onWriteApproval callback:
    HermesBridge.checkFilePath(filePath)
    → path heuristic: auth/*, api/*, migration/*, *.schema.*
    → blocks[] nếu match
    → chalk.yellow("🔒 Lock: [decision]") nếu có blocks

Khi agent chạy:
→ HermesBridge.formatLocksForPrompt()
→ Inject vào system prompt: "[LOCKED] ..."
→ Dev agent tự escalate thay vì override lock

Khi user muốn unlock thủ công:
→ /locks → hiển thị id của từng lock
→ /unlock <id|scope> [reason]
    HermesBridge.unlockDecision(idOrScope, reason)
    decisionLock.unlock(id, { unlockedBy: 'user', reason })
    → status = 'unlocked', ghi audit trail
```

---

## 8. Hook Flow

```
Hook sources (load order, additive):
1. ~/.claude/settings.json (global)
2. {project}/.claude/settings.json (project)
3. {project}/.orcai/settings.json (orcai-specific)

Events:
SessionStart → fire once khi bắt đầu loop
PreToolUse   → trước mỗi tool call
              exit != 0 → BLOCK tool, trả error về agent
PostToolUse  → sau mỗi tool call (non-blocking)
Stop         → sau khi loop kết thúc

Context injected vào hook env:
  ORCAI_EVENT=PreToolUse
  ORCAI_TOOL=edit_file
  ORCAI_PROJECT=/path/to/project
  ORCAI_SESSION=ses_abc123

Example hook (block write to .env):
  {
    "hooks": {
      "PreToolUse": [{
        "matcher": "write_file|edit_file",
        "command": "bash -c 'echo $ORCAI_TOOL | grep -q .env && exit 1 || exit 0'"
      }]
    }
  }
```
