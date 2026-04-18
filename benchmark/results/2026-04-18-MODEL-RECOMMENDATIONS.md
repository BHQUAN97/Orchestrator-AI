# Model Recommendations — 2026-04-18 Final

> 6 model x 5 A-tier task = 30 run. Budget $0.20/task. Harness da fix 6 bug.

## Xep hang P/P (Price / Performance)

| Rank | Model | Pass% | Cost/task | Cost/Pass | P/P | Wall | Nhan xet |
|---|---|---|---|---|---|---|---|
| 🥇 | **cheap** (GPT-5.4-mini) | **100%** | $0.009 | $0.009 | **112.4** | 7.4s | Winner — pass mọi task, re nhat |
| 🥈 | **fast-or** (Gemini 2.5 Flash via OR) | **100%** | $0.045 | $0.045 | 22.5 | 10.8s | Pass 100% + 1M context |
| 🥉 | free-glm (GLM 4.5 Air) | 60% | ~$0.06† | $0.08 | 9.8 | 64s | Re nhung cham, 131K ctx |
| 4 | smart (Sonnet 4.6) | 60% | $0.122 | $0.203 | 4.9 | 10.4s | Dat, thieu format follow |
| 5 | default (DeepSeek V3.2) | 40% | $0.070 | $0.105 | 5.7 | 56s | Cham + token inefficient |
| 6 | free-minimax (MiniMax M2.5) | 40% | $0†† | — | ∞† | 66s | Free nhung timeout nhieu |

† free-glm bi OpenRouter bill (khong thuc su free 100%).
†† free-minimax no cost data — timeout khong parse duoc.

## Khuyen nghi lua chon theo use case

### 1. **Production default** — `cheap` (paid, OpenRouter)
- 100% pass rate, **$0.009/task** — re hon Sonnet 22x
- 7.4s/task — nhanh nhat trong nhom pass 100%
- **Khuyen dung cho 80% workload** (edit, grep, rename, count, small refactor)
- Model ID: `openai/openai/gpt-5.4-mini`

### 2. **Long context** — `fast-or` (paid qua OR)
- 100% pass, $0.045/task, 1M token context
- Dung khi: read nhieu file, analyze codebase, large diff
- Model ID: `openai/google/gemini-3-flash-preview` (qua OpenRouter, bypass Google 20/day)

### 3. **Cost = 0 acceptable** — `free-glm`
- 60% pass, token-based cost ~$0.06 (khong han che true free)
- Dung khi: prototype, non-critical task, budget zero
- Model ID: `z-ai/glm-4.5-air:free`
- **Luu y**: cham (~64s/task), co the timeout task kho

### 4. **Complex reasoning** — `smart` (Sonnet 4.6)
- DUNG TIET KIEM — $0.12/task dat
- Chi dung cho: architecture design, security audit, complex debug
- KHONG dung cho: simple edit, count, list → overkill
- Model ID: `anthropic/claude-sonnet-4-6`

### 5. **Refactor + long context** — `minimax` (free, 196K ctx)
- Khi pass rate cai thien (hien 40%, timeout nhieu) — con theo doi
- Model ID: `minimax/minimax-m2.5:free`
- Con xem xet + test them tasks khac

### 6. **Tranh** — `default` (DeepSeek V3.2)
- 40% pass, cham (56s), token inefficient (doc full file thay vi grep)
- Chi dung khi fallback cuoi cung

## Cau hinh router cuoi cung de xuat

```yaml
# litellm_config.yaml — production setup
model_list:
  # TIER 1 — default cho workload thong thuong
  - model_name: "default"
    litellm_params:
      model: "openai/openai/gpt-5.4-mini"    # thay DeepSeek V3.2
      api_base: "https://openrouter.ai/api/v1"
      api_key: "os.environ/OPENROUTER_API_KEY"

  # TIER 1.5 — long context (>100K tokens)
  - model_name: "long-context"
    litellm_params:
      model: "openai/google/gemini-3-flash-preview"
      api_base: "https://openrouter.ai/api/v1"
      api_key: "os.environ/OPENROUTER_API_KEY"

  # TIER 2 — complex / architecture
  - model_name: "smart"
    litellm_params:
      model: "openai/anthropic/claude-sonnet-4-6"
      api_base: "https://openrouter.ai/api/v1"
      api_key: "os.environ/OPENROUTER_API_KEY"

  # TIER 3 — free (prototype, non-critical)
  - model_name: "free"
    litellm_params:
      model: "openai/z-ai/glm-4.5-air:free"
      api_base: "https://openrouter.ai/api/v1"
      api_key: "os.environ/OPENROUTER_API_KEY"
```

## Cost estimate — 1000 task/ngay

