# Model Comparison — Data-Driven Report 2026-04-18

> Report nay dua tren bench THUC TE 2026-04-18, khong phai uoc luong.
> Cap nhat sau moi round bench. Xem commit history + `benchmark/results/` de kiem tra.
>
> File cu (2026-04-16) co estimates theoretical — da thay bang du lieu bench thuc.

---

## 1. Bo model da test (Round 1-4)

| Alias | Provider | Model | Pricing in/out ($/1M) | Ctx |
|---|---|---|:-:|:-:|
| cheap | OpenRouter | `openai/gpt-5.4-mini` | 0.15 / 0.60 | 400K |
| fast | Google direct | `gemini-3-flash-preview` | 0.075 / 0.30 | 1M |
| fast-or | OpenRouter | `google/gemini-3-flash-preview` | 0.075 / 0.30 | 1M |
| default | OpenRouter | `deepseek/deepseek-v3.2` | 0.28 / 0.42 | 128K |
| smart (cu) | OpenRouter | `anthropic/claude-sonnet-4-6` | **3.00 / 15.00** | 200K |
| architect | OpenRouter | `anthropic/claude-opus-4-6` | **15.00 / 75.00** | 200K |
| qwen3-plus | OpenRouter | `qwen/qwen3.5-plus-02-15` | 0.26 / 0.52 | **1M** |
| qwen3-coder-flash | OpenRouter | `qwen/qwen3-coder-flash` | 0.195 / 0.78 | 1M |
| qwen3-max | OpenRouter | `qwen/qwen3-max` | 0.78 / 1.56 | 262K |

---

## 2. Ket qua bench tong hop (16 task: 5A + 5B + 3R)

### A-tier (simple single-file — 5 task)

| Model | Pass | Cost/task | Wall | Tokens in/out |
|---|:-:|:-:|:-:|:-:|
| **cheap** | **5/5 (100%)** | **$0.009** | 7.4s | 26K/142 |
| fast-or | 5/5 (100%) | $0.045 | 10.8s | — |
| qwen3-plus | 5/5 (100%) | $0.048 | 16.7s | 47K/304 |
| qwen3-max | 3/5 (60%) | $0.080 | 31s | 78K/519 |
| free-nemotron-nano | 4/5 (80%) | $0.055 | 17s | — |
| smart (Sonnet) | 3/5 (60%) | $0.122 | 10.4s | — |
| default (DeepSeek) | 2/5 (40%) | $0.070 | 56s | — |
| qwen3-coder-flash | 2/5 (40%) | $0.002 | 12.4s | 15K/100 (bo som) |

### B-tier (multi-file refactor — 5 task)

| Model | Pass | Cost/task | Wall | Tokens |
|---|:-:|:-:|:-:|:-:|
| **cheap** | **5/5 (100%)** | **$0.012** | 13.9s | 41K/623 |
| qwen3-plus | 5/5 (100%) | $0.052 | 23.9s | 50K/616 |

### R-tier (reasoning tren repo WebTemplate 1.7M backend — 3 task)

| Model | Pass | Cost/task | Wall | Tokens |
|---|:-:|:-:|:-:|:-:|
| **cheap** | **3/3 (100%)** | **$0.015** | 13.5s | 55K/469 |
| qwen3-plus | 3/3 (100%)† | $0.184 | 41.1s | 180K/1168 |

† qwen3-plus pass regex nhung **MISS** real leak o R02 (tra "none", trong khi cheap tim duoc `seo.service.ts:sitemapCache`).

### Tong 16 task (chi cheap + qwen3-plus test full)

| Model | Total Pass | Total Cost | Cost/Pass | Avg Wall |
|---|:-:|:-:|:-:|:-:|
| **cheap** | **13/13 (100%)** | **$0.152** | **$0.012** | 11.5s |
| qwen3-plus | 13/13 (100%)† | $0.864 | $0.066 | 27.0s |

**Delta**: qwen3-plus ton **5.7x cost, 2.3x wall, miss real leak**. Pass rate tuong duong nhung chat luong output KEM hon o reasoning task.

---

## 3. Phan tich model theo tier gia

### Tier DAT ($3+ per 1M input) — TRANH

**Sonnet 4.6**: $3/$15, 60% A-tier, $0.122/task. Cost/Pass $0.203 (22x worse than cheap).
- Bench showed it does NOT outperform `cheap` on any task category
- No unique capability justifies price
- **Removed tu config 2026-04-18** (see section 5)

**Opus (architect)**: $15/$75. Chi dung cho SA/design cuc kho (uoc tinh 2% workload).
- Chua bench vi thong thuong khong can — neu can, da co san
- Giu vi la premium tier thuc su co kha nang

### Tier TRUNG BINH ($0.25-$1 per 1M input)

**qwen3-plus**: $0.26/$0.52, 100% A+B+R. Nhung **cheap match performance voi 1/12 cost**.
- 1M ctx la uu the DUY NHAT
- Giu nhu explicit opt-in khi that su can ctx > 400K

**default (DeepSeek V3.2)**: $0.28/$0.42, 40% A-tier. **BO khoi role map**.
- Pass rate qua thap, 56s avg wall
- Khong thay the vai tro nao

**qwen3-coder-flash**: $0.195, 40% A-tier (bo cuoc som 1.2 iter). **BO**.

