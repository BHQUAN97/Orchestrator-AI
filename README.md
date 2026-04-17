# AI Orchestrator v2.2

Multi-model AI coding agent system: **Hermes Brain** (memory, learning, self-improve) + **Orchestrator Hands** (scan, plan, route, execute).

Includes `orcai` CLI — a coding agent similar to Claude Code that routes tasks to optimal models: Kimi K2.5 (frontend), DeepSeek (backend), Gemini Flash (review), Claude Sonnet (architecture). Reduces token cost by 70-95% compared to a single premium model.

## Architecture

```
User Request (CLI / API / WebUI)
     |
  Hermes (Brain) — memory, learning, self-improve
     |
  Orchestrator (Hands) — scan → plan → route → execute
     |
  Dispatcher (Gemini Flash — cheapest)
     |
     v
  Execution Plan (subtasks + model assignment)
     |
  Tech Lead (Claude Sonnet) ← review/approve/modify plan
     |                        ← handle escalations from dev agents
     v
  Context Manager ← normalize context to structured JSON
     |               every model receives the SAME context
     v
  +----------+----------+----------+
  |          |          |          |
FE Dev    BE Dev    Reviewer   Debugger
(Kimi)   (DeepSeek) (Gemini)  (Sonnet)
  |          |          |          |
  +----------+----------+----------+
     |
  Decision Lock ← lock API contracts, DB schemas, auth flows
     |              agents cannot override locked decisions
     v
  Synthesizer (Gemini Flash) ← merge all results
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
Each agent role maps to the most cost-effective model:

| Agent Role | Model | Cost/1M tokens | Specialty |
|---|---|---|---|
| `dispatcher` | Gemini Flash | $0.15 | Task analysis, result synthesis |
| `fe-dev` | Kimi K2.5 | $1.00 | React, Next.js, Vue, CSS, Tailwind |
| `be-dev` | DeepSeek | $0.27 | NestJS, Express, DB, SQL, API |
| `reviewer` | Gemini Flash | $0.15 | Code review, OWASP scan |
| `tech-lead` | Claude Sonnet | $3.00 | Architecture, plan review, escalation |
| `debugger` | Claude Sonnet | $3.00 | Complex multi-file debugging |
| `docs` | DeepSeek | $0.27 | Documentation, JSDoc, README |

### Hermes Brain + Orchestrator Hands
- **Hermes** (Brain): memory, vector DB, auto-learn, self-improve — decides WHAT to do
- **Orchestrator** (Hands): scan, plan, route, execute — decides HOW to do it

### Tech Lead Agent
Claude Sonnet acts as Tech Lead — reviews execution plans before dev agents run:
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

## Project Structure

```
ai-orchestrator/
|-- .env.example              # API keys template (copy to .env)
|-- .gitignore
|-- package.json              # CLI + dependencies
|-- docker-compose.yaml       # 6 services (port range 5000-5004)
|-- docker-compose.agent.yaml # Coding agent sandbox (optional)
|-- Dockerfile.agent          # Agent container image
|-- litellm_config.yaml       # Model routing + fallback + budget
|-- hermes_config.yaml        # Hermes agent config
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
| **OpenRouter** (recommended) | openrouter.ai/keys | $5 free credit |
| Google Gemini | aistudio.google.com/apikey | Yes |
| DeepSeek | platform.deepseek.com/api_keys | Yes |
| Moonshot (Kimi) | platform.moonshot.cn/console/api-keys | Yes |
| Anthropic (Sonnet) | console.anthropic.com/settings/keys | No |

### Services (Docker)

| Service | Port | URL | Description |
|---|---|---|---|
| Hermes (Brain) | 5000 | http://localhost:5000 | Agent engine + memory |
| WebUI | 5001 | http://localhost:5001 | Open WebUI chat interface |
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

Model names: `default` (Kimi), `smart` (Sonnet), `fast` (Gemini), `cheap` (DeepSeek)

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
default:  Kimi K2.5 -> OpenRouter/Kimi -> DeepSeek
smart:    Sonnet 4  -> OpenRouter/Sonnet -> Kimi K2.5
fast:     Gemini Flash -> OpenRouter/Gemini -> DeepSeek
cheap:    DeepSeek -> OpenRouter/DeepSeek -> Gemini Flash
```

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
