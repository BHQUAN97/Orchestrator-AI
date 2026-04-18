# Expanded Free Model Benchmark — 2026-04-18 Round 2

> 8 free OpenRouter model mới. 4/8 pass ping. 4 model chạy full A-tier.
> Base run: `2026-04-18-mo44ebwj.jsonl`

## Phase 2 — Ping test summary

| Model | Status | Ghi chú |
|---|---|---|
| free-nemotron-super | PASS | 429 upstream |
| free-nemotron-nano | PASS | Fast response |
| free-gemma4-31b | PASS | OK |
| free-gemma4-26b | PASS | OK |
| free-qwen-coder | FAIL 429 | Rate-limited upstream, thử 3 lần |
| free-qwen-next | FAIL 429 | Rate-limited upstream, thử 3 lần |
| free-hermes | FAIL 429 | Rate-limited upstream, thử 3 lần |
| free-llama70b | FAIL 429 | Rate-limited upstream, thử 3 lần |

4 model 429 = upstream provider temporarily rate-limited (không phải 404 = không tồn tại). Có thể retry sau.

## Phase 4 — Full A-tier P/P

| Model | Pass% | Cost | P/P | Avg Wall | Max Wall | Ghi chú |
|---|---|---|---|---|---|---|
| **free-nemotron-nano** | **80%** | $0.28 total / $0.055/task | **14.5** | 17s | 21s | Best speed + P/P |
| **free-nemotron-super** | **80%** | $0.18 total / $0.061/task | **13.2** | 53s | 67s | Solid, slower |
| free-gemma4-31b | 40% | $0 (billed $0) | — | 78s | 120s | Timeout nhiều, dưới threshold |
| free-gemma4-26b | 40% | $0 (billed $0) | — | 78s | 120s | Timeout nhiều, dưới threshold |

**Cost-per-Pass**: free-nemotron-nano $0.069/pass, free-nemotron-super $0.045/pass.
**P/P score** = pass_rate / avg_cost_per_task.

## Per-task breakdown

| Task | nemotron-super | nemotron-nano | gemma4-31b | gemma4-26b |
|---|---|---|---|---|
| T01 Count async | PASS 20s | PASS 10s | FAIL 60s | FAIL 60s |
| T02 Add JSDoc | PASS 58s | PASS 15s | PASS 90s | PASS 90s |
| T03 Rename var | PASS 67s | PASS 21s | FAIL 120s | FAIL 120s |
| T04 Find typo | PASS 60s | PASS 20s | PASS 60s | PASS 60s |
| T05 List tools | FAIL 60s | FAIL 17s | FAIL 60s | FAIL 60s |

Note: T05 fail trên tất cả 4 model — task này dường như quá khó với format yêu cầu `read_file.*write_file.*execute_command` theo thứ tự.

## Recommendations (3 dòng)

1. **free-nemotron-nano** (80%, 17s avg, P/P 14.5) — usable cho prototype/non-critical, nhanh nhất trong batch free
2. **free-nemotron-super** (80%, 53s avg, P/P 13.2) — alternative nếu nano rate-limit; giống nano về accuracy
3. **free-gemma4-31b/26b** (40%, 78s avg) — không đủ threshold 60% → không recommend cho production

4 model còn lại (qwen-coder, qwen-next, hermes, llama70b) bị 429 upstream — retry sau khi traffic giảm.
