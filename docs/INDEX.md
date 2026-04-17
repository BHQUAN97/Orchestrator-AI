# AI Orchestrator — Index tai lieu

> Danh muc tat ca tai lieu, config, modules trong du an. Cap nhat: 2026-04-17 (v2.2)

## What's New v2.2 (2026-04-17)

12 commit hardening + perf + features. Highlights:
- **Security**: gateway auth hardening, prod startup guard, removed hardcoded LiteLLM key, SameSite=Strict, CSRF protection
- **Reliability**: budget refund on retry exhausted, Architect ceiling break (chan $0.13 waste/task), batch I/O cho decision-lock, LiteLLM timeout 90s + retry network err
- **Performance**: parallel classify+scan (~500ms), ContextManager meta cache (~1s/run), ring buffer executionLog (chan RAM leak), incremental getStats O(1), JSON parse fast-path 7.6×
- **Features (10 endpoints moi)**: dry-run, cancel, rollback, history, estimate (heuristic), templates CRUD, runs, SSE live stream, voice input portal, NOTIFY_WEBHOOK
- **Real-test fix**: git in alpine, BUDGET_TZ override, LiteLLM healthcheck endpoint, credit-aware auto-downgrade
- **Tests**: 99 unit + 56 hardening = 155 pass

---

## Tai lieu chinh (Root)

| File | Mo ta |
|------|-------|
| [`README.md`](../README.md) | Tong quan v2.2 — architecture, quick start, model lineup, 10 endpoint moi, env vars |
| [`.env.example`](../.env.example) | Mau bien moi truong (API keys, ports, budget) |
| [`package.json`](../package.json) | Dependencies, scripts (`start`, `test`, `dev`), entry point |
| [`index.js`](../index.js) | Export tat ca modules de dung programmatically |

---

## Tai lieu huong dan (`docs/`)

| File | Mo ta |
|------|-------|
| [`GUIDE.md`](GUIDE.md) | Huong dan day du v2.1 — 14 muc: kien truc, cai dat, cau hinh, smart router, trust graph, context cache, dashboard, scale, troubleshooting |
| [`USAGE.md`](USAGE.md) | Huong dan su dung tu A-Z — khoi dong, Web UI, Mobile, CLI, API, budget, ket thuc ngay |
| [`MODEL-COMPARISON.md`](MODEL-COMPARISON.md) | So sanh model (Opus/Sonnet/Kimi/Gemini/DeepSeek) — diem so theo tung kha nang, chi phi |
| [`model-routing-map.md`](model-routing-map.md) | Routing map: Agent role → Model assignment, execution flow 6 buoc, escalation rules |
| [`PORTS.md`](PORTS.md) | Port map TAT CA projects — ai-orchestrator (5000-5004), VietNet (51xx), LeQuyDon (52xx), FashionEcom (53xx) |
| [`ROOCODE-SETUP.md`](ROOCODE-SETUP.md) | Setup Roo Code + LiteLLM proxy trong VS Code — kien truc, modes, smart routing |
| [`UPGRADE-PLAN.md`](UPGRADE-PLAN.md) | Ke hoach nang cap — phan tich diem manh/yeu, 3 cap do cai tien |

---

## Config files

| File | Mo ta |
|------|-------|
| [`litellm_config.yaml`](../litellm_config.yaml) | Cau hinh LiteLLM proxy — model list (default/smart/fast/cheap/architect), routing, fallback |
| [`hermes_config.yaml`](../hermes_config.yaml) | Cau hinh Hermes Brain — provider, model, fallback, ket noi LiteLLM |
| [`docker-compose.yaml`](../docker-compose.yaml) | Docker stack chinh — Hermes, LiteLLM, Orchestrator API, Analytics, Nginx gateway |
| [`docker-compose.agent.yaml`](../docker-compose.agent.yaml) | Docker config rieng cho coding agent |
| [`Dockerfile.agent`](../Dockerfile.agent) | Dockerfile cho coding agent container |
| [`.orchignore`](../.orchignore) | Danh sach file/folder orchestrator bo qua khi scan |
| [`.roomodes`](../.roomodes) | Cau hinh Roo Code modes (Spec, Build, Review, Debug, Docs) |

