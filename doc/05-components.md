# Chi tiết từng Component

## 1. AgentLoop (`lib/agent-loop.js`)

**Vai trò**: Vòng lặp tự trị chính — tương tự agentic loop của Claude Code.

### Constructor options

```js
new AgentLoop({
  litellmUrl: 'http://localhost:5002',  // LiteLLM gateway
  litellmKey: 'sk-...',
  model: 'smart',                       // Model alias
  projectDir: process.cwd(),
  agentRole: 'builder',                 // builder|reviewer|planner|fe-dev|be-dev|debugger
  maxIterations: 30,                    // Max tool call iterations
  maxMessages: 80,                      // Rolling window
  maxConsecutiveErrors: 3,
  streaming: true,                      // SSE streaming
  promptCaching: true,                  // Anthropic cache_control
  thinking: false,                      // Extended thinking
  thinkingAuto: true,                   // Auto-detect complex prompts
  thinkingBudget: 8000,                 // Thinking token budget
  budget: BudgetTracker,                // Cost cap
  hookRunner: HookRunner,
  memoryStore: MemoryStore,
  contextGuard: ContextGuard,
  hermesBridge: HermesBridge,
  parallelReadSafe: true,               // Parallel batch read-safe tools
  retries: 3,                           // LLM fetch retries
  toolResultCache: true,                // In-run tool result cache
  // Callbacks
  onThinking: (iter, max) => {},
  onToolCall: (name, args) => {},
  onToolResult: (name, result) => {},
  onText: (chunk) => {},                // Streaming text
  onComplete: () => {},                 // Flush text buffer
  onError: (msg) => {},
  onRouting: ({ from, to, decision }) => {},  // Model switch event
})
```

### Public API

```js
agent.run(systemPrompt, userPrompt)  → Result
agent.continueWith(userMessage)      → Result
agent.interrupt()                    // Request stop (safe for SIGINT)
agent.setHintFiles(files[])         // Feed files từ RequestAnalyzer
agent.getCacheStats()               → { total_input_tokens, cache_hit_rate_pct, cost }
agent.getRagMetrics()               → { rag_applied, rag_skipped_cloud, ... }
agent.getToolCacheStats()           → { hits, misses, tokensSaved, size }
```

### Result object

```js
{
  success: boolean,
  aborted: boolean,
  reason: 'completed' | 'too_many_errors' | 'max_iterations' | 'budget_exceeded' | 'interrupted',
  iterations: number,
  tool_calls: number,
  by_tool: { read_file: 5, edit_file: 2, ... },
  files_changed: string[],
  commands_run: number,
  commands_run_detail: [{ command, exit_code }],
  elapsed_ms: number,
  wall_elapsed_ms: number,
  errors: number,
  final_message: string | null,
  summary: string | null      // từ task_complete tool
}
```

---

## 2. HermesBridge (`lib/hermes-bridge.js`)

**Vai trò**: Thin client kết nối AgentLoop với Hermes ecosystem — routing, memory, decision locks.

### selectModel()

```js
hermesBridge.selectModel({
  task: 'builder',          // Agent role
  prompt: 'fix bug X',      // User prompt
  files: ['src/auth.ts'],   // Hint files từ RequestAnalyzer.changes[]
  contextSize: 0            // Optional: estimated context tokens
})
→ {
  model: 'cheap',
  method: 'smart-router' | 'slm-classifier' | 'default',
  reasons: ['task=builder prefers cheap', 'file=*.ts neutral', ...],
  score: 0.87
}
```

**SmartRouter scoring (5 factors)**:

| Factor | Weight | Logic |
|--------|--------|-------|
| Task match | 40% | builder → cheap ++, reviewer → fast ++, architect → opus ++ |
| File domain | 25% | *.tsx/vue/css → fe preferred, *.sql/migration → cheap |
| Keywords | 20% | 'security/auth' → smart bump, 'typo/rename' → cheap bump |
| Context size | constraint | > model.max_context → penalize |
| Cost bonus | 10% | Cheaper = slight score bonus |

### getRelevantMemories()

```js
hermesBridge.getRelevantMemories(query, {
  topK: 3,              // Local memories
  crossTopK: 2,         // Cross-project (nếu enabled)
  crossThreshold: 0.65, // Min score cho cross-project
  memoryStore: store    // Inject MemoryStore instance
})
→ {
  local: [{ type, summary, files_changed, model, _score }],
  cross: [{ project, summary, _score }]  // nếu HERMES_CROSS_PROJECT=1
}
```

