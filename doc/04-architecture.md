# Thiết kế kiến trúc chi tiết

## 1. Tổng quan hệ thống

```
┌─────────────────────────────────────────────────────────────────┐
│                        NGƯỜI DÙNG                               │
│  Terminal (SSH/WebSocket)  │  Portal (mobile browser)           │
└──────────────┬─────────────────────────┬───────────────────────┘
               │                         │
┌──────────────▼──────────┐   ┌──────────▼──────────────────────┐
│      orcai CLI          │   │    Gateway + Portal (:5005)      │
│  bin/orcai.js           │   │  Auth, SSE streaming, Voice      │
└──────────────┬──────────┘   └──────────┬───────────────────────┘
               │                         │
┌──────────────▼─────────────────────────▼───────────────────────┐
│                     AGENT LAYER                                  │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              AgentLoop (lib/agent-loop.js)               │   │
│  │   ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  │   │
│  │   │RequestAnalyzer│  │HermesBridge │  │ToolExecutor │  │   │
│  │   │ intent/route  │  │route/memory │  │ 61 tools    │  │   │
│  │   └──────────────┘  └──────────────┘  └─────────────┘  │   │
│  │   ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  │   │
│  │   │ StuckDetector│  │ContextGuard  │  │ SelfHealer  │  │   │
│  │   │ loop detect  │  │ hallucination│  │ error learn │  │   │
│  │   └──────────────┘  └──────────────┘  └─────────────┘  │   │
│  │   ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  │   │
│  │   │BudgetTracker │  │ HookRunner   │  │  RAGBuilder │  │   │
│  │   │ cost/cap     │  │ pre/post tool│  │ local model │  │   │
│  │   └──────────────┘  └──────────────┘  └─────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────────┐
│                   LITELLM GATEWAY (:5002)                        │
│   cheap │ fast │ smart │ architect │ local-classifier           │
└──────┬──────┬──────┬──────┬──────────────┬──────────────────────┘
       │      │      │      │              │
   OpenAI  Google DeepSeek Anthropic   LM Studio
  GPT-5.4  Gemini  V3.2   Opus 4.6   Qwen 1.5B/7B
   Mini    Flash
```

---

## 2. Data Flow

### 2.1 Request Pipeline

```
User prompt (string)
│
├── @mention expansion → attach file content
├── slash command check → dispatch hoặc continue
│
▼
RequestAnalyzer.analyze(prompt)
{
  goal: string,           // Mục tiêu ngắn
  needs: string[],        // Files/symbols cần lookup
  changes: string[],      // Files sẽ bị thay đổi
  complexity: 'low'|'medium'|'high'|'critical',
  routing: 'local'|'fast'|'smart'|'architect',
  searchTerms: string[],  // Keywords để TF-IDF search
  reasoning: string
}
│
├── agent.setHintFiles(analysis.changes)
│
▼
HermesBridge.selectModel({ task, prompt, files: _hintFiles })
→ { model: 'cheap', method: 'smart-router', reasons: [...] }
→ agent.model = 'cheap'  (chỉ thay đổi nếu khác model hiện tại)
│
▼
HermesBridge.getRelevantMemories(prompt)
→ { local: Memory[], cross: Memory[] }
→ formatMemoriesForPrompt() → string block
│
▼
buildSystemPrompt() + memoryBlock + lockBlock
→ enrichedSystemPrompt
│
▼
AgentLoop._runLoop()
→ LLM → ToolCalls → Results → LLM → ...
→ task_complete({ summary, files_changed })
```

### 2.2 Message Format (OpenAI-compatible)

```json
[
  { "role": "system", "content": "..." },
  { "role": "user", "content": "fix bug X" },
  { "role": "assistant", "content": null,
    "tool_calls": [{"id": "tc1", "function": {"name": "read_file", "arguments": "{\"path\":\"...\"}"}}] },
  { "role": "tool", "tool_call_id": "tc1", "content": "{\"success\":true,\"content\":\"...\"}" },
  { "role": "assistant", "content": "Done", "tool_calls": [{"function":{"name":"task_complete",...}}] }
]
```

