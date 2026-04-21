# Giới thiệu dự án — OrcAI

## 1. OrcAI là gì?

OrcAI (AI Orchestrator) là **multi-model AI coding agent system** tự xây — tương tự Claude Code nhưng tự chủ về model routing. Thay vì gọi 1 model đắt tiền cho mọi task, OrcAI phân tích từng prompt và route đến model rẻ nhất có thể pass.

**Solo developer project** — viết bằng Node.js, chạy trên Windows (WSL không bắt buộc), điều khiển từ mobile qua WebSocket terminal.

---

## 2. Tại sao cần xây OrcAI?

### Vấn đề với Claude Code / Cursor / Copilot

| Vấn đề | Tác động |
|--------|---------|
| Mọi request đều dùng cùng 1 model premium | Tốn $$$, đặc biệt khi task đơn giản |
| Không tích lũy kinh nghiệm giữa các session | Lặp lại cùng sai lầm |
| Không có budget guard | Budget bị vượt không hay |
| Không route theo file domain | Auth file và test file được xử lý như nhau |
| Không có decision lock | Agent tự override quyết định cũ |

### Insight từ benchmark (2026-04-18)

Chạy 533 tests trên tập benchmark A/B/R-tier, kết quả:

| Model | Pass rate (A+B+R) | Cost/task |
|-------|-------------------|-----------|
| GPT-5.4 Mini (`cheap`) | **100%** | $0.010–0.015 |
| Gemini 3 Flash (`fast`) | 95% | $0.008–0.012 |
| Claude Sonnet 4.6 (`smart`) | 60% | $0.20–0.40 |
| Claude Opus 4.6 (`architect`) | 98% | $0.80–2.00 |

**Kết luận:** `cheap` model handle được 95%+ workload, Opus chỉ cần cho ~2% task complexity cao. Route đúng → giảm 70-95% chi phí so với dùng Sonnet/Opus cho mọi thứ.

---

## 3. Mục tiêu

### Mục tiêu kỹ thuật

1. **Cost efficiency**: Giảm token cost 70-95% so với single-model approach
2. **Zero regression**: Routing sai → không thay đổi behavior, không introduce bug
3. **Self-improving**: Tích lũy kinh nghiệm (`gotcha`, `lesson`) qua các session
4. **Mobile-first**: Điều khiển từ điện thoại qua WebSocket terminal
5. **Autonomous**: Can thiệp tối thiểu — tự sửa lỗi 3 lần trước khi hỏi

### Mục tiêu dài hạn

- Phase 5 (đang thực hiện): Fine-tune local 7B model để thay thế `cheap` cloud model → cost = $0
- MLX trên M-series Mac (tương lai): 13B+ offline inference

---

## 4. Hai "não" của hệ thống

### Hermes — Brain (port 5000)
> *Decides WHAT to do*

- Stateful: giữ memory, học từ lỗi, lock quyết định quan trọng
- Components: MemoryStore, DecisionLock, SmartRouter, SLMClassifier
- Chạy như Docker service, expose REST API

### Orchestrator — Hands (port 5003)
> *Decides HOW to do it*

- Stateless: nhận task, route, execute, trả kết quả
- Pipeline: Scanner → Planner → TechLead → Dev Agents → Synthesizer
- Mỗi bước có model assignment riêng

```
┌─────────────────────────────────────────────────┐
│                    USER                         │
│   orcai CLI  /  Portal (mobile)  /  REST API    │
└─────────────────┬───────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────┐
│              REQUEST ANALYZER                   │
│   local-classifier (1.5B) → cheap (fallback)    │
│   Output: { goal, complexity, routing, files }  │
└─────────────────┬───────────────────────────────┘
                  │
        ┌─────────▼─────────┐
        │   HERMES BRIDGE   │
        │  SmartRouter       │──── Decision Locks
        │  Memory recall     │──── Cross-project memory
        └─────────┬─────────┘
                  │
┌─────────────────▼───────────────────────────────┐
│              AGENT LOOP                         │
│   LLM call → Tool execution → Self-correction  │
│   BudgetTracker, StuckDetector, ContextGuard    │
└─────────────────┬───────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────┐
│           LITELLM GATEWAY (:5002)               │
│   cheap / fast / smart / architect / local      │
└─────────────────────────────────────────────────┘
```

---

## 5. Tech stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js >= 18, CommonJS |
| CLI | Commander.js v12 |
| Terminal UI | chalk, ora, inquirer |
| LLM Gateway | LiteLLM (Docker) |
| Model inference | LiteLLM → OpenRouter / Google Direct / LM Studio |
| Memory | Append-only JSONL + TF-IDF (worker_threads) |
| MCP | stdio + SSE transport (spec 2024-11-05) |
| Services | Docker Compose (Hermes, LiteLLM, Orchestrator, Analytics, Portal) |
| OS target | Windows 10/11 (native), macOS (via bash) |

---

## 6. Thư mục project

```
ai-orchestrator/
├── bin/                    CLI entrypoints (orcai + utilities)
├── lib/                    Core modules (57 files)
│   ├── agent-loop.js       Vòng lặp tự trị chính
│   ├── hermes-bridge.js    Kết nối SmartRouter + Memory + Locks
│   ├── request-analyzer.js Pre-routing classifier
│   ├── memory.js           Experience store
│   ├── budget.js           Cost tracking + cap
│   ├── hooks.js            Pre/Post tool hooks
│   └── ...
├── tools/                  61 tools cho agent sử dụng
├── router/                 Orchestrator pipeline + SmartRouter
├── prompts/                System prompt templates
├── benchmark/              E2E test harness
├── graph/                  Trust graph
├── doc/                    Documentation (đây)
├── .orcai/                 Runtime data (gitignored)
│   ├── memory/lessons.jsonl
│   ├── transcripts/
│   ├── sessions/
│   └── ft-output/
└── docker-compose.yml
```

---

## 7. Trạng thái dự án (2026-04-21)

| Phase | Status | Kết quả |
|-------|--------|---------|
| Phase 1: Core CLI | ✓ Done | Agent loop + tools + MCP |
| Phase 2: Routing | ✓ Done | SmartRouter + HermesBridge |
| Phase 3: Multi-agent | ✓ Done | Orchestrator pipeline |
| Phase 4: Self-improve | ✓ Done | Memory + SelfHealer + ContextGuard |
| Phase 5: Fine-tune | 🔄 Round 8 | Base=78.8%, R8=85.2% (+6.4pt) |
| Phase 6: Local inference | 📋 Planned | GTX 1060 6GB → Q4_K_M 7B |
