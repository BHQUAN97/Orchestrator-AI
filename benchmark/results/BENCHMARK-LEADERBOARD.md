# Benchmark Leaderboard — Canonical Cross-Session

> Bang tong hop **moi model da test** qua tat ca phien benchmark.
> Dung file nay lam **nguon chinh thuc** khi so sanh model moi voi model cu.
> Moi lan them model moi, chi can chay cung harness + cung task set roi append 1 row.

**Last updated**: 2026-04-18 (Round 2 — 8 free models added)

---

## I. Methodology (doc truoc khi add model moi)

### Harness
- **Runner**: `node benchmark/runner.js --tier A --model <name>`
- **Scorer**: `node benchmark/scorer.js benchmark/results/<file>.jsonl`
- **Tasks**: 5 A-tier deterministic tasks (T01-T05) — xem `benchmark/tasks.json`
- **Fixture**: `repo-snapshot` (git repo state tai thoi diem test)
- **Budget cap**: $0.20/task, $1.00/run
- **Timeout**: 60s/task, 8 iteration toi da
- **Env**: `ORCAI_BENCHMARK=1` (bypass budget prompt)

### Router
- **LiteLLM proxy**: `http://localhost:5002` (container `orcai-litellm`)
- **API**: OpenRouter unified endpoint (tru model direct nhu Gemini)
- **Fallback**: none trong benchmark — isolate model hieu suat

### P/P score (price-performance)
```
P/P = pass_rate_percent / cost_per_task_usd
```
P/P cao = re + ty le pass cao. Vd cheap pass 100% voi $0.009 -> P/P = 100/0.009 = **111**.

Benchmark dung `pass_rate / avg_cost_per_task`, vay khi 1 model free co cost = $0 thi P/P = `Infinity`. Trong bang, model free "bill $0 thuc su" se hien "∞" o cot P/P; model free co cost nho (fallback bill) thi van tinh duoc so thuc.

### Cost-per-Pass (phu tro)
```
Cost/Pass = avg_cost_per_task / (pass_rate / 100)
```
Cost/Pass phan anh thuc te hon khi model fail nhieu: chi tien cho task fail cung phai tinh.

### Tieu chi usable
- **Production**: pass >= 80% va avg_wall <= 15s
- **Prototype**: pass >= 60% va avg_wall <= 30s
- **Fallback**: pass >= 50% OR wall > 30s nhung co context lon
- **Skip**: pass < 50% hoac timeout nhieu

---

## II. Full Leaderboard (tat ca model da test)

Sap xep theo P/P giam dan (model tot nhat len dau).

| Rank | Model ID | Alias | Pass% | Cost/task | Cost/Pass | P/P | Avg Wall | Max Wall | Ctx | Tier | Use case |
|:-:|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|
| 1 | `openai/openai/gpt-5.4-mini` | **cheap** | **100%** | $0.009 | $0.009 | **112.4** | 7.4s | 10s | 400K | Paid | **Production default** — 80% workload |
| 2 | `openai/google/gemini-3-flash-preview` | **fast-or** | **100%** | $0.045 | $0.045 | **22.5** | 10.8s | 14s | 1M | Paid | Long context, 1M token |
| 3 | `nvidia/nemotron-3-nano-30b-a3b:free` | **free-nemotron-nano** | **80%** | $0.055 | $0.069 | **14.5** | 17s | 21s | 256K | Free | Prototype nhanh, free tier |
| 4 | `nvidia/nemotron-3-super-120b-a12b:free` | **free-nemotron-super** | **80%** | $0.061 | $0.076 | **13.2** | 53s | 67s | 262K | Free | Backup neu nano rate-limit |
| 5 | `z-ai/glm-4.5-air:free` | **free-glm** | 60% | $0.06 | $0.10 | 9.8 | 64s | 95s | 131K | Free | Prototype cham, round 1 |
| 6 | `deepseek/deepseek-v3.2` | **default** | 40% | $0.070 | $0.175 | 5.7 | 56s | 72s | 128K | Paid | **Tranh** — cham + token-heavy |
| 7 | `anthropic/claude-sonnet-4-6` | **smart** | 60% | $0.122 | $0.203 | 4.9 | 10.4s | 15s | 200K | Paid | Architecture/security only |
| 8 | `google/gemma-4-31b-it:free` | **free-gemma4-31b** | 40% | $0 | — | ∞† | 78s | 120s | 262K | Free | Khong du threshold |
| 9 | `google/gemma-4-26b-a4b-it:free` | **free-gemma4-26b** | 40% | $0 | — | ∞† | 78s | 120s | 262K | Free | Khong du threshold |
| 10 | `minimax/minimax-m2.5:free` | **free-minimax** | 40% | $0†† | — | ∞† | 66s | 120s | 196K | Free | Timeout nhieu |