### 2.3 Tool Result Format

```json
{
  "success": true | false,
  "error": "string nếu fail",
  // Tool-specific fields:
  "content": "...",        // read_file
  "path": "...",           // write_file, edit_file
  "replacements": 3,       // edit_file
  "exit_code": 0,          // execute_command
  "stdout": "...",
  "stderr": "..."
}
```

---

## 3. File Structure & Responsibility

### 3.1 `bin/` — CLI Entrypoints

| File | Vai trò |
|------|---------|
| `orcai.js` | Main CLI: interactive + one-shot mode |
| `orcai-build-index.js` | Build embedding index cho RAG |
| `orcai-improve-loop.js` | Self-improvement loop |
| `orcai-index-examples.js` | Index code examples |
| `orcai-loop-start.js` | Start background service loop |
| `orcai-stack-profile.js` | Detect và cache stack profile |
| `orcai-trace.js` | Distributed trace viewer |

### 3.2 `lib/` — Core Modules (57 files)

**Routing & Intelligence**
```
request-analyzer.js     Pre-routing classifier (local-1.5B → cheap fallback)
hermes-bridge.js        SmartRouter + Memory + Decision Lock bridge
```

**Execution**
```
agent-loop.js           Core agentic loop (state machine)
prompt-cache.js         Anthropic cache_control injection
extended-thinking.js    Claude thinking budget management
parallel-executor.js    Read-safe tools → Promise.all
retry.js                fetchWithRetry + rate limit tracking
```

**Memory & Context**
```
memory.js               Append-only JSONL + TF-IDF search
rag-prompt-builder.js   RAG injection for local/stage models
context-guard.js        Anti-hallucination ground truth
token-manager.js        Rolling message trim (80 messages)
conversation-manager.js Conversation history + warm-context
session-continuity.js   Cross-session state persistence
```

**Reliability**
```
stuck-detector.js       Loop/toggle pattern detection
self-healer.js          Auto-learn from runtime errors
auto-verify.js          Auto-run test after edit
budget.js               Cost tracking + hard cap
cost-tracker.js         Persistent daily cost tracking
hooks.js                PreToolUse/PostToolUse/Stop/SessionStart
```

**Infrastructure**
```
repo-mapper.js          Repository structure scan
repo-cache.js           Scan result cache (1hr TTL)
mcp-auto-config.js      Auto-inherit ~/.claude/ MCP config
worker-pool.js          node:worker_threads pool
embeddings.js           Embedding store
semantic-search.js      Cosine similarity search
transcript-logger.js    Session transcript (JSONL)
```

**UI**
```
input-queue.js          Persistent readline (always-on)
markdown-render.js      Terminal markdown (chalk-based)
status-line.js          Model/budget/iteration status
slash-commands.js       Discovery + expansion
skill-matcher.js        Skill suggestion
```

### 3.3 `tools/` — 61 Tools

**Core (26)**
```
read_file, write_file, edit_file, list_files, search_files, glob
execute_command
web_fetch, web_search
spawn_subagent, spawn_team, task_decompose
memory_save, memory_recall
ask_user_question
todo_write, todo_read
create_skill
bg_bash, bg_list, bg_output, bg_kill
batch_edit, edit_files
task_complete
```

**AST (4)**
```
ast_parse, ast_find_symbol, ast_find_usages, ast_rename_symbol
```

**Embedding (4)**
```
embed_index, embed_search, embed_stats, embed_clear
```

**Git Advanced (1, 8 actions)**
```
git_advanced: status, diff, log, branch, checkout, commit, stash, cherry-pick
```

**Screenshot (3)**
```
capture_screen, capture_window, list_monitors
```

**Research (4)**
```
github_code, github_issue, npm_info, deep_research
```

