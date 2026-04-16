# AI Orchestrator — Huong dan day du

> Multi-model agent system: route task sang model phu hop, tiet kiem chi phi.
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
Route task sang model phu hop:
- **Claude Code (Opus)**: Spec, debug phuc tap, build multi-file → giu nguyen
- **Kimi K2.5**: Code frontend (React, Vue, CSS) → re hon 10x
- **DeepSeek**: Code backend (NestJS, API, DB) → re hon 30x
- **Gemini Flash**: Review, scan, analyze → re hon 60x
- **Local (LM Studio)**: Docs, comment → mien phi

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
                  │  (localhost:4001)│
                  │  Track cost     │
                  │  Fallback       │
                  │  Cache          │
                  └────────┬────────┘
                           │
          ┌────────┬───────┼────────┬──────────┐
          │        │       │        │          │
      Kimi K2.5  Sonnet  Gemini  DeepSeek   Local
       (FE)      (arch)  (review) (BE)     (docs)
```

### Components

| Component | File | Chuc nang |
|---|---|---|
| LiteLLM Proxy | docker-compose.yaml | API gateway, cost tracking, fallback |
| Hermes Agent | docker-compose.yaml | Agent engine, memory, web UI |
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
# Cach 1: OpenRouter (1 key, 200+ models) — KHUYEN NGHI
OPENROUTER_API_KEY=sk-or-v1-xxx

# Cach 2: Key rieng tung provider
KIMI_API_KEY=sk-xxx
GEMINI_API_KEY=AIzaxxx
DEEPSEEK_API_KEY=sk-xxx
ANTHROPIC_API_KEY=sk-ant-xxx
```

Noi dang ky:
- OpenRouter: https://openrouter.ai/keys (free tier)
- Kimi: https://platform.moonshot.cn/console/api-keys
- Gemini: https://aistudio.google.com/apikey (free tier)
- DeepSeek: https://platform.deepseek.com/api_keys
- Anthropic: https://console.anthropic.com/settings/keys

### Buoc 3: Start

```bash
docker compose up -d
```

### Buoc 4: Verify

```bash
# Health check
curl http://localhost:4001/health -H "Authorization: Bearer sk-master-change-me"

# Test model
curl http://localhost:4001/v1/chat/completions \
  -H "Authorization: Bearer sk-master-change-me" \
  -H "Content-Type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"Hi"}],"max_tokens":10}'
```

### Buoc 5: Mo dashboard

- LiteLLM: http://localhost:4001/ui (admin/admin)
- Hermes: http://localhost:3000
- Dashboard: http://localhost:9080

---

## 4. Cau hinh

### 4.1 API Keys (`.env`)

```bash
# Master key dang nhap LiteLLM dashboard
LITELLM_MASTER_KEY=sk-master-doi-thanh-key-rieng

# Provider keys
OPENROUTER_API_KEY=
KIMI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
DEEPSEEK_API_KEY=

# Ports
LITELLM_PORT=4001
HERMES_PORT=3000
```

### 4.2 Model routing (`litellm_config.yaml`)

```yaml
model_list:
  # model_name la ten ban goi trong API
  # model la ten thuc cua provider
  - model_name: "default"         # Goi: model="default"
    litellm_params:
      model: "openai/kimi-k2.5"   # Provider/model thuc
      api_base: "https://api.moonshot.cn/v1"
      api_key: "os.environ/KIMI_API_KEY"

  - model_name: "smart"
    litellm_params:
      model: "anthropic/claude-sonnet-4-20250514"
      api_key: "os.environ/ANTHROPIC_API_KEY"

  - model_name: "fast"
    litellm_params:
      model: "gemini/gemini-2.5-flash"
      api_key: "os.environ/GEMINI_API_KEY"

  - model_name: "cheap"
    litellm_params:
      model: "deepseek/deepseek-chat"
      api_base: "https://api.deepseek.com/v1"
      api_key: "os.environ/DEEPSEEK_API_KEY"
```

**4 model names chuẩn:**
- `default` — Model chính (build, fix, task)
- `smart` — Model thông minh nhất (spec, debug, architecture)
- `fast` — Model nhanh nhất (review, scan, analyze)
- `cheap` — Model rẻ nhất (docs, comment, cleanup)

### 4.3 Hermes Agent (`hermes_config.yaml`)

```yaml
provider: custom
model: default                     # Dung model "default" qua LiteLLM
api_base: http://litellm:4000/v1   # Goi qua LiteLLM proxy

memory:
  enabled: true
  backend: sqlite

context:
  cache_system_prompt: true        # Cache prompt → giam token
  compression:
    enabled: true
    threshold: 50000               # Compress khi > 50K tokens
```

### 4.4 Ports

Xem `PORTS.md` — moi project co dai rieng:

| Project | Dai |
|---|---|
| ai-orchestrator | 3000, 4001, 9080 |
| VietNet2026 | 5100-5199 |
| LeQuyDon | 5200-5299 |
| FashionEcom | 5300-5399 |
| VIETNET | 5400-5499 |

---

## 5. Su dung

### 5.1 Goi model truc tiep qua LiteLLM API