† `∞` = free true, nhung pass < 50% nen **Skip** du P/P infinite.  
†† free-minimax timeout parse fail, cost data khong dang tin cay.

### Pending (chua test — 429 rate-limit dai han)
4 model ton tai tren OpenRouter free tier nhung upstream 429 lien tuc.
Retry lan 2 (2026-04-18 Round 3 end) van 429 tat ca → **khong kha dung tren free tier OpenRouter o thoi diem nay**.

| Model ID | Alias | Ctx | Size | Ghi chu |
|---|---|---|---|---|
| `qwen/qwen3-coder:free` | free-qwen-coder | 262K | 480B | Coder-optimized, **uu tien retry khi co credit** |
| `qwen/qwen3-next-80b-a3b-instruct:free` | free-qwen-next | 262K | 80B | Next-gen Qwen |
| `nousresearch/hermes-3-llama-3.1-405b:free` | free-hermes | 131K | 405B | Largest free tier |
| `meta-llama/llama-3.3-70b-instruct:free` | free-llama70b | 65K | 70B | Meta 70B |

**Option de unblock**:
1. Nap credit OpenRouter (rate limit nhe hon) → retry
2. Dung Chutes.ai free tier (upstream provider khac) → them model paid variant
3. Doi vai ngay/tuan → traffic free tier giam
4. Skip nhung model nay, focus cac free model kha dung khac (gemma-3-27b, nemotron-nano-9b...)

---

## III. Per-task breakdown (top model)

| Task | cheap | fast-or | nemotron-nano | nemotron-super | free-glm | smart | default |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| T01 Count async | ✅ 5s | ✅ 7s | ✅ 10s | ✅ 20s | ✅ 30s | ✅ 8s | ❌ 60s |
| T02 Add JSDoc | ✅ 8s | ✅ 12s | ✅ 15s | ✅ 58s | ✅ 60s | ✅ 12s | ✅ 50s |
| T03 Rename var | ✅ 7s | ✅ 11s | ✅ 21s | ✅ 67s | ❌ 100s | ❌ 15s | ❌ 72s |
| T04 Find typo | ✅ 6s | ✅ 9s | ✅ 20s | ✅ 60s | ✅ 45s | ✅ 8s | ❌ 60s |
| T05 List tools | ✅ 11s | ✅ 14s | ❌ 17s | ❌ 60s | ❌ 85s | ❌ 10s | ❌ 60s |

**Quan sat**: T05 fail tren nhieu model (format yeu cau "read_file.*write_file.*execute_command" theo thu tu, 1 dong). Chi 2 paid model follow dung.

---

## IV. Cost estimate — 1000 task/day