**Windows Native (22)**
```
ps_command, everything_search, clipboard_read/write
event_log_query, wmi_query, wsl_exec, winget_search, sys_info
get_registry, set_registry, create_registry_key, delete_registry_value
list_scheduled_tasks, create_scheduled_task, enable_task, disable_task, delete_task, get_task_info
list_services, get_service, start_service, stop_service, restart_service, set_service_start
```

### 3.4 `router/` — Orchestrator Pipeline

```
orchestrator-agent.js   Full multi-agent pipeline API (:5003)
smart-router.js         Heuristic scoring (5 factors)
slm-classifier.js       LLM-based intent classifier
context-manager.js      Structured JSON context builder
decision-lock.js        Decision registry (.sdd/decisions.lock.json)
tech-lead-agent.js      TechLead: review + escalation
audit-log.js            Audit trail (append-only)
feature-registry.js     Feature flags
```

### 3.5 `prompts/` — System Prompt Templates

```
tech-lead.md, spec.md, build.md, review.md
debug.md, docs.md, seed.md
fe-dev.md, be-dev.md, reviewer.md, debugger.md
scanner.md, developer.md, docs-writer.md
orchestrator.md
```

---

## 4. State Management

### 4.1 Per-Session State (trong AgentLoop)

```
messages: Array          // Rolling conversation (max 80)
iteration: number        // Vòng lặp hiện tại
consecutiveErrors: number // Đếm lỗi liên tiếp
completed: boolean
aborted: boolean
abortReason: string
model: string            // Model hiện tại (có thể thay đổi giữa turns)
_hintFiles: string[]     // Files từ RequestAnalyzer để guide SmartRouter
lastRoutingDecision: object
toolResultCache: Map     // Per-run cache (max 50 entries, LRU)
cacheStats: object       // Tích lũy token stats
```

### 4.2 Persistent State

| File | Format | Vai trò |
|------|--------|---------|
| `.orcai/memory/lessons.jsonl` | JSONL append-only | Experience store |
| `.orcai/sessions/{id}.json` | JSON atomic write | Session continuity |
| `.orcai/sessions/index.jsonl` | JSONL | Session index |
| `.orcai/transcripts/{id}.jsonl` | JSONL | Tool call transcript |
| `.orcai/repo-cache.json` | JSON | Repo scan cache |
| `.orcai/cost-tracker.json` | JSON | Daily cost |
| `.orcai/todos.json` | JSON | Agent todo list |
| `.sdd/decisions.lock.json` | JSON | Decision locks |

### 4.3 In-Memory Cache (không persist)

| Cache | Location | TTL | Eviction |
|-------|---------|-----|---------|
| Repo scan | RepoCache | 1hr / git HEAD change | LRU |
| Tool results | AgentLoop.toolResultCache | Per-run | Max 50, LRU |
| Request analysis | RequestAnalyzer | Per-session | Max 50, LRU |
| Context | `cache/context-cache.js` | File hash | On change |

---

## 5. Concurrency Model

```
AgentLoop._runLoop() — single async loop, chờ LLM + tool results
│
├── Parallel tool execution:
│   isBatchReadSafe(toolCalls)?
│   YES → Promise.all(toolCalls.map(execute))
│          [read_file, search_files, glob, ast_*, embed_*]
│   NO  → for (tc of toolCalls) { await execute(tc) }
│
├── Background tasks:
│   LocalAssistant.bootstrap() — Promise, không await ngay
│   RequestAnalyzer.analyze() — có thể race với main flow
│
├── Worker threads (MemoryStore):
│   entries < 100 → inline TF-IDF (same thread)
│   entries >= 100 → WorkerPool (node:worker_threads)
│
└── Auto-concurrency hint (suggestParallelism):
    dựa trên os.freemem() + os.cpus()
    → { subagent: 3, llm: 2, file_read: 8 }
```

---

## 6. Error Handling

### 6.1 Ralph Wiggum Loop (3 strikes)