### checkFilePath()

```js
hermesBridge.checkFilePath('src/auth/login.ts')
→ [
  {
    scope: 'auth',
    decision: 'JWT tokens dùng RS256, không dùng HS256',
    relatedFiles: ['src/auth/', 'middleware/auth.js'],
    lockedAt: '2026-04-20T10:00:00Z',
    approvedBy: 'tech-lead',
    ttl: 14400  // seconds
  }
]
// [] nếu không có lock match
```

**Path heuristic** (`_detectScope`):
- `auth/` → `auth` scope
- `api/` → `api` scope
- `migration/` hoặc `.schema.` → `database` scope
- `payment/` hoặc `billing/` → đặc biệt cẩn thận

### formatMemoriesForPrompt()

```js
hermesBridge.formatMemoriesForPrompt({ local, cross })
→ `
=== RELEVANT EXPERIENCE ===
[Local memory - score 0.85]
Type: lesson | Fix: dùng useCallback để tránh re-render
Files: src/hooks/useAuth.ts
Model: cheap

[Cross-project memory - score 0.72]
Project: webapp (similar stack)
Fix: cùng vấn đề session timeout, solved bằng refresh token
=== END EXPERIENCE ===
`
```

---

## 3. RequestAnalyzer (`lib/request-analyzer.js`)

**Vai trò**: Phân tích prompt trước khi route — chạy đầu tiên trên MỌI prompt.

### analyze()

```js
requestAnalyzer.analyze(prompt, {
  recentFiles: ['src/auth.ts'],      // Files vừa thay đổi trong session
  conversationTurn: 2                // Exchange count
})
→ {
  goal: 'Fix bug redirect sau login',
  needs: ['src/auth.ts', 'useAuth hook'],   // Cần đọc
  changes: ['src/auth/login.tsx'],          // Sẽ sửa → feed vào setHintFiles()
  complexity: 'medium',                     // low | medium | high | critical
  routing: 'smart',                         // local | fast | smart | architect
  searchTerms: ['redirect', 'login', 'useNavigate'],  // TF-IDF keywords
  reasoning: 'Multi-file auth logic, needs context'
}
```

**Routing map**:

| Routing value | Model alias | Khi nào |
|---------------|-------------|---------|
| `local` | `local-heavy` | Offline, read-only, no cloud needed |
| `fast` | `fast` (Gemini Flash) | 1 file change, explicit simple requirement |
| `smart` | `smart` (Gemini Flash*) | Multi-file, debug, design discussion |
| `architect` | `architect` (Opus 4.6) | System-wide, major refactor, DB schema |

*smart hiện map sang Gemini Flash (ADR-0011)

**Cache**: LRU 50 entries, key = `prompt.slice(0, 200)`. Tránh re-analyze cùng prompt trong session.

**Fallback chain**:
1. local-classifier (Qwen 1.5B tại LM Studio) — 3s timeout
2. cheap (GPT-5.4 Mini) — 5s timeout
3. Pattern matching fallback (regex, no API call)

---

## 4. MemoryStore (`lib/memory.js`)

**Vai trò**: Tích lũy kinh nghiệm giữa các session — append-only JSONL với TF-IDF search.

### Entry types

```js
{
  type: 'lesson',     // Auto-save khi task success
  type: 'gotcha',     // Auto-save khi lỗi lặp >= 3 lần (SelfHealer)
  type: 'manual',     // User/agent gọi memory_save tool
  type: 'fact'        // Project fact (stack, patterns, decisions)
}
```

### Entry schema

```js
{
  id: 'mem_abc123',
  type: 'lesson',
  timestamp: '2026-04-20T10:00:00.000Z',
  prompt_summary: 'Fix auth redirect bug',  // max 300 chars
  summary: 'Dùng useNavigate replace=true để prevent back button issue', // max 500 chars
  files_changed: ['src/auth/login.tsx'],
  iterations: 8,
  model: 'cheap',
  tags: []  // optional
}
```

### API

```js
store.append(entry)                    // Ghi memory mới
store.search(query, topK=5)           // TF-IDF search → [{ ...entry, _score }]
store.list({ limit, type })           // List entries (reverse chronological)
store.getStats()                      → { total, byType, path }
store.clear()                         // Xóa tất cả (dùng /memory clear)
store.crossProjectSearch(query, opts) // Cross-project search
```

### TF-IDF Implementation

