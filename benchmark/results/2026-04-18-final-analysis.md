# Benchmark Final Analysis — 2026-04-18

> Sau khi fix 6 bug + re-run. 5 A-tier task × 4 model = 20 run.

## Ranking theo P/P (Price/Performance)

| Rank | Model | Pass% | Cost/task | Cost/Pass | **P/P** | Wall |
|---|---|---|---|---|---|---|
| 1 | **cheap** (GPT-5.4-mini) | **100%** | $0.0089 | $0.0089 | **112.4** | 7.4s |
| 2 | **fast-or** (Gemini 3 Flash via OR) | **100%** | $0.0445 | $0.0445 | 22.5 | 10.8s |
| 3 | default (DeepSeek V3.2) | 40% | $0.0696 | $0.1045 | 5.7 | 56.5s |
| 4 | smart (Claude Sonnet 4.6) | 60% | $0.1220 | $0.2033 | 4.9 | 10.4s |

**P/P score** = pass_rate ÷ avg_cost (cao = hieu qua kinh te).

## Khuyen nghi lua chon model

### Production default: `cheap` (GPT-5.4-mini)
- 100% pass, **$0.009/task**, 7.4s — cheapest by 5x, highest P/P
- Dung cho: **80% workload thuong ngay** (edit file, grep, rename, small refactor)
- Cap nhat default router: thay `default` → `cheap`

### Backup primary: `fast-or` (Gemini 3 Flash via OpenRouter)
- 100% pass, $0.044/task, 10.8s — tot khi can context rong (1M token)
- Dung cho: **task lon** (read nhieu file, analysis codebase)
- OpenRouter route → khong bi quota 20/day cua Google direct
- Neu quota Google reset → prefer `fast` (Gemini direct, free)

### Reserved: `smart` (Sonnet 4.6)
- 60% pass, $0.12/task — dat nhat, fail 2/5 vi thieu exact output format
- Dung cho: **task phuc tap** (architect, security audit, complex refactor)
- KHONG dung cho simple count/list task — overkill va ton phi

### Tranh: `default` (DeepSeek V3.2)
- 40% pass, $0.07/task — cham (56s) + token inefficient (read full file thay vi grep)
- Chi dung khi other model all fail — last resort

## Cau hinh router de xuat

```yaml
# litellm_config.yaml
- model_name: "default"       # ← thay doi
  litellm_params:
    model: "openai/openai/gpt-5.4-mini"   # cheap winner
    api_base: "https://openrouter.ai/api/v1"
    api_key: "os.environ/OPENROUTER_API_KEY"

- model_name: "big-context"   # ← moi
  litellm_params:
    model: "openai/google/gemini-3-flash-preview"  # fast-or
    api_base: "https://openrouter.ai/api/v1"
    api_key: "os.environ/OPENROUTER_API_KEY"

# smart, deepseek giu nguyen cho use case rieng
```

## 6 bug da fix trong phien nay

| # | Bug | File | Fix |
|---|---|---|---|
| 1 | Budget prompt hang khi `--no-confirm` | `bin/orcai.js:624` | Add skip condition cho `opts.confirm===false` + `ORCAI_BENCHMARK=1` |
| 2 | T01 verify regex qua strict | `benchmark/tasks.json` | Format `ASYNC_COUNT=<N>` deterministic |
| 3 | T01 fixture search_files tra 0 match | `tools/file-manager.js:314` | Handle file-path (khong chi dir) — stat.isFile() branch |
| 4 | `parseMetrics` regex sai format | `benchmark/runner.js:110` | Match format thuc te `Tokens: N in, N out \| cost: $X` |
| 5 | Router `fast` khong pin | `litellm_config.yaml` | Bo duplicate, tach `fast-or` cho OpenRouter |
| 6 | Gemini free quota 20/day exhaust | N/A | Dung `fast-or` thay `fast` → bypass Google limit |

## Remaining issues (Priority #1 handoff — token inefficiency)

- **default (DeepSeek)** doc 54K input token cho task count async → agent-loop khong teach model dung `search_files` thay `read_file`
- **smart (Sonnet)** T03/T05 fail vi khong follow "one per line" format chinh xac
- Root cause: system prompt trong `--direct` mode chua nhan manh uu tien grep
- Estimate fix: 2-4h (per handoff doc Priority #1)

## Next

- [ ] Update `litellm_config.yaml` default → cheap (user quyet)
- [ ] Mo rong B/C/D/E tier (20 task) — Priority #3 handoff
- [ ] Fix token inefficiency (Priority #1 handoff) — lon hon, pending
