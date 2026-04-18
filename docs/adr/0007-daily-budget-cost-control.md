# ADR-0007: Daily budget $2, timezone Asia/Ho_Chi_Minh

- **Status**: accepted
- **Date**: 2026-04-10
- **Tags**: cost, governance

## Context

LLM cost co the explode: 1 task loop vo han, 1 prompt 100K token... $50/ngay binh thuong khi khong kiem soat. Solo dev, budget han che.

Neu budget set theo UTC, user o VN se bi reset luc 7 AM sang — kho theo doi.

## Decision

- **`DAILY_BUDGET = $2.00`** (env, adjust duoc)
- **`BUDGET_TZ = Asia/Ho_Chi_Minh`** — reset luc 00:00 gio VN
- **CostTracker** track per-agent, per-day, per-task tai `/lib/cost-tracker.js`
- Khi >80% budget → log warning
- Khi >100% → reject new task, tra error `BUDGET_EXCEEDED`
- Override: env `BYPASS_BUDGET=1` cho emergency

## Rationale

- $2/day → $60/thang du cho solo dev (100+ task/day)
- Timezone VN → reset dung 0h de thay daily usage o dashboard
- Hard limit tranh stupid mistake (infinite loop)

## Consequences

### Tich cuc
- Khong bao gio bill surprise
- Visibility: dashboard hien 80% warning
- Force efficiency (dev tu lua model re)

### Tieu cuc
- Co luc budget het ma task dang chay → reject gay kho chiu
- Muon chay batch task se phai tach ngay

## References

- `/lib/cost-tracker.js`
- env: `DAILY_BUDGET`, `BUDGET_TZ`, `BYPASS_BUDGET`
- Related: ADR-0001