```
Lần 1: Tự sửa theo cách hiển nhiên nhất
Lần 2: Thử cách khác (self-correction trong LLM response)
Lần 3: maxConsecutiveErrors >= 3 → abort, báo cáo

SelfHealer.observe() song song:
  Cùng lỗi lặp >= 3 lần → auto-save gotcha
  → inject suggestion vào messages[] NGAY (cùng session, không chờ session sau)
  → agent nhận được hint tại iteration tiếp theo

StuckDetector song song:
  Pattern detect (toggle/repeat/redundant) → MODEL_ESCALATION
  cheap → smart → architect (leo 1 bậc mỗi lần stuck)
  → log onRouting({ method: 'stuck-escalation' })
  → model mạnh hơn có khả năng break pattern
```

### 6.2 LLM Fetch Errors

```
fetchWithRetry():
  retries: 3, base backoff + jitter
  429 → read Retry-After header → wait
  5xx → exponential backoff
  ECONNREFUSED → meaningful error: "LiteLLM không chạy tại {url}"
  ENOTFOUND → "Không resolve được host {url}"
  
Streaming fallback:
  mid-stream error → check partial valid → nếu valid: dùng partial
                  → else: retry streaming (max 1) → fallback non-stream
```

### 6.3 Hook Failures

```
PreToolUse: non-zero exit → BLOCK tool call → return error JSON
PostToolUse: lỗi → ignore (non-blocking)
SessionStart/Stop: lỗi → ignore (non-blocking)
```

---

## 7. Security Model

### 7.1 Tool Permissions

```
permissions.js — role-based:
  builder:   read + write + execute (trong project dir)
  reviewer:  read only
  planner:   read only
  fe-dev:    read + write (*.tsx/*.vue/*.css/*.html)
  be-dev:    read + write (*.ts/*.js/*.py/*.go/*.sql)
  debugger:  read + execute (không write)

readableRoots:  Chỉ read file trong project dir + readableRoots
projectDir:     Working directory constraint
```

### 7.2 Privacy Guard

```
privacy-rules.js → forceLocalForPaths(files):
  .env, secrets.*, *_private.*, credentials.*
  → override model selection → local-heavy
  → file content KHÔNG gửi lên cloud
```

### 7.3 Dangerous Command Guard

```
terminal-runner.js:
  DANGEROUS_PATTERNS: rm -rf, DROP TABLE, format c:, shutdown, ...
  → hỏi confirm (onConfirm callback)
  --no-confirm → skip confirm (dùng với cẩn thận)
```

### 7.4 Diff Approval

```
onWriteApproval callback (interactive mode):
  1. HermesBridge.checkFilePath() → warn nếu trong decision lock scope
  2. Hiển thị unified diff
  3. Hỏi: [y]es / [n]o / [A]ll / [q]uit session
  ApprovalState.autoYes = true nếu --yes flag
```

---

## 8. Performance

### 8.1 Prompt Cache

```
Anthropic cache_control:
  system message → cache_control: { type: 'ephemeral' }
  tool definitions → cache_control: { type: 'ephemeral' }
  
Cost: cached tokens = 10% của fresh tokens
Typical hit rate: 60-85% trong dài hạn session
```

### 8.2 Token Budget

```
maxTokens: 128000 (default, có thể tăng với --max-tokens)
reserveTokens: 4096 (cho output)
Working budget: 128000 - 4096 = 123904

Trim trigger:
  usage_percent > 50% → trim đến 40% budget
  messages > 80 → trim
  
Trim strategy (TokenManager):
  Giữ system message (không trim)
  Tóm tắt tool results > 5000 chars
  Drop oldest non-system messages
```

### 8.3 Repo Cache

```
RepoCache:
  TTL: 1 giờ
  Invalidate: git HEAD thay đổi HOẶC package.json mtime thay đổi
  Content: compact JSON (file tree + descriptions)
  
RepoMapper scan: ~200-500ms cho project 1000 files
RepoCache read: ~2ms (JSON parse)
```