```bash
# Model default (Kimi K2.5)
curl http://localhost:4001/v1/chat/completions \
  -H "Authorization: Bearer sk-master-change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default",
    "messages": [{"role": "user", "content": "Viet 1 NestJS controller cho CRUD product"}],
    "max_tokens": 2000
  }'

# Model fast (Gemini Flash) cho review
curl http://localhost:4001/v1/chat/completions \
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

const router = new SmartRouter({
  availableModels: ['gemini-flash', 'kimi-k2.5', 'deepseek', 'sonnet'],
  costOptimize: true
});

// Tu dong chon model
const result = router.route({
  task: 'build',
  files: ['frontend/src/components/Header.tsx'],
  prompt: 'Fix header responsive',
  project: 'FashionEcom'
});

console.log(result.model);        // "kimi-k2.5"
console.log(result.litellm_name); // "default"
console.log(result.reasons);      // ["FE files detected", ...]
```

### 5.3 Dung Orchestrator Agent (tu dong chia viec)

```javascript
const { OrchestratorAgent } = require('./router/orchestrator-agent');

const agent = new OrchestratorAgent({
  litellmUrl: 'http://localhost:4001',
  litellmKey: 'sk-master-change-me',
  dispatcherModel: 'fast'  // Gemini Flash lam dispatcher (re nhat)
});

// Plan: phan tich va chia viec
const plan = await agent.plan(
  'Them tinh nang wishlist: API, DB entity, FE component',
  { project: 'FashionEcom', files: ['backend/src/...', 'frontend/src/...'] }
);
// → Sonnet (schema) → DeepSeek (BE) → Kimi (FE) → Gemini (review)

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

### 5.5 Hermes Agent (chat qua web)

Mo http://localhost:3000 → Chat truc tiep.
Hermes tu dong goi LiteLLM proxy → chon model.

---

## 6. Smart Router — Chi tiet

### Model profiles

| Model | Strengths | Best for |
|---|---|---|
| gemini-flash | context_analysis, multimodal, review, summarize | Review, scan, large context |
| kimi-k2.5 | frontend, react, nextjs, vue, css, tailwind | FE components, UI/UX |
| deepseek | backend, nestjs, api, database, sql, typeorm | BE services, DB, API |
| sonnet | architecture, spec, debug_complex, reasoning | Design, spec, complex debug |
| local | docs, comment, simple_fix, format | Documentation, rename |

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
[1] Gemini Flash (dispatcher) — phan tich, chia 4 subtasks
  ↓
[2] Sonnet → Thiet ke API + DB schema
[3] DeepSeek → Implement BE (depends on [2])
[4] Kimi K2.5 → Implement FE (depends on [3])
[5] Gemini Flash → Review tong the (depends on [4])
  ↓
[6] Gemini Flash (synthesizer) — tong hop ket qua
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
| http://localhost:9080 | Orchestrator Dashboard (overview, cost, models, settings) |
| http://localhost:4001/ui | LiteLLM Dashboard (chi tiet token/cost, admin/admin) |
| http://localhost:3000 | Hermes Agent (chat, settings, memory) |

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

### Buoc 2: Mount vao Docker (neu dung Hermes)

Edit `docker-compose.yaml`, them volume:

```yaml
hermes:
  volumes:
    - /e/DEVELOP/NewProject:/projects/NewProject
```

### Buoc 3: Them vao watcher

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
curl http://localhost:4001/key/generate \
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
curl http://localhost:4001/health -H "Authorization: Bearer sk-master-change-me"

# Check key dung chua
# Loi 401 → sai key
# Loi 429 → rate limit (doi hoac dung model khac)
# Loi 500 → model loi, thu fallback
```

### Hermes khong connect LiteLLM

```bash
# Trong container
docker compose exec hermes curl http://litellm:4000/health
# Neu fail → check docker network
docker network ls
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
| Gemini | 20 req/ngay (2.5-flash), 0 (2.5-pro) |
| DeepSeek | Khong gioi han nhung cham |
| Kimi | 15 req/ngay (free) |
| OpenRouter | $5 free credit |

**Khuyen nghi:** Dang ky OpenRouter ($5 free) de test nhieu model.

### Dashboard khong hien data

- LiteLLM can vai request truoc khi co data
- Dashboard goi `localhost:4001/spend/logs` → check CORS
- Neu loi: mo truc tiep http://localhost:4001/ui (LiteLLM built-in)

---

## Files reference

```
ai-orchestrator/
├── .env                          ← API keys (KHONG commit)
├── .env.example                  ← Template
├── .gitignore
├── docker-compose.yaml           ← 4 services
├── litellm_config.yaml           ← Model routing
├── hermes_config.yaml            ← Agent config
├── PORTS.md                      ← Port allocation
├── README.md                     ← Quick start
├── setup.sh                      ← Auto setup script
├── test-gemini.sh                ← Test script
├── model-routing-map.md          ← Task → model mapping
├── router/
│   ├── smart-router.js           ← Tu chon model
│   ├── orchestrator-agent.js     ← Chia viec cho nhieu model
│   └── test-router.js            ← Test routing
├── cache/
│   └── context-cache.js          ← Cache prompt prefix
├── graph/
│   ├── trust-graph.js            ← Dependency graph
│   ├── index-projects.js         ← Index 5 projects
│   ├── query.js                  ← Query CLI
│   ├── watcher.js                ← Auto re-index (local)
│   └── watcher-docker.js         ← Auto re-index (docker)
├── dashboard/
│   ├── index.html                ← Web UI
│   └── serve.js                  ← Server
├── skills/
│   ├── developer.md
│   ├── reviewer.md
│   └── docs-writer.md
├── data/
│   └── graphs/*.json             ← Indexed project data
└── docs/
    └── GUIDE.md                  ← File nay
```