```
Preprocess:
  1. Lowercase
  2. Remove stop words (EN + VI bilingual)
  3. Tokenize (word + số)
  4. Stemming đơn giản (strip trailing -ing, -ed, -s)

Scoring:
  tf = count(term in doc) / total_terms(doc)
  idf = log(total_docs / docs_with_term)
  score = Σ(tf × idf) cho mỗi term trong query

Performance:
  < 100 entries → inline computation
  >= 100 entries → WorkerPool (node:worker_threads)
  Worker pool reuse across search calls
```

---

## 5. BudgetTracker (`lib/budget.js`)

**Vai trò**: Per-session USD cost tracking với hard cap.

### Model prices (per 1M tokens)

| Alias | Input | Cached | Output |
|-------|-------|--------|--------|
| `smart` | $0.30 | $0.075 | $1.50 |
| `opus` | $15.00 | $3.75 | $75.00 |
| `cheap` | $0.15 | $0.0375 | $0.60 |
| `fast` | $0.075 | — | $0.30 |
| `default` | $0.30 | — | $0.90 |
| `local-*` | $0 | — | $0 |

### API

```js
budget.record(model, {
  prompt_tokens: 1000,
  cache_creation_input_tokens: 200,
  cache_read_input_tokens: 800,
  completion_tokens: 400
})

budget.isExceeded()   → boolean
budget.getStats()     → { spent_usd, cap_usd, calls, exceeded }
budget.enforceHardCap(taskId, projectedCostUSD)  // throws BudgetExceededError
```

---

## 6. StuckDetector (`lib/stuck-detector.js`)

**Vai trò**: Phát hiện agent lặp vòng tool call — inject warning trước khi hết iterations.

### 3 Patterns Detected

**Pattern 1: Toggle** (`[A, B, A, B, A]`)
```
Condition: window 5+ tool calls, cùng 2 signature luân phiên
Example: edit_file('auth.ts') → test fails → edit_file('auth.ts') → test fails...
Warning: "Detected toggle between X and Y. Try different approach."
```

**Pattern 2: Repeat**
```
Condition: cùng signature >= 3 lần trong window 8
Example: search_files('login') 4 lần liên tiếp
Warning: "Called X {n} times with same args. Results won't change."
```

**Pattern 3: Redundant Read**
```
Condition: read_file(path) sau khi search/glob đã trả path này
Example: glob('*.ts') → tìm thấy auth.ts → read_file('auth.ts') mà không cần
Warning: "auth.ts found in previous search. Content may be inferred."
(Note: Chỉ warn, không block — đôi khi đọc lại là cần thiết)
```

**Behavior**: Không abort — chỉ inject `[System reminder]` message. Agent còn cơ hội tự điều chỉnh.

---

## 7. SelfHealer (`lib/self-healer.js`)

**Vai trò**: Học từ runtime errors — tự động ghi `gotcha`, suggest workaround.

### observe() flow

```js
selfHealer.observe(toolName, args, result)
// result.success === false → track error streak

streakMap['edit_file:{"path":"auth.ts"}'] = {
  count: 3,
  lastError: 'pattern not found',
  firstSeen: timestamp
}

// count >= 3 → auto-save gotcha:
memoryStore.append({
  type: 'gotcha',
  summary: '[edit_file] pattern not found (3x): "old_string" không tồn tại',
  files_changed: ['auth.ts']
})
→ push suggestion: "edit_file failed 3x with pattern not found.
   Try read_file first to verify exact content before editing."

// Khi success sau streak → save recovery pattern:
memoryStore.append({
  type: 'lesson',
  summary: 'Recovery: edit_file failed 3x, read_file → verified content → retry succeeded'
})
```

### getStats()

```js
{
  observed: 42,           // Tổng lần observe
  gotchas_saved: 3,       // Auto-saved gotchas
  recoveries_saved: 1,    // Recovery patterns saved
  active_streaks: 2,      // Tool signatures đang trong streak
  pending_suggestions: 1  // Đang chờ inject vào loop
}
```

---

## 8. ContextGuard (`lib/context-guard.js`)

**Vai trò**: Anti-hallucination — cross-check summary với ground truth từ tool calls.

### Ground Truth Tracking

```
write_file/edit_file → actualChanges.add(path)
read_file → actualReads.add(path)
execute_command → commandsExecuted.push({ command, exit_code })
```

### verify() — Kiểm tra khi task_complete

```js
guard.verify("Fixed auth.ts and updated tests")
→ {
  issues: [
    {
      type: 'unverified_claim',
      severity: 'warning',
      message: 'Summary mentions "updated tests" but test files not in actualChanges'
    }
  ],
  verified: ['auth.ts write confirmed'],
  ground_truth: { files_changed: ['auth.ts'], files_read: 3, commands: 2 }
}
```

