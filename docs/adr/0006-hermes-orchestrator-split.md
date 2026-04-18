# ADR-0006: Tach Hermes (brain) va Orchestrator (hands)

- **Status**: accepted
- **Date**: 2026-04-01
- **Tags**: architecture

## Context

Ban dau orchestrator lam tat ca: scan, plan, execute, nho nguoi dung, quyet dinh. Do do:
- Memory leak (conversation history khong evict)
- Kho test (logic tron)
- Khong reuse duoc learning cross-task

## Decision

Tach thanh 2 service:

### Hermes Brain (port 5000)
- Memory + learning + decision-making
- ConversationManager, TraceStore, ContextCache, CostTracker
- Khong call LLM truc tiep
- Persistent state (decision lock, audit log)

### Orchestrator Hands (port 5003)
- Execution planning + agent routing
- Call LiteLLM
- Stateless (state luu Hermes)
- Public REST API cho Portal

### Shared
- Cung dung `.sdd/decisions.lock.json`
- Cung dung LiteLLM proxy

## Rationale

- Separation of concerns: brain (thinking) vs hands (doing)
- Hermes persistent → restart Orchestrator khong mat learning
- Scale rieng: Orchestrator dupli khi cao traffic, Hermes 1 instance

## Consequences

### Tich cuc
- Test unit rieng cho moi service
- Doi model router khong dong cham memory
- Clean architecture

### Tieu cuc
- 2 container chay → them maintenance
- Network call giua 2 service (~10ms internal)

## References

- Docker compose services `hermes` + `orchestrator`
- Related: ADR-0001
