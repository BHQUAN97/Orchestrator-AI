# Free Models Benchmark Plan — OpenRouter :free tier

> Queried 2026-04-18 tu OpenRouter `/v1/models` endpoint. Tong: **24 free models**.

## Phan loai theo kha nang dung cho coding task

### Tier S — Coder-specific / Large (uu tien test)

| Model | Ctx | Size | Ghi chu |
|---|---|---|---|
| `qwen/qwen3-coder:free` | 262K | 480B | Coder-optimized, ton tu 2026 — **must test** |
| `qwen/qwen3-next-80b-a3b-instruct:free` | 262K | 80B | Next-gen Qwen general |
| `nousresearch/hermes-3-llama-3.1-405b:free` | 131K | 405B | Largest in free tier |
| `nvidia/nemotron-3-super-120b-a12b:free` | 262K | 120B | NVIDIA optimized |
| `openai/gpt-oss-120b:free` | 131K | 120B | OpenAI open model (**503 earlier, skip**) |

### Tier A — Balanced 30-70B (test neu Tier S timeout/rate-limit)

| Model | Ctx | Size | Ghi chu |
|---|---|---|---|
| `google/gemma-4-31b-it:free` | 262K | 31B | Gemma 4 flagship |
| `google/gemma-4-26b-a4b-it:free` | 262K | 26B | Gemma 4 medium |
| `nvidia/nemotron-3-nano-30b-a3b:free` | 256K | 30B | Nemotron nano |
| `meta-llama/llama-3.3-70b-instruct:free` | 65K | 70B | Meta 70B |
| `google/gemma-3-27b-it:free` | 131K | 27B | Gemma 3 27B |

### Tier B — Da test 2026-04-18

| Model | Result | Ghi chu |
|---|---|---|
| `z-ai/glm-4.5-air:free` | **60% pass** | P/P 9.8, cham 64s/task |
| `minimax/minimax-m2.5:free` | **40% pass** | Timeout nhieu |

### Tier C — Skip (qua nho / thinking-only / VL)

- `liquid/lfm-2.5-1.2b-*` — 1.2B qua nho
- `google/gemma-3n-e2b/e4b-it` — 2B/4B qua nho, 8K ctx
- `google/gemma-3-4b-it` — 4B qua nho
- `google/gemma-3-12b-it` — 12B trung binh, 32K ctx
- `meta-llama/llama-3.2-3b-instruct` — 3B qua nho
- `nvidia/nemotron-nano-9b-v2` / `12b-v2-vl` — nho + vision-specific
- `openai/gpt-oss-20b` — 20B, nhung gpt-oss-120b 503 nen skip ca 2
- `arcee-ai/trinity-large-preview` — preview, unstable
- `cognitivecomputations/dolphin-mistral-24b` — uncensored, khong phu hop coding
- `qwen/qwq-32b` — khong co trong list 24

## Plan benchmark 3 phase

### Phase 1 — Ping test (kiem tra endpoint song)

- Ping 10 model Tier S + Tier A voi prompt "Reply PING", max_tokens 50
- Filter ra model tra loi OK (co content) trong 10s
- Expect: 5-8 model pass (free tier hay 429/503)

### Phase 2 — Speed test (1 task don gian, 30s timeout)

- Chay T04 (Find typo in README) — task don gian nhat
- Loai model fail (timeout, crash, output sai format)
- Rut ra top 5-6 model on dinh

### Phase 3 — Full benchmark

- Top 5-6 model × 5 A-tier task = 25-30 runs
- So sanh voi paid model (cheap, fast-or)
- Ghi nhan: pass rate, avg wall, cost ( :free nhung co the co bill nho)

## Estimate thoi gian + chi phi

- Phase 1 ping: ~5 phut, $0
- Phase 2 speed: ~15 phut, <$0.10 (fallback bill khi :free khong co endpoint)
- Phase 3 full: ~30-45 phut, <$0.50 (bill fallback edge case)
- **Tong**: ~1h, **<$1**

## Tieu chi "usable cho production"

Model duoc xem la **usable** khi dat CA 3:
1. Pass rate >= 60% tren 5 A-tier task
2. Avg wall <= 30s/task (khong cham hon fast-or 10s qua 3x)
3. On dinh (khong 429/503 > 30% tong call)

Neu pass **2/3** → **fallback only** (chi dung khi primary fail)
Neu pass **1/3** → **skip** (khong them vao router)

## Rui ro + mitigation

| Rui ro | Mitigation |
|---|---|
| OpenRouter free tier rate limit 20req/min global | Chay tuan tu, sleep 3s giua cac call |
| :free endpoint 503 / 429 ngau nhien | Retry 2 lan, neu van fail → ghi "unstable" |
| Model khong ho tro tool_calls → fail tat ca | Phase 2 detect som, loai ngay |
| OpenRouter bill nho cho :free (fallback) | Track cost_usd tung run, tong < $1 |

## Khuyen nghi sau benchmark

- Model usable → them vao `litellm_config.yaml` voi suffix `free-<name>`
- Setup `model_group_fallbacks` trong LiteLLM: `cheap -> fast-or -> free-best`
- Router `free` alias → model free tot nhat
- Document trong `MODEL-RECOMMENDATIONS.md` bang cap nhat
