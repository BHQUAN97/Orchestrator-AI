# Architecture Decision Records (ADR)

> Ghi lại các quyết định kiến trúc quan trọng, lý do, và hệ quả.

---

## ADR-0001: Role-Based Model Assignment (Superseded)

**Status**: Superseded bởi ADR-0011  
**Date**: 2026-04 (initial)

**Context**: Cần gán model cho từng agent role trong Orchestrator pipeline.

**Decision**: Scanner/Planner/Executor dùng `cheap`, Reviewer dùng `smart`, Architect dùng `opus`.

**Superseded by**: Bench 2026-04-18 cho thấy `cheap` (GPT-5.4 Mini) pass 100% kể cả R-tier, không cần `smart` cho Reviewer nữa.

---

## ADR-0002: Structured JSON Context

**Status**: Active  
**Date**: 2026-04

**Context**: Mỗi model có prompt format khác nhau. Orchestrator cần gửi context cho nhiều model mà không viết adapter riêng cho từng model.

**Decision**: Chuẩn hóa context thành JSON object duy nhất, inject vào system prompt template:

```json
{
  "project": { "name", "stack", "dir" },
  "task": { "id", "description", "role", "dependencies" },
  "locked_decisions": [...],
  "spec": "...",
  "plan": { "subtasks": [...] },
  "previous_results": { "scanner": {...}, "planner": {...} }
}
```

**Consequences**: 
- ✓ Model-agnostic: swap model không cần sửa context builder
- ✓ Consistent behavior khi A/B test
- ✗ JSON overhead ~200-400 tokens/call

---

## ADR-0003: Decision Lock Registry

**Status**: Active  
**Date**: 2026-04

**Context**: Agent override quyết định của agent khác → inconsistency, regression.

**Decision**: Tech Lead lock critical decisions vào `.sdd/decisions.lock.json`. Dev agent check lock trước khi ghi file.

**Implementation**:
- File: `router/decision-lock.js`
- Storage: `{project}/.sdd/decisions.lock.json` (JSON, persist qua restart)
- TTL: 4 giờ (env `DECISION_LOCK_TTL_HOURS`)
- Scope types: `api`, `database`, `auth`, `ui`, `architecture`, hoặc exact file path
- Match rules:
  - Exact: `scope === normalized_path`
  - Related files: `d.relatedFiles.some(f => pathMatches(f, normalized))`
  - Heuristic: detect `auth/`, `migration/`, `.schema.`, `api/` từ path

**Consequences**:
- ✓ Ngăn agent override quyết định đã lock
- ✓ Onboarding: new agent biết ngay decision đã locked
- ✗ False positive nếu heuristic quá broad
- ✗ Stale lock nếu TTL quá dài

---

## ADR-0004: LiteLLM Proxy Gateway

**Status**: Active  
**Date**: 2026-04

**Context**: Cần swap model mà không sửa code agent. Cần centralized cost tracking và rate limit.

**Decision**: Toàn bộ LLM call đi qua `http://localhost:5002` (LiteLLM Docker container). Agent chỉ biết alias.

**Model aliases** (trong `litellm_config.yaml`):
```yaml
cheap    → openrouter/openai/gpt-5.4-mini
fast     → google/gemini-3-flash
smart    → google/gemini-3-flash   # redirected từ Sonnet 4.6
default  → openrouter/deepseek/deepseek-v3.2
kimi     → openrouter/moonshot/kimi-k2.5
architect/opus → openrouter/anthropic/claude-opus-4-6
local-classifier → lm-studio/qwen2.5-1.5b-instruct
local-heavy → lm-studio/qwen2.5-7b-instruct
```

**Consequences**:
- ✓ Swap model = sửa YAML, không sửa code
- ✓ Centralized rate limiting, retry, fallback chain
- ✓ Single cost tracking point
- ✗ Single point of failure (nếu LiteLLM down → mọi thứ dừng)
- Mitigation: `fetchWithRetry` retries: 3, `ECONNREFUSED` → meaningful error message

