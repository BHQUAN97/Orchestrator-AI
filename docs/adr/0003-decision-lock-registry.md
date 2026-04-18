# ADR-0003: Decision Lock Registry (chong FE/BE contract drift)

- **Status**: accepted
- **Date**: 2026-04-16
- **Tags**: ai-routing, architecture

## Context

Multi-agent: FE-dev va BE-dev chay song song → moi agent tu quyet API contract → contract drift (FE expect `{user}`, BE return `{data: {user}}`). DB schema cung bi doi giua cac agent neu khong lock.

## Decision

**Tech Lead lock critical decision** vao `.sdd/decisions.lock.json`. Dev agent nhan locked decisions trong context, muon doi phai escalate.

### Cau truc
```json
[
  {
    "decision": "API response envelope: { success, data, message, meta }",
    "scope": "api",
    "approvedBy": "tech-lead",
    "reason": "FE refactor do drift truoc day",
    "expiresAt": "2026-04-20T00:00:00Z"
  }
]
```

### Scope
- `api` — API contract, envelope format
- `database` — schema, table structure
- `architecture` — overall design
- `ui` — UI pattern
- `auth` — auth mechanism
- File path cu the (e.g., `src/schema.ts`)

### TTL
- Default **4 gio** (env `DECISION_LOCK_TTL_HOURS`)
- Truoc day 24h, giam vi decision stale sau 4h (project thay doi nhanh)

### Lazy init
- Audit log + feature registry optional, **fail soft** neu load loi
- Core orchestration khong crash khi audit module broken

## Rationale

- Tech Lead la human-in-loop checkpoint → critical decision co human approve
- Lock = immutable trong TTL → dev agent khong the override
- JSON file persist → orchestrator restart khong mat lock

## Consequences

### Tich cuc
- Architecture coherence sau khi tech-lead sign-off
- Audit trail: biet ai lock, khi nao, ly do
- Giam rework (BE doi schema → FE khong bi mat lien lac)

### Tieu cuc
- Schema change giua task can escalation → cham hon
- Lock expire 4h co the qua ngan voi task lon → TODO: per-scope TTL

### Rui ro
- **Stale lock**: decision qua han nhung chua clear → mitigation: cleanup job 10 phut
- **Lock conflict**: 2 tech-lead decision conflict → hien chua co, TODO resolver

## Alternatives Considered

### Khong lock, tin agent
- **Nhuoc**: drift nhu da no xay ra

### Git commit hook check contract
- **Uu**: enforce deterministic
- **Nhuoc**: phat hien sau khi code, khong ngan chan

### Database version per schema
- **Uu**: theo doi chat
- **Nhuoc**: over-engineer, schema ngoai DB cung can lock

## References

- `/router/decision-lock.js:1-120`
- Related: ADR-0002 (lockedDecisions in context)
