# ADR-0008: Lazy load optional modules (audit log, feature registry)

- **Status**: accepted
- **Date**: 2026-04-16
- **Tags**: reliability

## Context

Core orchestration (route agent, call LLM) phai luon chay. Nhung modules phu (audit log, feature registry, cost tracker) co the crash khi:
- File disk permission sai
- DB SQLite corrupt
- Module chua implement day du

Neu core require cac module nay → crash hoan toan vi 1 audit bug.

## Decision

**Optional module lazy-init + fail soft**:

```js
let auditLog;
try {
  auditLog = require('./audit-log');
} catch (e) {
  console.warn('Audit log unavailable:', e.message);
  auditLog = { log: () => {} };  // no-op fallback
}
```

- Core (orchestrator, router, context-manager) **bat buoc**
- Audit log, feature registry, trace store **optional**
- Missing module = log warning, tiep tuc

## Rationale

- Audit rot = mat log, nhung khong mat chuc nang
- Dev local khong can full stack (skip Hermes brain)
- Production robustness: 1 module loi khong down ca he

## Consequences

### Tich cuc
- Robust khi deploy incomplete
- Easier local dev
- No single point of failure cho non-critical

### Tieu cuc
- Mat observability neu audit fail (khong biet gi crash)
- Can monitor warning log de biet module nao down

### Rui ro
- **Silent failure**: audit silently broken → mitigation: health check endpoint kiem tra moi module

## References

- `/lib/audit-log.js`, `/lib/feature-registry.js`