---

## ADR-0005: Escalation Ladder

**Status**: Active  
**Date**: 2026-04

**Context**: Dev agent bị stuck không biết làm gì. Cần escalation path không dừng cả pipeline.

**Decision**: 3-tier escalation:

```
Dev Agent (cheap) 
  → stuck/error → Tech Lead (cheap)
      GUIDE      → hint, agent tự giải quyết
      REDIRECT   → thay đổi approach
      TAKE_OVER  → Tech Lead tự execute
      ESCALATE_ARCHITECT → leo thang lên
  → Tech Lead stuck → Architect (Opus 4.6)
      max 3 escalations/task
```

**Triggers** (6 conditions):
1. `consecutiveErrors >= 3`
2. `stuck_pattern` từ StuckDetector
3. `requires_locked_scope` (file trong decision lock)
4. `requires_architect_judgment` (system-wide design)
5. `circular_dependency` trong plan
6. `test_failure_count >= 5`

**Consequences**:
- ✓ Pipeline không dừng hẳn khi 1 agent fail
- ✓ Opus chỉ dùng khi thực sự cần (~2% task)
- ✗ Escalation overhead: 2-5s per escalation
- ✗ Max 3 escalations → nếu vẫn fail → abort

---

## ADR-0006: Hermes-Orchestrator Split

**Status**: Active  
**Date**: 2026-04

**Context**: Monolithic agent làm cả thinking + execution → khó scale, khó test.

**Decision**: Tách thành 2 service độc lập:

| | Hermes (Brain) | Orchestrator (Hands) |
|-|---------------|---------------------|
| Port | 5000 | 5003 |
| State | Stateful | Stateless |
| Role | Memory, learning, routing decision | Execution, file ops, tool use |
| Restart safe | Cần persistence | Yes (stateless) |

**Shared state**: `.sdd/decisions.lock.json`, LiteLLM proxy (5002)

**AgentLoop integration**: HermesBridge module là "thin client" — gọi Hermes REST API hoặc dùng local fallback (SmartRouter embedded).

**Consequences**:
- ✓ Orchestrator có thể restart mà không mất memory
- ✓ Hermes có thể học trong khi Orchestrator execute
- ✗ Network hop thêm ~5-10ms cho mỗi routing decision
- ✗ Cần maintain 2 Docker services

---

## ADR-0007: Daily Budget Cap

**Status**: Active  
**Date**: 2026-04

**Context**: LLM cost có thể spike không kiểm soát trong automated pipelines.

**Decision**: 
- Hard cap trong LiteLLM: `max_budget: 5.0` USD/ngày
- Timezone: `Asia/Ho_Chi_Minh` (env `BUDGET_TZ`)
- Per-session cap: `--budget <usd>` CLI flag → `BudgetTracker`
- Daily cap: `CostTracker` persistent (`.orcai/cost-tracker.json`)

**Warning thresholds**: 80% → yellow warning, 100% → red + reset countdown

**Consequences**:
- ✓ Không bao giờ bị surprise bill
- ✓ Mobile-friendly: thấy countdown đến reset
- ✗ Pipeline abort giữa chừng nếu budget hết
- Mitigation: SessionContinuity lưu state → có thể resume

---

## ADR-0008: Lazy Load Optional Modules

**Status**: Active  
**Date**: 2026-04

**Context**: Một số modules cần native binary (sharp, canvas), native Windows API, hoặc optional deps. Import ở top level → crash nếu không có.

**Decision**: Wrap trong `(() => { try { return require(...); } catch { return {}; } })()`.

**Pattern**:
```js
const { FsWatcher } = (() => { try { return require('../lib/fs-watcher'); } catch { return {}; } })();
const { shutdownMemoryWorkers } = (() => { try { return require('../lib/memory'); } catch { return {}; } })();
```

**Affected modules**: audit-log, feature-registry, Windows tools (9), AST tools, screenshot, embedding-search, auto-concurrency.

