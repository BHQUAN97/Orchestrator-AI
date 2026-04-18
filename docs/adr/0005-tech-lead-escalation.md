# ADR-0005: Escalation ladder (dev → tech-lead → architect)

- **Status**: accepted
- **Date**: 2026-04-16
- **Tags**: ai-routing, governance

## Context

Dev agent (DeepSeek) gap van de phuc tap:
- Analysis mat qua lau khong thay huong
- Can doi API contract / DB schema
- Bug spread >3 file khong ro root cause
- Conflict voi locked decision
- Security implications unclear

Khong the tu quyet → can escalate len model manh hon.

## Decision

Escalation 3-tier voi **max 3 lan / task**:

```
Dev Agent (DeepSeek)
  ↓ escalate khi khong resolve duoc
Tech Lead (Sonnet)
  ├─ GUIDE: provide direction (dev thu lai)
  ├─ REDIRECT: switch agent khac (e.g., debugger specialist)
  ├─ TAKE_OVER: tech lead handle truc tiep
  └─ ESCALATE_ARCHITECT: complex design → Opus 4.6
```

Max `MAX_ESCALATIONS_PER_TASK = 3` tranh infinite loop.

Trigger conditions trong `/router/tech-lead-agent.js:27-120`:
- Dev tra ve `action: "escalate"` voi reason
- Smart router detect confidence thap
- Dev vi pham locked decision

## Rationale

- Pyramid (nhieu dev rank thap, it tech-lead + architect) → cost optimal
- Model cao hon co context window rong hon → xu ly edge case tot
- Max 3 → khong burn budget qua 1 task

## Consequences

### Tich cuc
- Complex case khong stuck o dev model yeu
- Human-in-loop optional (tech-lead co the la LLM auto)
- Cost control: chi goi Opus khi thuc su can

### Tieu cuc
- Latency tang khi escalate (moi tang +10-30s)
- Lich su dai → context pollution → can summary

### Rui ro
- **Infinite escalation**: dev loop fail → mitigation: MAX_ESCALATIONS
- **Tech-lead confidence cao ma sai** → mitigation: architect la final say (phai dat/khong loop)

## Alternatives Considered

### Chi 1 model (khong escalate)
- **Nhuoc**: hoac qua dat hoac qua yeu cho case complexity khac nhau

### Parallel voting (3 model vote)
- **Uu**: diverse perspectives
- **Nhuoc**: 3x cost, ambiguous voting logic

## References

- `/router/tech-lead-agent.js`
- Related: ADR-0001, ADR-0003
