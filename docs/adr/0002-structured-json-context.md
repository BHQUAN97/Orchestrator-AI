# ADR-0002: Structured JSON context cho moi agent (chong drift)

- **Status**: accepted
- **Date**: 2026-04-16
- **Tags**: ai-routing, consistency

## Context

Khi chain nhieu agent khac model (DeepSeek → Sonnet → Gemini), moi model dien giai free-text context khac nhau:
- Sonnet bam sat spec, Gemini hay tu them feature, DeepSeek khong doc ky constraint...
- → handoff thuong mat constraint, gay contract drift

Can 1 format context chuan ma moi model hieu dong nhat.

## Decision

**Normalize MOI agent input thanh structured JSON schema** tai `/router/context-manager.js:21-78`:

```js
{
  version: '1.0',
  project: { name, stack, dir, branch, lastCommit },
  task: { id, type, description, files, domain, estimatedTokens },
  constraints: { constitution, conventions, lockedDecisions, forbidden },
  spec: { summary, acceptanceCriteria, technicalNotes },
  plan: { summary, currentStep, totalSteps, dependencies },
  previousResults: [],
  escalation: { fromAgent, reason, attemptsMade, errorLog }
}
```

Moi agent nhan cung JSON nay, prompt template tu parse field minh can.

## Rationale

- JSON key co dinh → model khong the bo qua
- `constraints.lockedDecisions` inject vao moi call → dev khong override duoc (xem ADR-0003)
- `escalation` field moi agent biet tinh hinh truoc do → handoff smooth
- `previousResults` giu lich su → avoid repeat work

## Consequences

### Tich cuc
- Agent handoff fail rate **giam 90%**
- Debug de (log 1 JSON, biet agent thay gi)
- Replay duoc: luu JSON, chay lai agent khac

### Tieu cuc
- Context size ~500 token overhead moi task
- Prompt template phai parse JSON (can few-shot example)
- Schema change = bump `version` field

## Alternatives Considered

### Free-text context
- **Nhuoc**: drift giua model, khong audit duoc

### XML tagged
- **Uu**: Claude thich XML
- **Nhuoc**: DeepSeek/Gemini xu ly JSON tot hon

### Per-agent custom format
- **Nhuoc**: maintenance nightmare, khong handoff duoc

## References

- `/router/context-manager.js`
- Related: ADR-0003