---

## Router — Core routing engine (`router/`)

| File | Mo ta |
|------|-------|
| [`orchestrator-agent.js`](../router/orchestrator-agent.js) | **Main entry** — OrchestratorAgent class, AGENT_ROLE_MAP, dieu phoi toan bo pipeline |
| [`smart-router.js`](../router/smart-router.js) | SmartRouter — phan loai task va chon model toi uu (cost vs quality) |
| [`context-manager.js`](../router/context-manager.js) | ContextManager — normalize context sang structured JSON cho moi model |
| [`tech-lead-agent.js`](../router/tech-lead-agent.js) | TechLeadAgent — review/approve/modify plan, xu ly escalation |
| [`decision-lock.js`](../router/decision-lock.js) | DecisionLock — dam bao 1 decision tai 1 thoi diem, tranh conflict |
| [`slm-classifier.js`](../router/slm-classifier.js) | SLM Classifier — phan loai task bang small language model (tiet kiem token) |
| [`test-router.js`](../router/test-router.js) | Test suite cho router modules |

---

## Lib — Core libraries (`lib/`)

| File | Mo ta |
|------|-------|
| [`agent-loop.js`](../lib/agent-loop.js) | Agent execution loop — chay tool use loop, xu ly conversation turns |
| [`auto-verify.js`](../lib/auto-verify.js) | Tu dong verify ket qua sau khi agent thuc thi |
| [`config.js`](../lib/config.js) | Load va merge config tu nhieu nguon (.env, yaml, defaults) |
| [`conversation-manager.js`](../lib/conversation-manager.js) | Quan ly conversation history, context window, compaction |
| [`orchestrator-v3.js`](../lib/orchestrator-v3.js) | Orchestrator v3 — phien ban moi cua pipeline |
| [`pipeline-tracer.js`](../lib/pipeline-tracer.js) | Trace toan bo pipeline — log moi buoc, timing, cost |
| [`repo-mapper.js`](../lib/repo-mapper.js) | Map cau truc repo — scan files, build dependency graph |
| [`token-manager.js`](../lib/token-manager.js) | Quan ly token budget — dem, canh bao, enforce limits |

---

## Tools — Agent tool definitions (`tools/`)

| File | Mo ta |
|------|-------|
| [`definitions.js`](../tools/definitions.js) | Dinh nghia tat ca tools (read, write, search, terminal...) |
| [`executor.js`](../tools/executor.js) | Thuc thi tool calls — dispatch va xu ly ket qua |
| [`file-manager.js`](../tools/file-manager.js) | Doc/ghi/tim kiem file — co permission check |
| [`permissions.js`](../tools/permissions.js) | He thong permission — whitelist/blacklist paths, dangerous ops |
| [`shadow-git.js`](../tools/shadow-git.js) | Shadow git — tu dong commit/restore khi agent thay doi code |
| [`terminal-runner.js`](../tools/terminal-runner.js) | Chay shell commands — co timeout, sandbox, output capture |

---

## Prompts — System prompts cho agents (`prompts/`)

| File | Agent | Mo ta |
|------|-------|-------|
| [`scanner.md`](../prompts/scanner.md) | Scanner | Quet project, doc file, thu thap context |
| [`planner.md`](../prompts/planner.md) | Planner | Xay dung execution plan tu scan data |
| [`tech-lead.md`](../prompts/tech-lead.md) | Tech Lead | Review plan, approve/modify/reject, xu ly escalation |
| [`fe-dev.md`](../prompts/fe-dev.md) | FE Dev | Frontend development (Kimi K2.5) |
| [`be-dev.md`](../prompts/be-dev.md) | BE Dev | Backend development (DeepSeek V3) |
| [`reviewer.md`](../prompts/reviewer.md) | Reviewer | Code review, security, quality (Gemini Flash) |
| [`debugger.md`](../prompts/debugger.md) | Debugger | Debug complex issues (Sonnet) |

