# ADR-0009: Bearer token + timing-safe compare cho API

- **Status**: accepted
- **Date**: 2026-04-10
- **Tags**: security

## Context

Orchestrator REST API (port 5003) expose:
- Scan project, plan task, execute agent
- LLM call → co the burn budget neu attacker chiem

Can auth nhe (khong phuc tap nhu JWT) nhung an toan.

## Decision

**Bearer token** (env `API_SECRET`) + **timing-safe compare** (`crypto.timingSafeEqual`):

```js
const authHeader = req.headers.authorization || '';
const token = authHeader.replace('Bearer ', '');
const expected = process.env.API_SECRET;
if (!token || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
  return res.status(401).json({ error: 'Unauthorized' });
}
```

Plus:
- Rate limit 60 req/min per IP, LRU-evict khi vuot 10K entry
- CORS restrict `ALLOWED_ORIGINS` (khong `*`)
- Max body 10MB (ho tro image base64)

## Rationale

- Bearer token don gian, HTTP standard
- Timing-safe compare chong timing attack
- Rate limit bao ve khoi brute force token
- Portal qua JWT rieng (khong dung API_SECRET nay)

## Consequences

### Tich cuc
- Implement nhanh
- Ket hop duoc moi HTTP client (curl, fetch...)
- Timing attack khong detect token length

### Tieu cuc
- Khong revoke duoc token don le (chi doi `API_SECRET` = revoke tat ca)
- Khong co scope/permission (all-or-nothing access)

## References

- `/src/api-server.js`
- env: `API_SECRET`, `ALLOWED_ORIGINS`, `RATE_LIMIT`