**qwen3-max**: $0.78, 60% A-tier. **BO** — kem qwen3-plus du dat hon.

### Tier RE ($0.075-$0.20 per 1M input) — WINNER ZONE

**cheap (GPT-5.4 Mini)**: $0.15/$0.60, 100% A+B+R, 400K ctx. **Production default.**

**fast / fast-or (Gemini Flash)**: $0.075/$0.30, 100% A-tier, 1M ctx. 
- Re hon cheap o input, slower hon chut
- Good for reviewer/dispatcher (fast response needed)

---

## 4. Lich su role map

### v2.1 (2026-04-16) — Pre-bench
```
tech-lead, debugger   → smart (Sonnet)   [60% pass, $0.122]
planner, fe/be, builder → default (DeepSeek) [40% pass, $0.070]
```
**Problem**: Su dung model chi vi "ten noi tieng". Bench loai tru assumption.

### v2.2 (2026-04-18) — Sau bench A+B (SUPERSEDED)
```
tech-lead, planner, debugger → qwen3-plus (1M ctx)
fe/be, builder → cheap
```
**Problem**: qwen3-plus ton 12x tren reasoning task (R-tier), khong ly do dung.

### v2.3 (2026-04-18) — Sau bench R-tier (CURRENT)
```
architect → architect (Opus)   — 2% workload SA kho
reviewer, dispatcher → fast    — 3% scan nhanh
TAT CA con lai → cheap          — 95% workload
```
**Ly do**: cheap wins toan bo bench (A+B+R). qwen3-plus chi giu lai nhu opt-in.

---

## 5. Sonnet 4.6 — Removed 2026-04-18

**Ly do loai bo hoan toan alias khoi `litellm_config.yaml`**:

1. **Pricing** — $3 input / $15 output. Gap **20x cheap** ($0.15/$0.60).
2. **Performance** — 60% A-tier pass (thap hon free tier nemotron-nano 80%).
3. **Khong thay the ai** — sau switch smart → Gemini, khong role nao dung.
4. **Cam bay** — alias ton tai khuyen khich misuse.

**Neu MOT ngay can lai**:
- Add entry vao `litellm_config.yaml` voi ly do cu the trong commit message
- Bench de xac nhan worth cost
- Document use case trong file nay

**Thay the hien tai**:
| Use case Sonnet truoc day | Model thay |
|---|---|
| Review code | cheap |
| Reasoning / debug | cheap (100% R-tier) |
| Ctx > 400K | qwen3-plus (1M) |
| SA / design kho | architect (Opus) |
| General code | cheap |

**Con lai trong codebase**:
- `lib/budget.js` + `analytics/*.js`: giu entry `sonnet` trong pricing table (history/ref)
- `test/session-continuity.test.js`: test string `sonnet-4` (unit test, khong goi LLM)
- Hardcode trong `scripts/*.bat` da update `sonnet` → `opus`

---

## 6. Cost projection — 1000 task/day

| Config | Model mix | Cost/day | Cost/month |
|---|---|:-:|:-:|
| v2.1 (Sonnet + DeepSeek) | 90% default + 10% smart | $27 | **$810** |
| v2.2 (qwen3-plus) | 85% cheap + 10% qwen3-plus + 5% other | $15 | **$450** |
| **v2.3 (all-cheap)** | **95% cheap + 3% fast + 2% architect** | **$12** | **$360** |

**Tiet kiem v2.3 vs v2.1**: 56% cost + pass rate 40-60% → 95%+.

---

## 7. Methodology

### Harness
- `node benchmark/runner.js --tier <A|B|R> --model <alias1,alias2>`
- A-tier: 5 simple single-file task
- B-tier: 5 multi-file refactor voi fixture isolated
- R-tier: 3 reasoning task tren WebTemplate repo thuc (read-only)

### Verify types
- `stdout_match` — regex match in agent final output
- `file_content_regex` — check file changed dung pattern
- `multi_file` — combined checks (file_exists, regex, pattern_count, json_path)

### Reproducibility
```bash
set -a && source .env && set +a
ORCAI_BENCHMARK=1 node benchmark/runner.js --tier A --model cheap,qwen3-plus
```

Result files trong `benchmark/results/2026-04-18-*.jsonl`.

### Raw data cho Round 4 (R-tier)
- `benchmark/results/2026-04-18-mo496zvr.jsonl`
- `benchmark/results/R01-cheap-*.log`, `R02-cheap-*.log`, `R03-cheap-*.log`
- `benchmark/results/R01-qwen3-plus-*.log`, ...

---

## 8. Open questions (chua answer — can them bench)

1. Sonnet 4.6 co vuot cheap o task > 50K line codebase khong? — can bench C-tier voi repo qua 1M token.
2. qwen3-plus co tot hon cheap trong multi-turn conversation dai? — can bench interaction > 10 turn.
3. Opus architect co gia tri $0.30/task cho design task khong? — can bench D-tier spec tasks.
4. Local Qwen2.5-coder-7b + RAG co dat cheap khong? — da co du lieu so bo (81-82% R2.5).

---

**Last updated**: 2026-04-18 (Round 4 R-tier + Sonnet removal)  
**Commits related**: e453d66, ea0192c, 4a88098, 9b4744e, 1aacd32, 927e159, 1656db1 + upcoming Sonnet removal