---

## Skills — Roo Code skill definitions (`skills/`)

| File | Mo ta |
|------|-------|
| [`developer.md`](../skills/developer.md) | Skill definition cho Developer mode |
| [`docs-writer.md`](../skills/docs-writer.md) | Skill definition cho Docs Writer mode |
| [`orchestrator.md`](../skills/orchestrator.md) | Skill definition cho Orchestrator mode |
| [`reviewer.md`](../skills/reviewer.md) | Skill definition cho Reviewer mode |

---

## CLI (`bin/`)

| File | Mo ta |
|------|-------|
| [`orcai.js`](../bin/orcai.js) | **`orcai` CLI** — coding agent tuong tu Claude Code, route task sang model toi uu |

---

## Graph — Knowledge graph & Trust (`graph/`)

| File | Mo ta |
|------|-------|
| [`trust-graph.js`](../graph/trust-graph.js) | Trust Graph engine — do tin cay cua model theo task type |
| [`index-projects.js`](../graph/index-projects.js) | Index tat ca projects vao knowledge graph |
| [`query.js`](../graph/query.js) | Query knowledge graph — tim file, dependency, context |
| [`watcher.js`](../graph/watcher.js) | File watcher — tu dong update graph khi code thay doi |
| [`watcher-docker.js`](../graph/watcher-docker.js) | File watcher phien ban Docker |

---

## Cache (`cache/`)

| File | Mo ta |
|------|-------|
| [`context-cache.js`](../cache/context-cache.js) | Context cache — luu tru va tai su dung context giua cac phien |

---

## Analytics & Dashboard

| File | Mo ta |
|------|-------|
| [`analytics/tracker.js`](../analytics/tracker.js) | Tracker — ghi nhan cost, token usage, model performance |
| [`analytics/api-server.js`](../analytics/api-server.js) | Analytics REST API server |
| [`analytics/dashboard.html`](../analytics/dashboard.html) | Analytics dashboard UI (cost + performance charts) |
| [`dashboard/index.html`](../dashboard/index.html) | Main dashboard UI |
| [`dashboard/serve.js`](../dashboard/serve.js) | Dashboard HTTP server |

---

## Gateway — Nginx + Auth (`gateway/`)

| File | Mo ta |
|------|-------|
| [`nginx.conf`](../gateway/nginx.conf) | Nginx config — reverse proxy, CORS, rate limit |
| [`auth-server.js`](../gateway/auth-server.js) | Auth server — xac thuc truoc khi truy cap services |
| [`login.html`](../gateway/login.html) | Trang dang nhap |
| [`portal.html`](../gateway/portal.html) | Portal — trang chinh sau khi login, link den cac services |

---

## API Server (`src/`)

| File | Mo ta |
|------|-------|
| [`api-server.js`](../src/api-server.js) | Orchestrator REST API — endpoints cho task execution, status, budget |

---

## Scripts — Setup & Deploy (`scripts/`)

