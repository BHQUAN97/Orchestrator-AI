# ADR-0001: 5-Tier Model Hierarchy (Cost-Optimized Agent Routing)

- **Status**: superseded by ADR-0011 (2026-04-18)
- **Date**: 2026-04-16
- **Deciders**: BHQUAN97
- **Tags**: ai-routing, cost, architecture

> ⚠ **Superseded**: ADR-0011 thay the quyet dinh nay sau bench data 2026-04-18 cho thay:
> - cheap (GPT-5.4 Mini) 100% pass A+B+R tier vs Sonnet 60%, DeepSeek 40%
> - Sonnet da remove khoi config
> - Role map v2.3 don gian hon: 95% cheap + 3% fast + 2% architect
> Xem ADR-0011 de co role map + data hien hanh.

## Context

Dung 1 LLM premium (Claude Opus) cho moi task → chi phi ~$15/1M token → nhanh chong vuot budget $2/ngay. Nhung nhieu task khong can Opus: scan code, generate boilerplate, review voi OWASP checklist... co the dung model re hon (DeepSeek $0.30/1M, Gemini Flash $0.15/1M).

Van de: **Router phai quyet dinh model nao cho task nao** — khong the hardcode, phai dua vao complexity + task type.

## Decision

Chia agent thanh **5 tier** theo gia + capability, map `AGENT_ROLE_MAP` trong `/router/orchestrator-agent.js` lines 38-50:

| Agent | Model | Cost/1M | Use case |
|---|---|---|---|
| architect | Claude Opus 4.6 | $15 | System design, extreme complexity |
| tech-lead | Claude Sonnet 4.6 | $3 | Plan review, escalation handling |
| debugger | Claude Sonnet 4.6 | $3 | Complex multi-file debugging |
| planner | DeepSeek V3.2 | $0.30 | Execution plan from scanner data |
| fe-dev | DeepSeek V3.2 | $0.30 | Frontend code (React, Next.js, CSS) |
| be-dev | DeepSeek V3.2 | $0.30 | Backend code (NestJS, Express, API) |
| scanner | GPT-5.4 Mini | $0.20 | Project scanning, context extraction |
| docs | GPT-5.4 Mini | $0.20 | Documentation, formatting |
| reviewer | Gemini 3 Flash | $0.15 | Code review, OWASP scan |
| dispatcher | Gemini 3 Flash | $0.15 | Result synthesis (final) |

Escalation flow: dev agent → tech-lead (Sonnet) → architect (Opus) chi khi thuc su can. Max 3 escalation/task.

## Rationale

- Scanner/reviewer la pattern matching → model re van lam tot
- Dev la apply pattern da biet → DeepSeek tot gia/chat luong
- Tech-lead quyet dinh → can Sonnet (cost accept duoc, ~10% goi)
- Architect chi khi phuc tap → Opus dat nhung hiem xai

## Consequences

### Tich cuc
- **70-95% cost reduction** vs single Opus
- $2/day budget cho 100+ task duoc
- Scale agent rieng theo cost

### Tieu cuc
- Router logic phuc tap (smart-router.js 135 lines)
- Model chuyen doi co learning curve (DeepSeek khac Sonnet ve prompt style)
- Quality do dong tuy model — can context normalization (ADR-0002)

### Rui ro
- **Provider outage** (DeepSeek down) → mitigation: LiteLLM fallback chain (ADR-0004)
- **Price change**: OpenRouter co the tang gia → mitigation: monitor DAILY_BUDGET, alert khi >80%

## Alternatives Considered

### Alt 1: Chi 1 model premium (Opus)
- **Nhuoc**: $30+/ngay cho 100 task — khong sustainable

### Alt 2: Chi 1 model cheap (DeepSeek cho moi viec)
- **Nhuoc**: Chat luong review/debug kem, khong escalate duoc

### Alt 3: Phan theo task type (FE vs BE)
- **Nhuoc**: Khong capture complexity (simple FE fix khac architecture)

## Implementation Notes

- `/router/orchestrator-agent.js:38-50` — AGENT_ROLE_MAP
- `/router/smart-router.js:19-135` — scoring logic
- `/litellm_config.yaml` — model aliases (`default`, `smart`, `fast`, `cheap`, `architect`)
- Daily budget enforce tai `/lib/cost-tracker.js`

## References

- Related: ADR-0004 (LiteLLM), ADR-0005 (escalation), ADR-0007 (budget)