| Model | Cost/day | Cost/month |
|---|---|---|
| cheap | $9 | $270 |
| fast-or | $45 | $1,350 |
| smart | $122 | $3,660 |
| free-glm | ~$60 | ~$1,800 (thap hon neu free routing thanh cong) |

→ **Router mix recommended**: 80% cheap + 15% fast-or + 5% smart = ~$27/day = **$810/month** cho 1000 task/day.

## Bug da fix trong phien

| # | Bug | Fix |
|---|---|---|
| 1 | Budget prompt hang `--no-confirm` | `bin/orcai.js`: bypass khi ORCAI_BENCHMARK=1 |
| 2 | T01 verify regex strict | `tasks.json`: deterministic ASYNC_COUNT format |
| 3 | search_files ENOTDIR on file path | `tools/file-manager.js`: handle stat.isFile() |
| 4 | parseMetrics regex sai | `runner.js`: match "Tokens: N in, N out \| cost: $X" |
| 5 | Router `fast` khong pin | `litellm_config.yaml`: tach `fast-or` |
| 6 | Gemini free quota 20/day | Dung `fast-or` qua OpenRouter |

---

### Expanded free models (2026-04-18 round 2)

> Thêm 8 model mới từ OpenRouter free tier. Run: `2026-04-18-mo44ebwj.jsonl`

#### Ping test (Phase 2): 4/8 pass

| Model | Ping | Ghi chú |
|---|---|---|
| free-nemotron-super | PASS | nvidia/nemotron-3-super-120b-a12b |
| free-nemotron-nano | PASS | nvidia/nemotron-3-nano-30b-a3b |
| free-gemma4-31b | PASS | google/gemma-4-31b-it |
| free-gemma4-26b | PASS | google/gemma-4-26b-a4b-it |
| free-qwen-coder | FAIL 429 | qwen/qwen3-coder — upstream rate-limit |
| free-qwen-next | FAIL 429 | qwen/qwen3-next-80b-a3b-instruct — upstream rate-limit |
| free-hermes | FAIL 429 | nousresearch/hermes-3-llama-3.1-405b — upstream rate-limit |
| free-llama70b | FAIL 429 | meta-llama/llama-3.3-70b-instruct — upstream rate-limit |

#### A-tier results (4 models tested)

| Model | Pass% | Cost | P/P | Avg Wall | vs old free |
|---|---|---|---|---|---|
| **free-nemotron-nano** | **80%** | $0.055/task | **14.5** | 17s | >> free-glm (60%) |
| **free-nemotron-super** | **80%** | $0.061/task | **13.2** | 53s | >> free-glm (60%) |
| free-gemma4-31b | 40% | $0 | — | 78s | = free-minimax |
| free-gemma4-26b | 40% | $0 | — | 78s | = free-minimax |

#### Updated all-model ranking (paid + free)

| Rank | Model | Pass% | P/P | Wall | Tier |
|---|---|---|---|---|---|
| 1 | cheap (GPT-5.4-mini) | 100% | 112.4 | 7s | Paid |
| 2 | fast-or (Gemini Flash) | 100% | 22.5 | 11s | Paid |
| 3 | **free-nemotron-nano** | **80%** | **14.5** | **17s** | **Free** |
| 4 | **free-nemotron-super** | **80%** | **13.2** | **53s** | **Free** |
| 5 | free-glm | 60% | 9.8 | 64s | Free |
| 6 | smart (Sonnet 4.6) | 60% | 4.9 | 10s | Paid |
| 7 | default (DeepSeek V3.2) | 40% | 5.7 | 56s | Paid |
| 8 | free-minimax | 40% | — | 66s | Free |
| 9 | free-gemma4-31b | 40% | — | 78s | Free |
| 10 | free-gemma4-26b | 40% | — | 78s | Free |

**New usable free models**: `free-nemotron-nano` và `free-nemotron-super` — cả hai 80% pass, usable cho prototype/non-critical. Nano nhanh hơn (17s vs 53s avg) nên ưu tiên.

**Wall time caveat**: Nemotron models exceed 30s threshold cho một số tasks (T02 57s, T03 67s). Nếu yêu cầu wall ≤30s strict thì chỉ nano cho T01/T04 đạt.

## Bug con lai (Priority handoff doc)

- **Token inefficiency** (Priority #1 handoff): agent doc full file thay vi grep
  - Anh huong: default (54K input tokens cho task count) — chinh vi vay default 40%
  - Fix estimate: 2-4h
- **T03/T05 format follow**: smart khong follow "one per line" → FAIL
  - Prompt yeu cau format explicit → cheap follow duoc, smart khong
  - Can them "output format" section trong system prompt