| File | Mo ta |
|------|-------|
| [`setup.sh`](../scripts/setup.sh) | Setup toan bo he thong (Linux/Mac) |
| [`setup.bat`](../scripts/setup.bat) | Setup toan bo he thong (Windows) |
| [`setup-roocode.bat`](../scripts/setup-roocode.bat) | Setup Roo Code extension + config |
| [`setup-agent.sh`](../scripts/setup-agent.sh) / [`.bat`](../scripts/setup-agent.bat) | Setup coding agent container |
| [`start.bat`](../scripts/start.bat) | Start tat ca services |
| [`stop.bat`](../scripts/stop.bat) | Stop tat ca services |
| [`deploy.bat`](../scripts/deploy.bat) | Deploy len server |
| [`orchestrator.bat`](../scripts/orchestrator.bat) | Chay orchestrator truc tiep |
| [`cli.sh`](../scripts/cli.sh) | CLI helper script |
| [`ask.sh`](../scripts/ask.sh) | Quick ask — gui 1 cau hoi va nhan tra loi |
| [`test.bat`](../scripts/test.bat) | Chay test suite |
| [`test-gemini.sh`](../scripts/test-gemini.sh) | Test ket noi Gemini API |
| [`tunnel-setup.bat`](../scripts/tunnel-setup.bat) | Setup tunnel (cloudflared/ngrok) de truy cap tu mobile |

---

## Roo Code Templates (`roo-templates/`)

| File | Mo ta |
|------|-------|
| [`base.roomodes`](../roo-templates/base.roomodes) | Template `.roomodes` cho project moi |
| [`roocode-settings.json`](../roo-templates/roocode-settings.json) | Template Roo Code settings |
| [`rules/`](../roo-templates/rules/) | Template rules cho cac modes |

---

## Roo Code Rules (`.roo/`)

| File | Mo ta |
|------|-------|
| [`rules/01-conventions.md`](../.roo/rules/01-conventions.md) | Coding conventions chung |
| [`rules/01-global.md`](../.roo/rules/01-global.md) | Global rules cho tat ca modes |
| [`rules-build/coding-standards.md`](../.roo/rules-build/coding-standards.md) | Coding standards cho Build mode |
| [`rules-review/checklist.md`](../.roo/rules-review/checklist.md) | Review checklist |
| [`rules-spec/spec-template.md`](../.roo/rules-spec/spec-template.md) | Spec template |

---

## Data (`data/`)

| File | Mo ta |
|------|-------|
| [`analytics.json`](../data/analytics.json) | Du lieu analytics (cost, usage history) |
| [`budget-tracker.json`](../data/budget-tracker.json) | Budget tracking data |
| [`graphs/*.json`](../data/graphs/) | Knowledge graph data cho tung project (FashionEcom, LeQuyDon, VietNet2026, WebPhoto, RemoteTerminal) |

---

## Test

| File | Mo ta |
|------|-------|
| [`test-v2.2.js`](../test-v2.2.js) | Test suite v2.2 — 99 unit tests cho SLM/ShadowGit/TrustGraph/PipelineTracer |
| [`test/hardening.test.js`](../test/hardening.test.js) | Hardening test — 56 assertions: DecisionLock TTL/batch-save, auth prod guard, ContextManager cache, budget TZ, executionLog cap, _estimatePlanCost, getHistory, credit error detection |
| [`router/test-router.js`](../router/test-router.js) | Smoke tests cho smart router |
| Run all: `npm test` (155 pass / 0 fail) |  |

## Gateway / Portal (`gateway/`)

| File | Mo ta |
|------|-------|
| [`portal.html`](../gateway/portal.html) | Mobile-friendly dashboard (540 LoC) — Quick Run + Voice (vi-VN) + Dry-run + Estimate + SSE live + Templates + History + Snapshots + Active runs cancel |
| [`login.html`](../gateway/login.html) | Login page voi responsive design |
| [`auth-server.js`](../gateway/auth-server.js) | HMAC token auth + prod startup guard + safeCompare timing-safe + body size limit |
| [`nginx.conf`](../gateway/nginx.conf) | Reverse proxy + envsubst LITELLM_KEY (no hardcoded) + auth_request gating |

---

## Quick Reference — Ports

| Port | Service |
|------|---------|
| 5000 | Hermes Agent (Brain) |
| 5001 | Hermes WebUI (Mobile) |
| 5002 | LiteLLM Proxy + Dashboard |
| 5003 | Orchestrator REST API |
| 5004 | Analytics + Cost Dashboard |