| Model | Cost/day | Cost/month | Ghi chu |
|---|:-:|:-:|---|
| cheap | $9 | $270 | **Winner** — re nhat khi pass 100% |
| fast-or | $45 | $1,350 | Them $45/day cho 1M context |
| free-nemotron-nano | $55 | $1,650 | Bi bill nho (~$0.055/task) du :free |
| free-nemotron-super | $61 | $1,830 | Bi bill nho, cham hon nano |
| free-glm | $60 | $1,800 | Bill nho tu OpenRouter fallback |
| smart | $122 | $3,660 | Chi dung 5% workload (architecture) |
| default (DeepSeek) | $70 | $2,100 | **Tranh** — pass 40%, re o danh nghia nhung Cost/Pass cao |

**Router mix de xuat**: 80% cheap + 15% fast-or + 5% smart = ~$27/day = **$810/month** cho 1000 task/day.

Neu budget 0: free-nemotron-nano 80% pass nhung bi bill ~$55/day, van co chi phi. True free = $0 khong co o pass >= 60%.

---

## V. Cach test 1 model moi (reproducibility checklist)

### 1. Them model vao `litellm_config.yaml`
```yaml
- model_name: "free-<alias>"
  litellm_params:
    model: "openai/<provider>/<model>:free"
    api_base: "https://openrouter.ai/api/v1"
    api_key: "os.environ/OPENROUTER_API_KEY"
```

### 2. Restart LiteLLM
```bash
docker restart orcai-litellm
sleep 15
curl -s -H "Authorization: Bearer $LITELLM_MASTER_KEY" http://localhost:5002/v1/models | grep <alias>
```

### 3. Ping test (endpoint song?)
```bash
curl -sX POST http://localhost:5002/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"free-<alias>","messages":[{"role":"user","content":"PING"}],"max_tokens":50}'
```

### 4. Run 5 A-tier task
```bash
export ORCAI_BENCHMARK=1
node benchmark/runner.js --tier A --model free-<alias>
```

### 5. Score + P/P
```bash
node benchmark/scorer.js benchmark/results/<date>-<hash>.jsonl
```

### 6. Append row vao bang II o tren

Format row:
```
| RANK | `<model-id>` | **<alias>** | PASS% | $X.XXX | $X.XXX | P/P | XXs | XXs | CTX | Tier | USE-CASE |
```

Sau do tinh lai rank theo P/P + update MODEL-RECOMMENDATIONS.md phan tuong ung.

---

## VI. Lich su phien benchmark

| Phien | Date | Model added | Commit | Report file |
|---|---|---|---|---|
| Round 1 (baseline) | 2026-04-18 | cheap, fast-or, default, smart, free-glm, free-minimax | 94a3cbb | `2026-04-18-MODEL-RECOMMENDATIONS.md` |
| Round 2 (expand) | 2026-04-18 | free-nemotron-{nano,super,gemma4-31b/26b} (+4 khac pending 429) | 9469398 | `2026-04-18-free-expanded-report.md` |

### Change log cac tiebreaker rules
- 2026-04-18: add ReDoS heuristic + 5 CRIT crash guards (fix from fuzz test) — khong anh huong pass rate cua 5 A-tier task (input deterministic, khong trigger edge case), pass rate giu nguyen sau fix.

---

## VII. Related files

- `benchmark/tasks.json` — 5 A-tier task definitions
- `benchmark/verify.js` — pass/fail logic (stdout_match, file_content_regex)
- `benchmark/runner.js` — harness chinh
- `benchmark/scorer.js` — P/P compute
- `benchmark/FREE-MODELS-PLAN.md` — plan benchmark free tier
- `benchmark/results/2026-04-18-MODEL-RECOMMENDATIONS.md` — recommendation chi tiet theo use case
- `benchmark/results/2026-04-18-free-expanded-report.md` — full log round 2
- `litellm_config.yaml` — router config (model aliases)

---

**Next steps**:
- Retry 4 model pending (qwen-coder, qwen-next, hermes, llama70b) khi traffic giam
- Expand B-tier task (multi-file refactor) sau khi harness stable
- Bench paid model Kimi K2, DeepSeek R1 neu co credit
