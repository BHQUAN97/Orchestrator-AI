# OrcAI v2.3 — Huong dan day du

> Multi-model coding agent system — route task sang model phu hop.
> Updated: 2026-05-03 — v2.3 lineup (DeepSeek V4 + Gemini 3 Flash)
> Dung ket hop voi Claude Code — KHONG thay the.

---

## Muc luc

1. [Tong quan](#1-tong-quan)
2. [Kien truc](#2-kien-truc)
3. [Cai dat](#3-cai-dat)
4. [Cau hinh](#4-cau-hinh)
5. [Su dung](#5-su-dung)
6. [Smart Router](#6-smart-router)
7. [Trust Graph](#7-trust-graph)
8. [Context Cache](#8-context-cache)
9. [Orchestrator Agent](#9-orchestrator-agent)
10. [Dashboard](#10-dashboard)
11. [Them project moi](#11-them-project-moi)
12. [Them model/provider moi](#12-them-model-provider-moi)
13. [Scale](#13-scale)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Tong quan

### Van de
- Claude Code (Opus) rat gioi nhung dat (~$10/ngay)
- Nhieu task don gian (review, docs, scan) khong can Opus
- Khi co 5-10 projects, chi phi tang nhanh

### Giai phap
Route task sang model phu hop (v2.3 lineup):
- **Claude Code (Opus)**: Spec, debug phuc tap, build multi-file → giu nguyen
- **DeepSeek V4 Pro** (`architect`): Kien truc phuc tap, system design
- **DeepSeek V4 Flash** (`default`): Build, fix, task → re, manh
- **Gemini 3 Flash** (`smart`/`fast`): Review, scan, spec, debug → nhanh
- **GPT-5.4 Mini** (`cheap`): Docs, cleanup, wire-memory → re nhat
- **Local (LM Studio/Qwen 7B)**: Offline, private code → mien phi

### Khi nao dung AI Orchestrator vs Claude Code

| Task | Dung cai gi | Ly do |
|---|---|---|
| `/spec` feature moi | Claude Code | Can reasoning sau |
| `/build` feature lon | Claude Code | Multi-file edit |
| `/debug` phuc tap | Claude Code | Trace across layers |
| `/fix` bug don gian | Orchestrator | 1 file, logic ro |
| `/review` code | Orchestrator | Scan pattern, re |
| `/docs` | Orchestrator | Text generation |
| `/cleanup` | Orchestrator | Rename, format |
| `/check` security | Orchestrator | Pattern matching |

---

## 2. Kien truc

```
┌────────────────────────────────────┐
│           Ban (Mobile/PC)          │
│     RemoteTerminal / Browser       │
└──────┬──────────────┬──────────────┘
       │              │
┌──────▼──────┐ ┌─────▼──────────────┐
│ Claude Code │ │ AI Orchestrator     │
│   (Opus)    │ │                     │
│             │ │ ┌─────────────────┐ │
│ Task phuc   │ │ │ Smart Router    │ │
│ tap, spec,  │ │ │ (chon model)    │ │
│ build lon   │ │ └────────┬────────┘ │
│             │ │ ┌────────▼────────┐ │
│             │ │ │ Trust Graph     │ │
│             │ │ │ (chon context)  │ │
│             │ │ └────────┬────────┘ │
│             │ │ ┌────────▼────────┐ │
│             │ │ │ Context Cache   │ │
│             │ │ │ (giam tokens)   │ │
│             │ │ └────────┬────────┘ │
└─────────────┘ └──────────┼──────────┘
                           │
                  ┌────────▼────────┐
                  │  LiteLLM Proxy  │
                  │  (localhost:5002)│
                  │  Track cost     │
                  │  Fallback       │
                  │  Cache          │
                  └────────┬────────┘
                           │
          ┌────────┬───────┼────────┬──────────┐
          │        │       │        │          │
      DS V4 Pro  Gemini  Gemini  DS V4 Flash  Local
      (architect)(smart) (fast)  (default)  (Qwen7B)
```

### Components

| Component | File | Chuc nang |
|---|---|---|
| LiteLLM Proxy | docker-compose.yaml | API gateway, cost tracking, fallback |
| OrcAI CLI | bin/orcai.js | Coding agent CLI (thay the Hermes) |
| Smart Router | router/smart-router.js | Phan tich task → chon model |
| Orchestrator Agent | router/orchestrator-agent.js | Chia task lon → nhieu model |
| Trust Graph | graph/trust-graph.js | Build dependency graph, chon context |
| Context Cache | cache/context-cache.js | Cache prompt prefix, giam tokens |
| Watcher | graph/watcher.js | Auto re-index khi file thay doi |
| Dashboard | dashboard/index.html | Web UI monitoring |

---

## 3. Cai dat

### Yeu cau
- Docker Desktop
- Node.js 22+
- Git
- It nhat 1 API key (OpenRouter de bat dau nhanh nhat)

### Buoc 1: Clone/setup

```bash
cd E:/DEVELOP/ai-orchestrator

# Neu chua co, copy .env.example
cp .env.example .env
```

### Buoc 2: Dien API key

Mo `.env` va dien it nhat 1 key:

```bash
# BAT BUOC: OpenRouter (1 key, 200+ models) — KHUYEN NGHI
OPENROUTER_API_KEY=sk-or-v1-xxx

# BAT BUOC: Google Gemini (smart/fast tier — truc tiep, re hon OpenRouter)
GEMINI_API_KEY=AIzaxxx

# TUY CHON: Anthropic (khi can Opus cho task cuc kho)
ANTHROPIC_API_KEY=sk-ant-xxx
```

Noi dang ky:
- OpenRouter: https://openrouter.ai/keys (free tier, co $5 credit)
- Gemini: https://aistudio.google.com/apikey (free tier, 60 req/phut)

### Buoc 3: Start

```bash
docker compose up -d
```

### Buoc 4: Verify

```bash
# Health check
curl http://localhost:5002/health -H "Authorization: Bearer sk-master-change-me"

# Test model
curl http://localhost:5002/v1/chat/completions \
  -H "Authorization: Bearer sk-master-change-me" \
  -H "Content-Type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"Hi"}],"max_tokens":10}'
```

### Buoc 5: Mo dashboard

- LiteLLM: http://localhost:5002/ui (admin/admin)
- Orchestrator API: http://localhost:5003
- Analytics: http://localhost:5004
- Gateway (login portal): http://localhost:5005

---

## 4. Cau hinh

### 4.1 API Keys (`.env`)

```bash
# Master key dang nhap LiteLLM dashboard
LITELLM_MASTER_KEY=sk-master-doi-thanh-key-rieng

# Provider keys (BAT BUOC: OPENROUTER + GEMINI)
OPENROUTER_API_KEY=
GEMINI_API_KEY=
ANTHROPIC_API_KEY=   # TUY CHON: chi can khi dung opus-legacy

# Ports
LITELLM_PORT=5002
ORCHESTRATOR_PORT=5003
ANALYTICS_PORT=5004
GATEWAY_PORT=5005
```

### 4.2 Model routing (`litellm_config.yaml`)

```yaml
model_list:
  - model_name: "default"         # Build, fix, task
    litellm_params:
      model: "openai/deepseek/deepseek-v4-flash"
      api_base: "https://openrouter.ai/api/v1"
      api_key: "os.environ/OPENROUTER_API_KEY"

  - model_name: "architect"       # System design, kien truc phuc tap
    litellm_params:
      model: "openai/deepseek/deepseek-v4-pro"
      api_base: "https://openrouter.ai/api/v1"
      api_key: "os.environ/OPENROUTER_API_KEY"

  - model_name: "smart"           # Review, spec, debug
    litellm_params:
      model: "gemini/gemini-3-flash-preview"
      api_key: "os.environ/GEMINI_API_KEY"

  - model_name: "fast"            # Scan, analyze, multimodal
    litellm_params:
      model: "gemini/gemini-3-flash-preview"
      api_key: "os.environ/GEMINI_API_KEY"

  - model_name: "cheap"           # Docs, cleanup, wire-memory
    litellm_params:
      model: "openai/openai/gpt-5.4-mini"
      api_base: "https://openrouter.ai/api/v1"
      api_key: "os.environ/OPENROUTER_API_KEY"
```

**5 model names chuẩn (v2.3):**
- `default` — DeepSeek V4 Flash (build, fix, task)
- `architect` — DeepSeek V4 Pro (system design, kien truc)
- `smart` — Gemini 3 Flash (spec, debug, review sau)
- `fast` — Gemini 3 Flash (scan nhanh, multimodal)
- `cheap` — GPT-5.4 Mini (docs, comment, cleanup)

### 4.3 Ports

Xem `PORTS.md` — moi project co dai rieng:

| Project | Dai |
|---|---|
| ai-orchestrator | 5002-5005 |
| VietNet2026 | 5100-5199 |
| LeQuyDon | 5200-5299 |
| FashionEcom | 5300-5399 |
| VIETNET | 5400-5499 |

---

## 5. Su dung

### 5.1 Goi model truc tiep qua LiteLLM API

```bash
# Model default (DeepSeek V4 Flash)
curl http://localhost:5002/v1/chat/completions \
  -H "Authorization: Bearer sk-master-change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default",
    "messages": [{"role": "user", "content": "Viet 1 NestJS controller cho CRUD product"}],
    "max_tokens": 2000
  }'

# Model fast (Gemini Flash) cho review
curl http://localhost:5002/v1/chat/completions \
  -H "Authorization: Bearer sk-master-change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fast",
    "messages": [{"role": "user", "content": "Review code nay co van de gi khong: ..."}],
    "max_tokens": 1000
  }'
```

### 5.2 Dung Smart Router (Node.js)

```javascript
const { SmartRouter } = require('./router/smart-router');

const router = new SmartRouter({ costOptimize: true });

// Tu dong chon model
const result = router.route({
  task: 'build',
  files: ['frontend/src/components/Header.tsx'],
  prompt: 'Fix header responsive',
  project: 'FashionEcom'
});

console.log(result.model);        // "deepseek-v4-flash" hoac "local-heavy"
console.log(result.litellm_name); // "default"
console.log(result.reasons);      // ["FE files detected", ...]
```

### 5.3 Dung Orchestrator Agent (tu dong chia viec)

```javascript
const { OrchestratorAgent } = require('./router/orchestrator-agent');

const agent = new OrchestratorAgent({
  litellmUrl: 'http://localhost:5002',
  litellmKey: 'sk-master-change-me',
  dispatcherModel: 'fast'  // Gemini 3 Flash lam dispatcher
});

// Plan: phan tich va chia viec
const plan = await agent.plan(
  'Them tinh nang wishlist: API, DB entity, FE component',
  { project: 'FashionEcom', files: ['backend/src/...', 'frontend/src/...'] }
);
// → DS V4 Pro (schema) → DS V4 Flash (BE) → DS V4 Flash (FE) → Gemini (review)

// Execute: chay tat ca subtasks
const result = await agent.execute(plan);
console.log(result.summary);
```

### 5.4 Dung Trust Graph (chon context thong minh)

```javascript
const { TrustGraph } = require('./graph/trust-graph');

const graph = new TrustGraph('E:/DEVELOP/FashionEcom');
await graph.index();

// Tim files lien quan
const relevant = graph.getRelevantFiles('backend/src/modules/auth/auth.service.ts', 15);
// → 10 files (entities, DTOs, controller, module, utils, spec)
// → 28KB thay vi 1670KB (giam 97%)

// Build context string de gui vao LLM
const ctx = graph.buildContext('backend/src/modules/auth/auth.service.ts');
console.log(ctx.context);      // Noi dung 10 files
console.log(ctx.reduction);    // "97%"
```

### 5.5 OrcAI CLI (coding agent)

```bash
# Setup (1 lan)
./scripts/setup-agent.sh    # Linux/Mac
scripts\setup-agent.bat     # Windows

# Su dung
orcai -i                                  # Interactive mode
orcai "sua bug login"                     # One-shot
orcai -p /path/to/project "them feature"  # Chi dinh project
orcai --model smart "refactor auth"       # Chon model
```

### 5.6 OrcAI Gateway (web portal)

Mo http://localhost:5005 → Gateway login portal (admin/admin).
Truy cap LiteLLM dashboard: http://localhost:5002/ui

---

## 6. Smart Router — Chi tiet

### Model profiles

| Model | LiteLLM name | Strengths | Best for |
|---|---|---|---|
| DeepSeek V4 Flash | `default` | backend, frontend, api, sql, logic | Build, fix, task |
| DeepSeek V4 Pro | `architect` | architecture, system_design, reasoning | Kien truc, spec phuc tap |
| Gemini 3 Flash | `smart`/`fast` | review, multimodal, context_analysis | Review, scan, debug, UI screenshot |
| GPT-5.4 Mini | `cheap` | docs, comment, cleanup, text_gen | Docs, rename, wire-memory |
| Qwen 7B (local) | `local-heavy` | backend, frontend, logic, simple_fix | Offline/private code |

### Routing logic

```
Input: task type + file paths + prompt keywords + context size
  ↓
1. Task match      (40 points max)  — /build_fe → frontend strengths
2. File domain     (25 points max)  — *.tsx → frontend, *.service.ts → backend
3. Prompt keywords (20 points max)  — "component" → frontend, "api" → backend
4. Context size    (15 points max)  — >100K → prefer gemini (1M context)
5. Cost bonus      (10 points max)  — re hon → diem cao hon
  ↓
Output: model voi score cao nhat + alternatives
```

### Them/sua model profile

Edit `router/smart-router.js` → `MODEL_PROFILES`:

```javascript
MODEL_PROFILES['new-model'] = {
  litellm_name: 'new',
  strengths: ['frontend', 'backend'],
  max_context: 128000,
  cost_per_1m_input: 0.50,
  speed: 'fast',
  description: 'Mo ta model'
};
```

---

## 7. Trust Graph — Chi tiet

### Cach hoat dong

1. Index tat ca source files trong project
2. Parse `import`/`require` statements → build dependency graph
3. Khi query 1 file → BFS qua imports + importedBy → score theo depth
4. Bonus cho files cung directory (locality)
5. Tra ve top N files theo relevance score

### Ho tro path aliases

- `@/` → `src/` (Next.js, NestJS)
- `~/` → `src/`
- `src/` → resolve tu project root
- Fallback: try `backend/src/` va `frontend/src/`

### Auto re-index

Watcher chay trong Docker, 2 chien luoc:
- **fs.watch**: Re-index ngay khi file thay doi (debounce 5s)
- **Cron**: Full re-index moi 30 phut

### Chay thu

```bash
# Index tat ca projects
node graph/index-projects.js

# Query 1 file
node graph/query.js FashionEcom "backend/src/modules/auth/auth.service.ts" 15
```

---

## 8. Context Cache — Chi tiet

### Cach hoat dong

Cache noi dung cac file it thay doi (constitution, spec, persona):
- Key: `layer:filePath`
- Value: file content
- TTL: 30 phut
- Invalidation: content hash thay doi → auto invalidate

### Layers duoc cache

1. `constitution` — `.sdd/constitution.md` (rat it thay doi)
2. `project_context` — `CLAUDE.md`
3. `spec` — `.sdd/features/*/spec.md` (thay doi theo feature)
4. `plan` — `.sdd/features/*/plan.md`

### Tiet kiem

Moi phien, thay vi gui lai 5-10KB constitution + spec:
- Cache hit → 0 tokens (dung cached prefix)
- Tiet kiem ~20-30% input tokens

---

## 9. Orchestrator Agent — Chi tiet

### Flow

```
User: "Them wishlist feature"
  ↓
[1] Gemini 3 Flash (dispatcher) — phan tich, chia 4 subtasks
  ↓
[2] DeepSeek V4 Pro (architect) → Thiet ke API + DB schema
[3] DeepSeek V4 Flash (default) → Implement BE (depends on [2])
[4] DeepSeek V4 Flash (default) → Implement FE (depends on [3])
[5] Gemini 3 Flash (fast) → Review tong the (depends on [4])
  ↓
[6] Gemini 3 Flash (synthesizer) — tong hop ket qua
```

### Chi phi vs Claude Code

| Approach | Cost |
|---|---|
| Claude Code (Opus) lam tat ca | ~$2.00 |
| Orchestrator (multi-model) | ~$0.05 |
| Tiet kiem | **97%** |

### Gioi han

- Cac model nho khong gioi bang Opus cho task phuc tap
- Chua tich hop voi Claude Code commands
- Can nhieu API keys de routing that su hieu qua

---

## 10. Dashboard

### URLs

| URL | Chuc nang |
|---|---|
| http://localhost:5002/ui | LiteLLM Dashboard (chi tiet token/cost, admin/admin) |
| http://localhost:5003 | Orchestrator REST API (scan/plan/execute) |
| http://localhost:5004 | Analytics + Dashboard (overview, cost, models, settings) |
| http://localhost:5005 | Gateway login portal (admin/admin) |

### Dashboard tabs

- **Overview**: Chi phi hom nay/thang, requests, tokens, per-model breakdown
- **Usage & Cost**: Bar chart theo ngay, monthly summary
- **Models**: Status tung provider, routing map
- **Settings**: Form dien API keys, budget, proxy URL
- **Quick Links**: Links den tat ca services + dang ky key

---

## 11. Them project moi

### Buoc 1: Them vao Trust Graph

Edit `graph/trust-graph.js` va `graph/index-projects.js`:

```javascript
// Trong PROJECTS array:
{ name: 'NewProject', dir: 'E:/DEVELOP/NewProject' },
```

### Buoc 2: Them vao watcher

Edit `graph/watcher-docker.js`:

```javascript
const PROJECTS = {
  ...
  NewProject: '/projects/NewProject',
};
```

### Buoc 4: Restart

```bash
docker compose up -d
node graph/index-projects.js  # Re-index
```

### Buoc 5: Cap nhat PORTS.md

Chon dai port moi (VD: 5500-5599 cho project moi).

---

## 12. Them model/provider moi

### Buoc 1: Them vao .env

```bash
NEW_PROVIDER_API_KEY=sk-xxx
```

### Buoc 2: Them vao litellm_config.yaml

```yaml
model_list:
  - model_name: "new-model"
    litellm_params:
      model: "provider/model-name"
      api_key: "os.environ/NEW_PROVIDER_API_KEY"
      api_base: "https://api.provider.com/v1"  # neu can
      rpm: 60
```

### Buoc 3: Them vao Smart Router

Edit `router/smart-router.js` → `MODEL_PROFILES`:

```javascript
'new-model': {
  litellm_name: 'new-model',
  strengths: ['backend', 'api'],
  max_context: 128000,
  cost_per_1m_input: 0.50,
  speed: 'fast',
  description: 'Mo ta'
}
```

### Buoc 4: Restart

```bash
docker compose restart litellm
```

---

## 13. Scale

### 13.1 Them nhieu project (5 → 10 → 20)

**Khong anh huong:**
- LiteLLM proxy khong quan tam project
- Smart Router tu detect tu file paths
- Trust Graph index rieng tung project

**Can lam:**
- Them project vao watcher (buoc 11)
- Chon dai port moi (PORTS.md)

### 13.2 Them nhieu model

**Khi nao:**
- Co model moi tot cho 1 domain (VD: model chuyen SQL)
- Provider cu tang gia → chuyen sang re hon

**Cach lam:**
- Them model vao litellm_config.yaml
- Them profile vao smart-router.js
- LiteLLM tu dong fallback neu model fail

### 13.3 Tang throughput

**Hien tai:** 1 LiteLLM worker, du cho solo dev
**Khi can nhieu hon:**

```yaml
# litellm docker-compose
command: --config /app/config.yaml --num_workers 4
```

### 13.4 Deploy len VPS (remote access)

```yaml
# Them Nginx reverse proxy
# Them basic auth hoac Cloudflare Tunnel
# KHONG expose LiteLLM truc tiep ra internet (co API keys)
```

### 13.5 Team (nhieu nguoi dung)

**LiteLLM ho tro:**
- Virtual keys: moi nguoi 1 key, track chi phi rieng
- Budget per key: gioi han chi phi moi nguoi
- Rate limit per key

```bash
# Tao key cho team member
curl http://localhost:5002/key/generate \
  -H "Authorization: Bearer sk-master-change-me" \
  -d '{"max_budget": 10, "budget_duration": "1d"}'
```

---

## 14. Troubleshooting

### LiteLLM khong start

```bash
docker logs litellm-proxy
# Thuong gap:
# - YAML syntax error → check litellm_config.yaml
# - Database error → bo DATABASE_URL (dung in-memory)
# - Port conflict → doi LITELLM_PORT trong .env
```

### Model tra ve loi

```bash
# Check model co healthy khong
curl http://localhost:5002/health -H "Authorization: Bearer sk-master-change-me"

# Check key dung chua
# Loi 401 → sai key
# Loi 429 → rate limit (doi hoac dung model khac)
# Loi 500 → model loi, thu fallback
```

### OrcAI khong connect LiteLLM

```bash
# Test LiteLLM truc tiep (port 5002)
curl http://localhost:5002/health -H "Authorization: Bearer sk-master-change-me"
# Neu fail → check docker network
docker network ls
docker logs litellm-proxy --tail 20
```

### Trust Graph khong tim du files

```bash
# Check index
node graph/index-projects.js
# Neu edges it → check path aliases trong trust-graph.js
# Them alias: edit _parseImports()
```

### Rate limit (free tier)

| Provider | Free limit |
|---|---|
| Gemini 3 Flash | 60 req/phut (Google direct) |
| OpenRouter | $5 free credit — tat ca model qua 1 key |
| DeepSeek V4 | Khong gioi han, tra tien theo token |

**Khuyen nghi:** Dang ky OpenRouter ($5 free) + Gemini API (free) la du de chay day du.

### Dashboard khong hien data

- LiteLLM can vai request truoc khi co data
- Dashboard goi `localhost:5002/spend/logs` → check CORS
- Neu loi: mo truc tiep http://localhost:5002/ui (LiteLLM built-in)

---

## Files reference

```
ai-orchestrator/
├── .env                          ← API keys (KHONG commit)
├── .env.example                  ← Template
├── .gitignore
├── package.json                  ← CLI + dependencies
├── docker-compose.yaml           ← Services (LiteLLM, Orchestrator, Analytics, Gateway)
├── litellm_config.yaml           ← Model routing (v2.3: DS V4 + Gemini 3 Flash)
├── docs/model-routing-map.md     ← Task → model mapping (source of truth)
├── README.md                     ← Quick start
├── bin/
│   └── orcai.js                  ← CLI entry point (`orcai` command)
├── lib/
│   ├── agent-loop.js             ← Main agent loop
│   ├── orchestrator-v3.js        ← Orchestrator v3 engine
│   ├── config.js                 ← Configuration management
│   ├── conversation-manager.js   ← Conversation history
│   ├── repo-mapper.js            ← Repository structure mapping
│   ├── token-manager.js          ← Token counting + budget
│   └── auto-verify.js            ← Auto-verify tool results
├── tools/
│   ├── definitions.js            ← Tool definitions for LLM
│   ├── executor.js               ← Tool execution engine
│   ├── file-manager.js           ← Read/write/edit files
│   └── terminal-runner.js        ← Run shell commands
├── src/
│   ├── api-server.js             ← Orchestrator REST API
│   └── auth.ts                   ← Authentication
├── router/
│   ├── smart-router.js           ← Tu chon model
│   ├── orchestrator-agent.js     ← Chia viec cho nhieu model
│   ├── context-manager.js        ← Structured context injection
│   ├── decision-lock.js          ← Decision registry
│   ├── tech-lead-agent.js        ← Tech Lead agent
│   └── test-router.js            ← Test routing
├── cache/
│   └── context-cache.js          ← Cache prompt prefix
├── graph/
│   ├── trust-graph.js            ← Dependency graph
│   ├── index-projects.js         ← Index projects
│   ├── query.js                  ← Query CLI
│   ├── watcher.js                ← Auto re-index (local)
│   └── watcher-docker.js         ← Auto re-index (docker)
├── analytics/
│   ├── api-server.js             ← Analytics REST API
│   ├── tracker.js                ← Cost tracking
│   └── dashboard.html            ← Analytics UI
├── dashboard/
│   ├── index.html                ← Web UI
│   └── serve.js                  ← Server
├── scripts/
│   ├── setup-agent.sh            ← Setup (Linux/Mac)
│   └── setup-agent.bat           ← Setup (Windows)
├── skills/                       ← Hermes agent skills
├── prompts/                      ← Agent prompt templates
├── data/
│   └── graphs/*.json             ← Indexed project data
└── docs/
    ├── GUIDE.md                  ← File nay
    ├── MODEL-COMPARISON.md       ← So sanh models
    └── UPGRADE-PLAN.md           ← Ke hoach nang cap
```