**Consequences**:
- ✓ Core agent chạy được dù thiếu optional deps
- ✓ Windows-specific tools không crash trên macOS
- ✗ Lỗi import bị swallow → khó debug
- Mitigation: `/doctor` command kiểm tra tất cả optional deps

---

## ADR-0009: Bearer Token Auth cho Gateway

**Status**: Active  
**Date**: 2026-04

**Context**: Portal (port 5005) exposed ra internet cho mobile access → cần auth.

**Decision**: 
- Cookie-based session cho Portal UI
- Bearer token cho REST API
- Timing-safe compare (`crypto.timingSafeEqual`) để tránh timing attack
- Token từ env `GATEWAY_TOKEN` (không hardcode)

**Consequences**:
- ✓ Mobile access an toàn
- ✓ Không có brute-force timing leak
- ✗ Single token → không có per-user granularity
- ✗ Token rotation cần restart service

---

## ADR-0010: Portal + SSE Streaming

**Status**: Active  
**Date**: 2026-04

**Context**: Cần monitor pipeline progress từ mobile (màn hình nhỏ) mà không cần terminal.

**Decision**: 
- Portal: `http://localhost:5005/portal` — mobile-first UI (single file HTML)
- SSE endpoint: `/api/stream/{sessionId}` — live progress events
- Event types: `classify`, `scan`, `plan`, `execute`, `complete`, `error`
- Auto-reconnect SSE (EventSource)

**Consequences**:
- ✓ Monitor từ điện thoại không cần SSH
- ✓ Zero install client (browser-only)
- ✗ SSE không có binary protocol → large payloads kém hiệu quả
- ✗ Không có offline support

---

## ADR-0011: Data-Driven Model Selection (Supersedes ADR-0001)

**Status**: Active  
**Date**: 2026-04-18 (sau benchmark)

**Context**: ADR-0001 assign model theo intuition, không có data. Benchmark 2026-04-18 cho kết quả ngược intuition.

**Key findings từ benchmark**:

| Model | A-tier | B-tier | R-tier | Cost/task | Verdict |
|-------|--------|--------|--------|-----------|---------|
| GPT-5.4 Mini | 100% | 100% | 100% | $0.010-0.015 | **Default cho 95% tasks** |
| Gemini 3 Flash | 100% | 98% | 90% | $0.008-0.012 | Reviewer/Dispatcher |
| Claude Sonnet 4.6 | 85% | 60% | 45% | $0.20-0.40 | **Removed** |
| Claude Opus 4.6 | 99% | 98% | 97% | $0.80-2.00 | Architect escalation (~2%) |

**Decision**: 
- Remove Sonnet 4.6 từ default routing (`smart` alias → Gemini Flash)
- `cheap` (GPT-5.4 Mini) làm default cho builder/scanner/planner/debugger/docs roles
- `fast` (Gemini Flash) cho reviewer/dispatcher
- `architect` (Opus 4.6) chỉ khi escalation hoặc user override

**Role map v2.3**:
```
cheap (95%): builder, fe-dev, be-dev, scanner, planner, debugger, docs
fast  (3%):  reviewer, dispatcher, synthesizer
architect (2%): escalation, system design, --role architect
```

**Consequences**:
- ✓ 70-95% cost reduction từ Sonnet → cheap
- ✓ Accuracy không giảm (thực tế tăng ở R-tier)
- ✗ Sonnet 4.6 artifacts vẫn còn trong benchmark fixtures (cần update)
- ✗ Cần re-run bench định kỳ khi model providers cập nhật

---

## Ghi chú về ADR process

Các ADR file gốc (2 ADR đầu tiên) nằm tại `docs/adr/`. Từ ADR-0003 trở đi được record trong quá trình development và backfill vào đây.

**Format**: Context → Decision → Consequences (per Michael Nygard).

**Khi nào tạo ADR mới**: Khi thay đổi ảnh hưởng đến nhiều module, hoặc decision có trade-off không hiển nhiên, hoặc decision dựa trên data/experiment.
