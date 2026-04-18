# AI Orchestrator — Architecture Decision Records

> Multi-model AI coding agent system. Xem `.claude-shared/adr/TEMPLATE.md` de them moi.

## Index

- [ADR-0001](0001-five-tier-model-hierarchy.md) — 5-tier model hierarchy (Opus/Sonnet/DeepSeek/Gemini/GPT-Mini)
- [ADR-0002](0002-structured-json-context.md) — Structured JSON context cho moi agent (chong drift)
- [ADR-0003](0003-decision-lock-registry.md) — Decision Lock de tranh FE/BE contract drift
- [ADR-0004](0004-litellm-proxy-gateway.md) — LiteLLM lam abstraction layer, khong call direct
- [ADR-0005](0005-tech-lead-escalation.md) — Escalation ladder (dev → tech-lead → architect)
- [ADR-0006](0006-hermes-orchestrator-split.md) — Tach Hermes (brain) va Orchestrator (hands)
- [ADR-0007](0007-daily-budget-cost-control.md) — Daily budget $2, timezone Asia/Ho_Chi_Minh
- [ADR-0008](0008-lazy-load-optional-modules.md) — Lazy load audit log/feature registry (fail soft)
- [ADR-0009](0009-bearer-token-api-auth.md) — Bearer token + timing-safe compare cho API
- [ADR-0010](0010-portal-sse-streaming.md) — Portal mobile-friendly + SSE live stream