**Issue types**:
- `unverified_claim`: Summary nói đã sửa X nhưng X không trong actualChanges
- `file_not_read`: Summary nói đã đọc X nhưng X không trong actualReads
- `unexecuted_command`: Summary nói đã chạy test nhưng không có execute_command

**Behavior**: Không block — chỉ warn sau khi print result. Agent không biết về warn này.

---

## 9. RagPromptBuilder (`lib/rag-prompt-builder.js`)

**Vai trò**: Enrich system prompt cho local model và stage roles với relevant examples.

### shouldApplyRag()

```js
builder.shouldApplyRag({ modelId: 'qwen2.5-7b', agentRole: 'builder' })
→ {
  apply: true,
  reason: 'local model — needs few-shot examples'
}

builder.shouldApplyRag({ modelId: 'cheap', agentRole: 'builder' })
→ {
  apply: false,
  reason: 'cloud model at execute stage — RAG net-negative'
}

builder.shouldApplyRag({ modelId: 'cheap', agentRole: 'planner' })
→ {
  apply: true,
  reason: 'stage role=planner — thinking stage benefits from RAG'
}
```

**Stage roles** (apply RAG): `scanner`, `planner`, `reviewer`, `debugger`, `docs`
**Execute roles** (skip RAG): `builder`, `fe-dev`, `be-dev`, `architect`

### build()

```js
const enrichedPrompt = await builder.build({
  basePrompt: systemPrompt,
  userMessage: 'Sửa bug login',
  modelId: 'qwen2.5-7b',
  agentRole: 'planner'
})
```

**Injected sections**:
1. Stack profile (từ `.orcai/knowledge/stack-profile.json`)
2. Embedding examples (cosine similarity >= 0.55, top-3)
3. Decision hints (từ `.orcai/knowledge/graphs/_decision-hints.md`)

**Cost**: +1-3K tokens/call. Chỉ apply khi có impact dương.

---

## 10. SessionContinuity (`lib/session-continuity.js`)

**Vai trò**: Persist in-flight state để resume sau crash/budget-exceeded.

### State schema

```js
{
  id: 'ses_abc123',
  turn: 5,
  activeDecisions: ['use JWT RS256', 'auth via cookie'],
  openTasks: ['edit:src/auth.ts', 'run tests'],
  inFlightFiles: ['src/auth.ts', 'tests/auth.test.ts'],
  lastTraceId: 'trace_xyz',
  nextStep: 'Verify test pass sau khi sửa useNavigate',
  gitHead: 'abc123def',
  errorsSeen: ['pattern not found'],
  modelsUsed: ['cheap'],
  updatedAt: '2026-04-20T10:30:00Z'
}
```

### Resume flow

```
SessionContinuity.loadPreviousSession({ project, maxAgeMs: 4hr })
→ Check git divergence:
    currentHead !== snapshot.gitHead → "Repository changed since last session"
    commitsAhead > 0 → "3 commits ahead — context may be stale"
    filesChanged (git status) ∩ inFlightFiles → "In-flight files modified externally"
→ Return context block cho system prompt:
    "Đang resume session. Open tasks: [...]. Next step: [...]"
```

### Auto-snapshot

```
snapshotEveryTurns: 5  // Default
→ Mỗi 5 turns: atomic write (tmp + rename) → .orcai/sessions/{id}.json
→ Mỗi 10 turns: bridge summary to Hermes memory
```

---

## 11. TokenManager (`lib/token-manager.js`)

**Vai trò**: Quản lý context window — tránh overflow, tối ưu cho prompt cache.

### Trim strategy

```
Trigger: usage_percent > 50% OR messages > 80

Algorithm:
1. Luôn giữ messages[0] (system message)
2. Tóm tắt tool results > 5000 chars:
   content = "[Tool result summarized: {n} chars]"
3. Drop oldest non-system messages theo priority:
   - Prefer giữ recent messages
   - Prefer giữ assistant messages có text (context)
   - Drop tool messages trước

Target: trim về 40% budget (51200 tokens trong 128K context)
```

### estimateTokens()

```js
// Approximation: 1 token ≈ 4 chars
tokenManager.estimateTokens(messages)
→ 15420

tokenManager.getUsage(messages)
→ { estimated_tokens: 15420, usage_percent: 12.1, over_limit: false }
```
