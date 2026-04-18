# ADR-0010: Portal mobile-friendly + SSE live stream

- **Status**: accepted
- **Date**: 2026-04-16
- **Tags**: frontend, UX

## Context

Hermes Brain + Orchestrator API + LiteLLM la backend — can UI de:
- Chon project, task type, paste prompt
- Xem live progress (scan → plan → execute)
- Abort task dang chay
- Re-run task truoc

User thuong dung tu mobile (theo profile AI Engineer) → UI phai mobile-first.

## Decision

**Portal tai port 5005** — Express app serve HTML + SSE endpoint:

### Features
- Login (cookie + JWT) — admin/admin dev, env production
- Project selector (list tu folder `projects/`)
- Task type: build, fix, review, debug, cleanup, docs
- Voice input (vi-VN Web Speech API)
- **SSE live stream**: `/stream/:taskId` emit event scan, plan, agent-start, agent-output, agent-done, task-done
- Template library (save/load prompt hay dung)
- History 10 recent run, re-run button
- Git stash snapshot (rollback khi agent error)
- Active runs dashboard voi abort button

### Mobile-first
- Dashboard 5005 khac Analytics 5004 (5005 cho user, 5004 cho metrics)
- Viewport meta, touch-friendly button
- SSE khong WebSocket → kha tuong thich mobile battery (1-way)

## Rationale

- SSE don gian hon WebSocket (khong can xu ly reconnect phuc tap)
- LLM output natural streaming → SSE fit
- 1-way client←server du (command input qua REST POST)

## Consequences

### Tich cuc
- Mobile access tot (1 port 5005 expose)
- Abort task de (DELETE /runs/:id)
- Git stash rollback = safety net

### Tieu cuc
- SSE khong duplex → user input khong stream (chap nhan vi ngan)
- Voice input chi vi-VN (EN se pending)

## References

- Port 5005 Portal, port 5004 Analytics
- Related: CROSS-0002 (port allocation)
