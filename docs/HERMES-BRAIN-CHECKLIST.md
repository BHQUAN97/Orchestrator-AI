# Hermes Brain — Implementation Checklist

> Mục tiêu: Nâng OrcAI từ "notepad rỗng" thành AI thực sự học được từ kinh nghiệm.
> Cập nhật: 2026-05-03

---

## Layer 1 — Signal Density (Today)
*Vấn đề: Brain không có đủ data để học. Memory chỉ có 4 entries, TF-IDF keyword search sai context.*

### 1A — Wire Embeddings vào memory.search() ✅ 2026-05-03
- [x] `lib/memory.js`: EmbeddingStore.search() via `_getEmbedStore()` lazy-init
- [x] Fallback về TF-IDF nếu embedding index chưa có / fail
- [x] Lazy-load EmbeddingStore (không block nếu LM Studio offline)

### 1B — Mở rộng Auto-save Signal Capture ✅ 2026-05-03
- [x] `lib/agent-loop.js`: Save lesson cho MỌI task completion (kể cả fail)
- [x] `lib/agent-loop.js`: Save `type: 'model_escalation'` khi cheap → smart → architect
- [x] `lib/self-healer.js`: Enrich gotcha entry với context (tool chain + error_type)
- [x] `lib/agent-loop.js`: Save `type: 'tool_pattern'` khi tool sequence → success

### 1C — Outcome Metadata trong mọi Lesson Entry ✅ 2026-05-03
- [x] `lib/memory.js` append(): `outcome`, `model_used`, `model_final`, `cost_usd`, `confidence`, `helped_count`, `used_count`, `grade`, `tags`
- [x] `lib/agent-loop.js`: `_calcConfidence()` = 0.7 − 0.15/escalation − 0.01/iteration_over_10
- [x] `lib/agent-loop.js`: `cost_usd` từ `this.budget.spentUsd`

---

## Layer 2 — Contextual Intelligence (Tuần 2)
*Vấn đề: Memory recall dump thô vào prompt — noise nhiều hơn signal.*

### 2A — Lesson Confidence Scoring khi Inject ✅ 2026-05-03
- [x] `lib/hermes-bridge.js`: `_rankMemory()` — semantic×0.4 + helped_ratio×0.3 + recency×0.2 + model_match×0.1
- [x] Chỉ inject entries có `rank > 0.5`; `established_pattern` bypass threshold
- [x] `formatMemoriesForPrompt()`: hiển thị `grade + score` metadata cho agent

### 2B — Lesson Graduation Mechanic ✅ 2026-05-03
- [x] `lib/memory.js`: `grade` field — `gotcha → lesson → established_pattern → deprecated`
- [x] `lib/memory.js`: `promoteGrade(id)` — auto khi `helped_count >= 5 AND confidence >= 0.85`
- [x] `lib/memory.js`: `deprecate(id, reason)` — manual hoặc conflict detected
- [x] `lib/memory.js` search(): Filter out `deprecated` / `suspect` entries

### 2C — RAG cho Cloud Models (established_patterns) ✅ 2026-05-03
- [x] `lib/rag-prompt-builder.js`: `getRagMode()` — `'full' | 'patterns_only' | 'none'`
- [x] `getEstablishedPatterns()`: đọc lessons.jsonl, filter grade=established_pattern
- [x] Cloud execute models: nhận `## Proven Patterns` block thay vì full RAG

### 2D — Model-Specific Memory Tagging ✅ 2026-05-03
- [x] `lib/memory.js` append(): auto-tag `#cheap-success`, `#smart-fail`, etc.
- [x] `lib/memory.js` search(): `modelId` param, boost ×1.2 cho matching model tags
- [x] `lib/hermes-bridge.js`: Pass `modelId` vào `getRelevantMemories()` + `recordMemoryOutcome()`

---

## Layer 3 — Self-Improvement Loop (Tháng 2)
*Vấn đề: System không cải thiện tự động theo thời gian.*

### 3A — Session-end Reflection
- [ ] Tạo `lib/session-reflect.js`: Auto-call GPT-5.4 Mini sau mỗi session
  - Input: tool call history + outcomes summary
  - Output: 2-3 structured lessons → append vào memory
  - Chi phí: ~$0.001/session
- [ ] `lib/agent-loop.js`: Gọi SessionReflector khi task_complete (non-blocking, background)

### 3B — Outcome Feedback Loop
- [ ] `lib/memory.js`: Method `recordUsage(id, helped: bool)`: update `helped_count` / `used_count`
- [ ] `lib/hermes-bridge.js`: Sau mỗi task complete, check recalled lessons → `recordUsage(id, outcome === 'success')`
- [ ] `lib/memory.js`: Lesson với `helped_count < 0` sau 5 uses → auto-flag `suspect`

### 3C — Training Data Extraction
- [ ] `bin/orcai-extract-training-data.js` (stub exists): Hoàn thiện extraction pipeline
  - Extract `(system_prompt, [tool_calls], outcome)` triples mỗi session
  - Lưu vào `.orcai/training/YYYY-MM-DD.jsonl`
- [ ] Chuẩn bị format cho fine-tune Qwen 7B local (GTX 1060 6GB)

---

## Files thay đổi — Tổng hợp

| File | Layer | Thay đổi chính |
|---|---|---|
| `lib/memory.js` | 1A, 1C, 2B, 2D | Semantic search, outcome metadata, graduation, model tagging |
| `lib/agent-loop.js` | 1B, 1C | Expand auto-save, outcome metadata, cost tracking |
| `lib/self-healer.js` | 1B | Enrich gotcha entries |
| `lib/hermes-bridge.js` | 2A, 2D | Ranking formula, pass modelId |
| `lib/rag-prompt-builder.js` | 2C | Cloud model RAG for established_patterns |
| `lib/session-reflect.js` | 3A | NEW — session reflection |
| `bin/orcai-extract-training-data.js` | 3C | Complete training extraction |

---

## Tiến độ

- [x] Layer 1 hoàn thành (2026-05-03)
- [x] Layer 2 hoàn thành (2026-05-03)
- [ ] Layer 3 hoàn thành
- [x] Tests pass: `npm run test:all` — 161/161 ✅
- [x] Commit + Push — `3390c4c`
