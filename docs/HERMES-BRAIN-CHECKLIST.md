# Hermes Brain — Implementation Checklist

> Mục tiêu: Nâng OrcAI từ "notepad rỗng" thành AI thực sự học được từ kinh nghiệm.
> Cập nhật: 2026-05-03

---

## Layer 1 — Signal Density (Today)
*Vấn đề: Brain không có đủ data để học. Memory chỉ có 4 entries, TF-IDF keyword search sai context.*

### 1A — Wire Embeddings vào memory.search()
- [ ] `lib/memory.js` line 139-150: Thay TF-IDF bằng `EmbeddingStore.search()` (cosine similarity)
- [ ] Fallback về TF-IDF nếu embedding index chưa có / fail
- [ ] Lazy-load EmbeddingStore (không block nếu LM Studio offline)

### 1B — Mở rộng Auto-save Signal Capture
- [ ] `lib/agent-loop.js` line 363-375: Save lesson cho MỌI task completion (kể cả fail)
- [ ] `lib/agent-loop.js`: Save `type: 'model_escalation'` khi cheap → smart → architect
- [ ] `lib/self-healer.js`: Enrich gotcha entry với context (tool chain dẫn đến lỗi)
- [ ] `lib/agent-loop.js`: Save `type: 'tool_pattern'` khi tool sequence → success

### 1C — Outcome Metadata trong mọi Lesson Entry
- [ ] `lib/memory.js` append(): Thêm fields: `outcome`, `model_used`, `model_final`, `cost_usd`, `confidence`, `helped_count`, `used_count`
- [ ] `lib/agent-loop.js`: Tính `confidence` = f(iterations, escalation_count, model_level)
- [ ] `lib/agent-loop.js`: Lấy `cost_usd` từ budgetTracker và ghi vào lesson

---

## Layer 2 — Contextual Intelligence (Tuần 2)
*Vấn đề: Memory recall dump thô vào prompt — noise nhiều hơn signal.*

### 2A — Lesson Confidence Scoring khi Inject
- [ ] `lib/hermes-bridge.js` line 213-252: Upgrade ranking formula
  - `rank = (semantic_sim × 0.4) + (helped_ratio × 0.3) + (recency_decay × 0.2) + (model_match × 0.1)`
  - Chỉ inject entries có `rank > 0.6`
  - `established_pattern` entries bypass threshold (luôn inject)

### 2B — Lesson Graduation Mechanic
- [ ] `lib/memory.js`: Thêm `grade` field: `gotcha → lesson → established_pattern → deprecated`
- [ ] `lib/memory.js`: Method `promoteGrade(id)`: tự động khi `helped_count >= 5 AND confidence >= 0.85`
- [ ] `lib/memory.js`: Method `deprecate(id)`: khi conflict detected hoặc 90 ngày không dùng
- [ ] `lib/memory.js` search(): Filter out `deprecated` entries

### 2C — RAG cho Cloud Models (established_patterns)
- [ ] `lib/rag-prompt-builder.js` line 87-93: `shouldApplyRag()` — inject `established_pattern` ngay cả cho cloud models
- [ ] `lib/rag-prompt-builder.js`: Tách 2 loại injection: full RAG (local only) vs. pattern-only (tất cả models)
- [ ] Pattern injection: ngắn gọn, max 1000 chars, chỉ `established_pattern` grade

### 2D — Model-Specific Memory Tagging
- [ ] `lib/memory.js` append(): Auto-tag lesson với model hiện tại: `#cheap-success`, `#smart-success`, `#cheap-fail`, etc.
- [ ] `lib/memory.js` search(): Nhận `modelId` param, ưu tiên lessons có matching model tag
- [ ] `lib/hermes-bridge.js`: Pass `modelId` vào `getRelevantMemories()` call

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

- [ ] Layer 1 hoàn thành
- [ ] Layer 2 hoàn thành
- [ ] Layer 3 hoàn thành
- [ ] Tests pass: `npm run test:all`
- [ ] Commit + Push
