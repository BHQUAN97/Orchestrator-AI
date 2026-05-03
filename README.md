# AI Orchestrator v2.3

[![CI](https://github.com/BHQUAN97/ai-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/BHQUAN97/ai-orchestrator/actions/workflows/ci.yml)
![tests](https://img.shields.io/badge/tests-533%20passing-brightgreen)
![tools](https://img.shields.io/badge/tools-61-blue)

Multi-model AI coding agent system: **Hermes Brain** (memory, learning, self-improve) + **Orchestrator Hands** (scan, plan, route, execute).

Includes `orcai` CLI — a coding agent similar to Claude Code that routes tasks to optimal models: GPT-5.4 Mini (workhorse — fe/be/debug/docs), Gemini 3 Flash (review/dispatch), DeepSeek V4 Pro (architecture). Reduces token cost by 70-95% compared to a single premium model.

## Architecture

```
User Request (CLI / API / WebUI)
     |
  Hermes (Brain) — memory, learning, self-improve
     |
  Orchestrator (Hands) — scan → plan → route → execute
     |
  Dispatcher (Gemini 3 Flash — direct Google quota)
     |
     v
  Execution Plan (subtasks + model assignment)
     |
  Tech Lead (GPT-5.4 Mini) ← review/approve/modify plan
     |                       ← handle escalations from dev agents
     v
  Context Manager ← normalize context to structured JSON
     |               every model receives the SAME context
     v
  +----------+----------+----------+
  |          |          |          |
FE Dev    BE Dev    Reviewer   Debugger
(GPT-mini)(GPT-mini)(Gemini)  (GPT-mini)
  |          |          |          |
  +----------+----------+----------+
     |
  Decision Lock ← lock API contracts, DB schemas, auth flows
     |              agents cannot override locked decisions
     v
  Synthesizer (Gemini 3 Flash) ← merge all results
     |
     v
  Final Output
```

## Key Features

### OrcAI CLI
Coding agent with interactive and one-shot modes:

```bash
orcai "sua bug login"                    # One-shot mode
orcai -i                                 # Interactive mode
orcai -p /path/to/project "them feature" # Specify project
orcai --model smart "refactor auth"      # Choose model
```

### Multi-Model Routing
Each agent role maps to the most cost-effective model (per `AGENT_ROLE_MAP` in `router/orchestrator-agent.js`):

| Agent Role | Model | Cost/1M in/out | Specialty |
|---|---|---|---|
| `dispatcher` | Gemini 3 Flash | $0.15 / $0.60 | Task analysis, result synthesis |
| `architect` | DeepSeek V4 Pro | ~$2-5 / ~$8-15 | System design, kien truc (~2% workload) |
| `tech-lead` | GPT-5.4 Mini | $0.15 / $0.60 | Plan review, escalation (100% R-tier pass) |
| `planner` | GPT-5.4 Mini | $0.15 / $0.60 | Plan generation, stage-RAG auto-inject |
| `fe-dev` | GPT-5.4 Mini | $0.15 / $0.60 | React, Next.js, Vue, CSS, Tailwind |
| `be-dev` | GPT-5.4 Mini | $0.15 / $0.60 | NestJS, Express, DB, SQL, API |
| `reviewer` | Gemini 3 Flash | $0.15 / $0.60 | Code review, OWASP scan |
| `debugger` | GPT-5.4 Mini | $0.15 / $0.60 | Multi-file trace, root cause analysis |
| `scanner` | GPT-5.4 Mini | $0.15 / $0.60 | Project scan, file discovery |
| `docs` | GPT-5.4 Mini | $0.15 / $0.60 | Documentation, JSDoc, README |
| `builder` | GPT-5.4 Mini | $0.15 / $0.60 | General implementation (100% A+B pass) |

**Note:** Claude Sonnet 4.6 removed 2026-04-18; Claude Opus moved to `opus-legacy` (opt-in only) 2026-04-20 — DeepSeek V4 Pro (`architect`) provides comparable quality at 1/5th the cost. For long-context (>400K): use `qwen3-plus` (1M ctx, $0.26/1M). See `docs/MODEL-COMPARISON.md`.

### Hermes Brain + Orchestrator Hands
- **Hermes** (Brain): memory, vector DB, auto-learn, self-improve — decides WHAT to do
- **Orchestrator** (Hands): scan, plan, route, execute — decides HOW to do it

### Tech Lead Agent
GPT-5.4 Mini acts as Tech Lead — reviews execution plans before dev agents run:
- **Quick review** (free, no API call): catches model misassignment, circular deps, oversized tasks
- **Full review** (API call): deep analysis when quick review finds multiple issues
- **Escalation handler**: when dev agents get stuck, Tech Lead provides guidance

### Decision Locking
Prevents agents from overriding each other's decisions:
- Tech Lead locks critical decisions (API contracts, DB schemas, auth flows)
- Dev agents receive locked decisions in their context
- Attempting to modify a locked scope triggers automatic escalation

### Escalation System
Dev agents automatically escalate to Tech Lead when:
1. Analysis takes too long without a clear solution
2. Need to change API contract or database schema
3. Bug spans > 3 files with unclear root cause
4. Conflict with a locked decision
5. Architecture change needed
6. Security implications unclear

### Context Normalization
All agents receive context as structured JSON:
- Every model parses the same data structure identically
- Includes: project metadata, task info, locked decisions, spec/plan, previous results
- Output normalization: standardizes results before passing to next agent

### Claude Code Parity (v2.3)

Tool suite mo rong len **61 tools** — ngang voi Claude Code + tool rieng cho Windows.

**Tool breakdown (61):** core 26 (read/write/edit/glob/grep/web/exec/bg/memory/todo/spawn_subagent...) · AST 4 (parse/find_symbol/find_usages/rename_symbol) · git_advanced 1 (8 subactions) · embedding 4 (index/search/stats/clear) · research 4 (github_code/github_issue/npm_info/deep_research) · screenshot 3 (capture_screen/window/list_monitors) · Windows-native 22 (ps_command/everything_search/clipboard/event_log/wmi_query/wsl_exec/winget/sys_info + registry x4 + tasks x6 + services x6).

**MCP support (day du):**
- stdio + SSE transport (spec 2024-11-05)
- Auto-inherit MCP server tu `~/.claude.json` va `~/.claude/settings.json` — dung lai cau hinh cua Claude Code (playwright, context7, github, linear, notion, filesystem, memory, brave-search...)
- Slash commands: `/mcp list | tools <srv> | enable <srv> | disable <srv> | call <mcp__s__t> <json>`
- Per-project override qua `.orcai/mcp.json`

**Windows-native tools (9):**
| Tool | Muc dich |
|---|---|
| `ps_command` | Chay PowerShell script (base64 encode, timeout, 100KB truncate) |
| `everything_search` | Search file bang Everything (voidtools) — nhanh hon grep 100x; fallback Get-ChildItem |
| `clipboard_read` / `clipboard_write` | Doc/ghi clipboard |
| `event_log` | Windows Event Log (filter level, source, since_minutes) |
| `wmi_query` | Get-CimInstance (Win32_Process, Win32_Service, Win32_LogicalDisk...) |
| `wsl_exec` | Passthrough bash vao WSL distro |
| `winget_search` | Tim package qua winget |
| `sys_info` | CPU/RAM/disk/GPU nhanh ~1s |

**AST refactor (cross-platform, JS/TS):**
- `ast_parse` — parse file → symbol list (functions, classes, exports)
- `ast_find_symbol` — tim reference trong 1 file (decl + usages, bo qua property access)
- `ast_find_usages` — tim xuyen nhieu file (max 100) cho impact analysis
- `ast_rename_symbol` — rename bang AST binding (dry-run mac dinh)
- Can: `@babel/parser`, `@babel/traverse`, `@babel/generator` (optional deps)

**Git structured ops:**
- `git_advanced` 1 tool / 8 action: `blame | log | diff | stash | branch | status | show | cherry_pick`
- Destructive ops (`push`, `reset --hard`, `rebase`) → tu choi, chi dinh `execute_command`

**Screenshot → Vision pipeline (Windows):**
- `capture_screen` — full/monitor index/region; tra ve file path + base64
- `capture_window` — chup cua so theo title (EnumWindows + GetWindowRect)
- `list_monitors` — enumerate display
- Integrate voi `/api/vision` (Gemini Flash) co san cho pipeline debug UI

**Semantic search (API-based, no Python):**
- `embed_index` — chunk + embed file qua LiteLLM (`text-embedding-3-small` ~$0.03 / 500 files)
- `embed_search` — cosine similarity, top-K, regex path filter
- `embed_stats` / `embed_clear` — quan ly store `.orcai/embeddings/`

**Performance (Phase 3):**
- Worker pool `node:worker_threads` — TF-IDF chay parallel tren CPU cores
- 2-tier RAM cache (Map LRU + spill `%LOCALAPPDATA%\orcai\cache`)
- Auto-concurrency dua tren `os.freemem()` + `os.cpus()` (cpu_bound / io_bound / llm_call)
- Native `fs.watch({recursive: true})` voi 200ms debounce — opt-in qua `--watch`
- Memory `searchAsync()` offload worker khi docs ≥ 100 (fallback inline neu worker fail)

## Testing

```bash
npm test          # 164 tests (core smoke, ~10s)
npm run test:all  # 533 tests, 16 files (full regression, ~90s)
```

CI (`.github/workflows/ci.yml`): Node 18 + 20 matrix tren Ubuntu, Windows job rieng chay `test/windows-tools.test.js`.

Docs them: [docs/PLAN-MODE.md](docs/PLAN-MODE.md), [docs/HOOKS.md](docs/HOOKS.md), [docs/adr/](docs/adr/) (10 ADR).

## Benchmark

E2E benchmark harness: `benchmark/` (runner + verify + scorer).

```bash
# Dry run harness (khong goi LLM)
node benchmark/runner.js --tier A --dry-run

# Full run — 5 A-tier task x model (chon tu default/cheap/smart/fast/gemini)
node benchmark/runner.js --tier A --model cheap

# Matrix run — multi model
node benchmark/runner.js --tier A --model gemini,default,cheap,smart

# Report
node benchmark/scorer.js benchmark/results/<latest>.jsonl
```

**Latest result (2026-04-18, 5 A-tier × 4 model — pre-v2.3 lineup)**:

| Model | Pass | % | Avg wall | Notes |
|---|---|---|---|---|
| cheap (GPT-5.4-mini) | 4/5 | **80%** | 7.4s | cost-perf winner |
| gemini (direct) | 3/5 | 60% | 53s | free quota 20/day |
| default (DeepSeek V3.2) | 2/5 | 40% | 33s | |
| smart (Sonnet 4.6) | 2/5 | 40% | 3.6s | harness bug hits |

Chi tiet: [benchmark/results/2026-04-18-analysis.md](benchmark/results/2026-04-18-analysis.md). Plan 25 task: [docs/BENCHMARK-PLAN.md](docs/BENCHMARK-PLAN.md).

## Project Structure

```
ai-orchestrator/
|-- .env.example              # API keys template (copy to .env)
|-- .gitignore
|-- package.json              # CLI + dependencies
|-- docker-compose.yaml       # Services: LiteLLM, Orchestrator, Analytics, Gateway (5002-5005)
|-- docker-compose.agent.yaml # Coding agent sandbox (optional)
|-- Dockerfile.agent          # Agent container image
|-- litellm_config.yaml       # Model routing + fallback + budget (v2.3: DS V4 + Gemini 3 Flash)
|
|-- bin/                      # CLI entry point
|   +-- orcai.js              # `orcai` command
|
|-- lib/                      # Core agent engine
|   |-- agent-loop.js         # Main agent loop (think → tool → verify)
|   |-- orchestrator-v3.js    # Orchestrator v3 engine
|   |-- config.js             # Configuration management
|   |-- conversation-manager.js # Conversation history
|   |-- repo-mapper.js        # Repository structure mapping
|   |-- token-manager.js      # Token counting + budget
|   +-- auto-verify.js        # Auto-verify tool results
|
|-- tools/                    # Agent tools (file, terminal, etc.)
|   |-- definitions.js        # Tool definitions for LLM
|   |-- executor.js           # Tool execution engine
|   |-- file-manager.js       # Read/write/edit files
|   +-- terminal-runner.js    # Run shell commands
|
|-- src/                      # Server-side
|   |-- api-server.js         # Orchestrator REST API
|   +-- auth.ts               # Authentication
|
|-- router/                   # Orchestration modules
|   |-- orchestrator-agent.js # Plan -> review -> execute -> escalation
|   |-- smart-router.js       # Score-based model selection
|   |-- context-manager.js    # Structured context injection
|   |-- decision-lock.js      # Decision registry (lock/unlock/validate)
|   |-- tech-lead-agent.js    # Tech Lead: review, approve, escalation
|   +-- test-router.js        # Tests
|
|-- prompts/                  # Agent prompt templates
|   |-- tech-lead.md
|   |-- fe-dev.md
|   |-- be-dev.md
|   |-- reviewer.md
|   |-- debugger.md
|   +-- scanner.md
|
|-- graph/                    # Trust Graph (context reduction)
|   |-- trust-graph.js        # Build dependency graph
|   |-- query.js              # Query related files
|   +-- watcher.js            # Auto-reindex on file change
|
|-- cache/                    # Context caching
|   +-- context-cache.js      # LRU cache with file-hash invalidation
|
|-- analytics/                # Cost tracking
|   |-- tracker.js
|   |-- api-server.js
|   +-- dashboard.html
|
|-- dashboard/                # Web dashboard
|   |-- index.html
|   +-- serve.js
|
|-- scripts/                  # Setup & utility scripts
|   |-- setup-agent.sh        # Setup (Linux/Mac)
|   |-- setup-agent.bat       # Setup (Windows)
|   |-- start.bat             # Start services (Windows)
|   |-- stop.bat              # Stop services (Windows)
|   +-- cli.sh                # CLI wrapper
|
|-- skills/                   # Hermes agent skills
|-- docs/                     # Documentation
|   |-- GUIDE.md              # Full guide
|   |-- MODEL-COMPARISON.md   # Model comparison
|   |-- UPGRADE-PLAN.md       # Upgrade plan
|   |-- PORTS.md              # Port allocation
|   +-- model-routing-map.md  # Task-to-model mapping
|
|-- .roomodes                 # Roo Code custom modes (7 modes)
+-- .roo/rules/               # Roo Code rules per mode
```

## Setup

### Prerequisites
- Docker Desktop
- Node.js 18+
- Git

### Option A: Docker (recommended)

```bash
git clone https://github.com/BHQUAN97/Orchestrator-AI.git
cd Orchestrator-AI

# Configure API keys
cp .env.example .env
# Edit .env — add at least one provider key

# Start all services
docker compose up -d

# Verify
docker compose ps
```

### Option B: Local CLI

```bash
git clone https://github.com/BHQUAN97/Orchestrator-AI.git
cd Orchestrator-AI

# Run setup script
./scripts/setup-agent.sh    # Linux/Mac
scripts\setup-agent.bat     # Windows

# Use CLI
orcai --help
orcai -i            # Interactive mode
```

### API Keys

You need at least ONE provider key. **OpenRouter** is recommended (1 key = 200+ models):

| Provider | Sign up | Free tier |
|---|---|---|
| **OpenRouter** (recommended — GPT-5.4 Mini, Opus, DeepSeek, Qwen...) | openrouter.ai/keys | $5 free credit |
| Google Gemini (direct — `fast`/`smart`/`gemini` aliases) | aistudio.google.com/apikey | Yes (20 req/day free) |
| DeepSeek (optional — `default` fallback) | platform.deepseek.com/api_keys | Yes |
| Anthropic (optional — `architect` direct) | console.anthropic.com/settings/keys | No |

### Services (Docker)

| Service | Port | URL | Description |
|---|---|---|---|
| LiteLLM Gateway | 5002 | http://localhost:5002 | API gateway + model routing |
| Orchestrator API | 5003 | http://localhost:5003 | REST API (scan/plan/execute) |
| Analytics Dashboard | 5004 | http://localhost:5004 | Cost tracking + monitoring |
| **Gateway + Portal** | **5005** | **http://localhost:5005/portal** | **Login + mobile-friendly dashboard (auth, voice, SSE live)** |

### Portal (v2.2 — recommended UI)

Sau khi `docker compose up -d`, mở `http://localhost:5005` (login admin/admin trong dev) → portal tích hợp:
- **Quick Run**: project selector, task type, voice input (vi-VN), dry-run, estimate, run, cancel
- **Live SSE stream**: theo dõi pipeline real-time (classify → scan → plan → execute)
- **Templates**: lưu/load prompt thường dùng (`fix-mobile`, `add-jsdoc`...)
- **History**: 10 run gần nhất, click để re-run
- **Snapshots**: rollback git stash khi agent edit sai
- **Active runs**: cancel task đang chạy (3s poll)

## Usage

### Via OrcAI CLI

```bash
# Interactive mode
orcai -i

# One-shot
orcai "build login page with JWT auth"

# Specify project and model
orcai -p /path/to/project --model smart "refactor auth module"
```

### Via Orchestrator API

Direct (port 5003 — no auth in dev) hoặc qua gateway (port 5005 — cookie auth, recommended):

```bash
# === Core endpoints ===
# Full flow: scan → plan → review → execute
curl -X POST http://localhost:5003/api/run \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Build login page with JWT auth", "project": "FashionEcom"}'

# Dry-run: plan + estimate KHÔNG execute (8× faster, an toàn test)
curl -X POST http://localhost:5003/api/run \
  -d '{"prompt": "fix mobile button", "files": ["src/auth.ts"], "dry": true}'

# Check budget
curl http://localhost:5003/api/budget
curl http://localhost:5003/health

# === Utility endpoints (v2.2) ===
# Estimate cost trước khi run (heuristic, ~500ms)
curl -X POST http://localhost:5003/api/estimate \
  -d '{"prompt": "refactor auth", "task": "refactor"}'

# History 20 run gần nhất, filter theo project
curl "http://localhost:5003/api/history?limit=20&project=FashionEcom"

# Active runs đang chạy (cho cancel)
curl http://localhost:5003/api/runs

# Cancel task đang chạy
curl -X DELETE http://localhost:5003/api/run/<traceId>

# Live SSE stream pipeline progress (chấp nhận cả run-... lẫn trc-... id)
curl -N http://localhost:5003/api/stream/<traceId>

# Templates CRUD
curl http://localhost:5003/api/templates                      # list
curl -X POST http://localhost:5003/api/templates \
  -d '{"name":"fix-mobile","prompt":"...","task":"fix"}'      # save
curl -X DELETE http://localhost:5003/api/templates/fix-mobile # delete

# Rollback git stash snapshot (sau khi agent edit sai)
curl http://localhost:5003/api/rollback/list?project=FashionEcom
curl -X POST http://localhost:5003/api/rollback \
  -d '{"project":"FashionEcom","hash":"abc123de"}'

# === Vision (analyze image — Gemini 3 Flash, ~3s, ~$0.0004/call) ===
# Phan tich screenshot UI bug, diagram, error message...
curl -X POST http://localhost:5003/api/vision \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Sua bug layout trong screenshot",
    "images": ["data:image/jpeg;base64,/9j/4AAQ..."]
  }'
# Response: { success, analysis, model, tokens, elapsed_ms, budget }
# Constraints: max 4 images, 5MB/image, format jpeg/png/webp/gif

# === Vision + Run combo — phan tich anh + tu dong sua code ===
# Step 1: vision analyze → Step 2: orchestrator.run() voi enriched prompt
curl -X POST http://localhost:5003/api/vision-run \
  -d '{"prompt":"Fix bug trong screenshot","files":["src/Login.tsx"],
       "images":["data:image/jpeg;base64,..."],"project":"FashionEcom"}'
# Hoac dry-run de chi xem plan: them "dry": true

# === GitHub auto-PR (yeu cau GH_TOKEN env) ===
curl -X POST http://localhost:5003/api/pr \
  -d '{"project":"FashionEcom","base":"main"}'
# Tu lay title tu last commit, body tu commit list. Tu git push -u origin.
# Refuse PR khi current branch = main/master.
```

### Environment variables (v2.2 mới)

| Var | Default | Mô tả |
|---|---|---|
| `BUDGET_TZ` | `Asia/Ho_Chi_Minh` | Timezone reset budget (tránh container UTC) |
| `DECISION_LOCK_TTL_HOURS` | `4` | TTL của decision lock (giảm từ 24h) |
| `LITELLM_TIMEOUT_MS` | `90000` | Timeout/call LiteLLM (chống fetch hang) |
| `RATE_MAP_MAX` | `10000` | Max IP entries trong rate-limit map |
| `NOTIFY_WEBHOOK_URL` | — | Slack/Discord webhook khi run complete + rollback |
| `AUTH_USERNAME/PASSWORD/JWT_SECRET` | (admin/admin/dev) | Production REQUIRES set, không dùng default |
| `VISION_MAX_TOKENS` | `2000` | Max tokens cho vision response (giảm nếu hết credit) |
| `GH_TOKEN` | — | GitHub Personal Access Token cho `/api/pr` (gh CLI auth) |

### Via LiteLLM API directly

```bash
curl http://localhost:5002/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

Model aliases (see `litellm_config.yaml`): `default` (DeepSeek V4 Flash), `cheap`/`gpt-mini` (GPT-5.4 Mini — workhorse), `fast`/`smart`/`gemini` (Gemini 3 Flash), `architect` (DeepSeek V4 Pro), `opus-legacy` (Claude Opus 4.6 — opt-in only), `qwen3-plus` (1M ctx), `qwen3-coder-flash`, `qwen3-max`. Free tier: `free-qwen`, `free-llama`, `free-glm`, `free-minimax`, `free-gpt-oss`. Local (LM Studio): `local-classifier`, `local-workhorse`, `local-heavy`, `local-embed`.

### Coding Agent Sandbox (Docker)

```bash
# Build and run coding agent in container
docker compose -f docker-compose.yaml -f docker-compose.agent.yaml up coding-agent

# Or run one-off
docker compose -f docker-compose.agent.yaml run --rm coding-agent
```

### With Roo Code (VS Code)

This project includes 7 custom Roo Code modes with escalation rules:

| Mode | Role | Escalation |
|---|---|---|
| `tech-lead` | Review plans, approve decisions | N/A (top of chain) |
| `spec` | Write specifications | - |
| `build` | Implement features | -> tech-lead when stuck |
| `review` | Code review, security audit | -> tech-lead on Critical findings |
| `debug` | Debug and fix bugs | -> tech-lead on complex bugs |
| `docs` | Write documentation | - |
| `seed` | Generate test data | - |

## Model Routing

### How the Smart Router works

The router scores each model based on 5 factors:
1. **Task match** (40%): task type strengths alignment
2. **File domain** (25%): frontend/backend/database file detection
3. **Keywords** (20%): prompt keyword analysis
4. **Context size** (constraint): penalize if context exceeds model limit
5. **Cost** (10%): bonus for cheaper models

### Fallback chain (automatic via LiteLLM)

```
default:      DeepSeek V4 Flash (OpenRouter)
cheap:        GPT-5.4 Mini (OpenRouter)           ← workhorse alias
gpt-mini:     GPT-5.4 Mini (OpenRouter)           ← backward-compat alias of cheap
fast:         Gemini 3 Flash (Google direct)      ← pin primary
smart:        Gemini 3 Flash (Google direct)      ← retargeted 2026-04-18 (was Sonnet)
gemini:       Gemini 3 Flash (Google direct)      ← backward-compat alias of fast
fast-or:      Gemini 3 Flash (OpenRouter)         ← use when Google quota exhausted
architect:    DeepSeek V4 Pro (OpenRouter)        ← SA / design only (v2.3, was Opus)
opus-legacy:  Claude Opus 4.6 (OpenRouter)        ← opt-in only, expensive
qwen3-plus:   Qwen 3.5 Plus (OpenRouter, 1M ctx)
```

**Removed 2026-04-18:** `sonnet` alias (Claude Sonnet 4.6) — replaced by `cheap` for reasoning/review.
**Changed 2026-04-20:** `architect` retargeted from Opus 4.6 → DeepSeek V4 Pro (comparable quality, ~1/5 cost). Opus available via `opus-legacy`.

## Configuration

### Budget control

In `litellm_config.yaml`:
```yaml
general_settings:
  max_budget: 5.0        # Max $5 per day
  budget_duration: "1d"
```

### Add a new model

1. Add to `litellm_config.yaml`:
```yaml
- model_name: "my-model"
  litellm_params:
    model: "provider/model-name"
    api_key: "os.environ/MY_MODEL_KEY"
```

2. Add profile to `router/smart-router.js` in `MODEL_PROFILES`

3. Restart: `docker compose restart litellm`

## Troubleshooting

**Services won't start:**
```bash
docker compose logs <service-name>
# Common: YAML syntax error, missing env var, port conflict
```

**Model returns errors:**
```bash
# Check health
curl http://localhost:5002/health -H "Authorization: Bearer $LITELLM_MASTER_KEY"
# List models
curl http://localhost:5002/v1/models -H "Authorization: Bearer $LITELLM_MASTER_KEY"
```

**Escalation loops:**
- Check `MAX_ESCALATIONS_PER_TASK` in orchestrator-agent.js (default: 3)
- Review escalation history: `orchestrator.techLead.getStats()`

## License

MIT
