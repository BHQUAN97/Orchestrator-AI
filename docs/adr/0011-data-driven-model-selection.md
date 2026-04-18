# ADR-0011: Data-Driven Model Selection v2.3 (Bench-Grounded Role Map)

- **Status**: accepted
- **Date**: 2026-04-18
- **Deciders**: BHQUAN97
- **Tags**: ai-routing, cost, architecture, benchmark
- **Supersedes**: ADR-0001 (5-tier model hierarchy)

## Context

ADR-0001 (2026-04-16) gan model cho role dua tren **uoc luong theoretical** + pricing:
- Sonnet ($3/1M) cho tech-lead/debugger
- DeepSeek ($0.28/1M) cho planner/fe-dev/be-dev/builder
- GPT-5.4 Mini cho scanner/docs
- Gemini Flash cho reviewer/dispatcher
- Opus cho architect

Trong session 2026-04-18, chay **bench toan dien 16 task** (A-tier simple, B-tier multi-file, R-tier reasoning tren repo thuc) da phat hien:

1. **Sonnet 4.6 chi pass 60%** vs cheap (GPT-5.4 Mini) **100%** — ma Sonnet **dat hon 13x**
2. **DeepSeek 40% pass** + avg 56s wall — kem xa cheap + cham
3. **cheap 100% A+B+R tier** — outperform MOI paid model khac tru Opus (untested)
4. **qwen3-plus 100% pass** nhung **ton 5-12x cheap** va MISS leak trong R02

Ket luan: **Paid tier moi hon khong co nghia la tot hon**. Can **data-driven decision** thay vi **brand-driven**.

## Decision

### 1. Role map v2.3 — cheap dominates

```javascript
// router/orchestrator-agent.js AGENT_ROLE_MAP
{
  architect:  'architect',  // Opus — 2% workload, SA/design cuc kho
  reviewer:   'fast',       // Gemini Flash — scan nhanh, 3%
  dispatcher: 'fast',       // Gemini Flash — synthesize, 1%
  // Tat ca con lai — 95% workload:
  'tech-lead':  'cheap',
  'planner':    'cheap',
  'fe-dev':     'cheap',
  'be-dev':     'cheap',
  'debugger':   'cheap',
  'scanner':    'cheap',
  'docs':       'cheap',
  'builder':    'cheap',
}
```

### 2. Benchmark-First policy

**Moi quyet dinh model moi phai dua tren bench data**. Khong add model vao role map chi vi:
- "Model X vua ra mat va manh"
- "Provider Y moi, re hon"
- "Benchmark cong bo cho X diem cao tren HumanEval"

Phai chay: `node benchmark/runner.js --tier A,B,R --model <new-model>` → compare Cost/Pass vs cheap.

### 3. Sonnet 4.6 removal

Xoa alias `sonnet` khoi `litellm_config.yaml`. Neu can lai trong tuong lai:
- Add entry voi commit message giai thich **use case cu the** nao yeu cau Sonnet
- Re-bench va update ADR nay + MODEL-COMPARISON.md

## Bench data (Round 1-4, 2026-04-18)

### Bang tong hop

| Model | Alias | $/1M in | Ctx | A-tier | B-tier | R-tier | Cost/Pass | Use |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|---|
| GPT-5.4 Mini | **cheap** | 0.15 | 400K | **100%** | **100%** | **100%** | **$0.012** | Production 95% |
| Gemini 3 Flash (direct) | fast | 0.075 | 1M | ping OK | — | — | — | reviewer/dispatcher |
| Gemini 3 Flash (OR) | fast-or | 0.075 | 1M | 100% | — | — | $0.045 | Fallback cho fast |
| Qwen 3.5 Plus | qwen3-plus | 0.26 | **1M** | 100% | 100% | 100%† | $0.066 | Opt-in ctx>400K |
| Qwen 3 Coder Flash | qwen3-coder-flash | 0.195 | 1M | 40% (bo som) | — | — | n/a | **Skip** |
| Qwen 3 Max | qwen3-max | 0.78 | 262K | 60% | — | — | $0.133 | **Skip** |
| DeepSeek V3.2 (pre-P1) | default | 0.28 | 128K | 40% | — | — | $0.175 | Round 1 |
| DeepSeek V3.2 (post-P1) | default | 0.28 | 128K | **60%** | — | — | **$0.046** | Round 4 re-bench |
| Kimi K2.5 (post-P1) | kimi | 1.00 | 128K | **60%** | — | — | **$0.040** | Round 4 |
| Claude Sonnet 4.6 (pre-P1) | ~~sonnet~~ | 3.00 | 200K | 60% | — | — | $0.203 | **Removed — khong re-bench (user 2026-04-18)** |
| Claude Opus 4.6 | architect | 15.00 | 200K | chua bench | — | — | — | 2% SA cuc kho |
| Nemotron Nano 30B | free-nemotron-nano | 0 (bill $0.055) | 256K | 80% | — | — | $0.069 | Free prototype |
| Nemotron Super 120B | free-nemotron-super | 0 (bill $0.061) | 262K | 80% | — | — | $0.076 | Free backup |
| GLM 4.5 Air | free-glm | 0 (bill $0.06) | 131K | 60% | — | — | $0.10 | Free, cham |
| Gemma 4 31B/26B IT | free-gemma4-* | 0 | 262K | 40% | — | — | — | Skip |
| MiniMax M2.5 | free-minimax | 0 | 196K | 40% (timeout) | — | — | — | Skip |
| Qwen3 Coder | free-qwen-coder | 0 | 262K | 429 | — | — | — | Pending retry |
| Qwen3 Next 80B | free-qwen-next | 0 | 262K | 429 | — | — | — | Pending retry |
| Hermes 3 405B | free-hermes | 0 | 131K | 429 | — | — | — | Pending retry |
| Llama 3.3 70B | free-llama70b | 0 | 65K | 429 | — | — | — | Pending retry |

† qwen3-plus pass regex verify nhung **MISS real leak** o R02 (seo.service.ts:sitemapCache) — cheap tim duoc.

### So sanh cheap vs qwen3-plus (cap ung vien thuc su can xet)

| Metric | cheap | qwen3-plus | Delta |
|---|:-:|:-:|:-:|
| Pass A (5 task) | 100% | 100% | TIE |
| Pass B (5 task) | 100% | 100% | TIE |
| Pass R (3 task) | 100% (tim leak) | 100% (miss leak) | **cheap tot hon thuc chat** |
| Total Cost 13 task | $0.152 | $0.864 | cheap **5.7x re** |
| Avg Wall | 11.5s | 27.0s | cheap **2.3x nhanh** |
| Avg Tokens in | 46K | 146K | cheap **3.2x it** |
| Context max | 400K | 1M | qwen3-plus +2.5x |

**Conclusion**: qwen3-plus chi thang o **context window**. Moi khi cheap du, chon cheap.

## Chi tiet uu/nhuoc tung model

### cheap — GPT-5.4 Mini via OpenRouter

**Uu diem:**
- Pass 100% tat ca bench (A+B+R) — ca reasoning + multi-file refactor
- Cost rat thap — $0.010-0.015/task
- Speed tot — 7-14s avg wall
- Context 400K du cho 95%+ task
- Iteration efficient — 3-5 iter trung binh
- Follow instruction tot — output format chuan

**Nhuoc diem:**
- Ctx < 1M (co the dung qwen3-plus hoac fast khi can)
- 1 provider (OpenRouter → OpenAI) — neu outage can fallback
- Chua test task D-tier (feature implementation) va E-tier (workflow dai)

**Dung cho**: production default, 95% workload — moi role tru architect/reviewer/dispatcher.

---

### fast — Gemini 3 Flash direct (Google API)

**Uu diem:**
- 1M context — lon nhat cung voi qwen3-plus
- $0.075/$0.30 per 1M — re nhat trong tier "usable"
- Co Google free quota ban dau
- Direct Google API — latency thap (khong qua OpenRouter)

**Nhuoc diem:**
- Google quota han che — het thi down
- Chua bench full tier (ping OK 2026-04-18 Round 3)
- Dependencies tren GEMINI_API_KEY

**Dung cho**: reviewer (scan nhanh), dispatcher (synthesize).

---

### fast-or — Gemini 3 Flash via OpenRouter

**Uu diem:**
- Bench 100% A-tier
- 1M context
- Avg cost $0.045/task
- Fallback khi Google quota het

**Nhuoc diem:**
- Markup so voi direct Google
- Phu thuoc OpenRouter availability

**Dung cho**: fallback alias cho fast.

---

### qwen3-plus — Qwen 3.5 Plus via OpenRouter

**Uu diem:**
- Pass 100% A+B+R tier
- **1M context** — lon nhat
- Pricing tot — $0.26/$0.52 per 1M (11x re hon Sonnet)

**Nhuoc diem:**
- Ton 5.7x cheap tren bench cung pass rate
- Cham 2.3x (27s vs 12s)
- Token usage 3.2x — verbose + over-exploration
- **MISS real security issues** — R02 bench tra "none" khi thuc te co leak
- Cautious/conservative — co the fail "mot nua" tren audit task

**Dung cho**: opt-in khi task can ctx > 400K. KHONG mac dinh.

---

### qwen3-coder-flash — Qwen 3 Coder Flash via OpenRouter

**Uu diem:**
- $0.195 per 1M — rat re
- 1M context
- Coder-tuned (theo claim)

**Nhuoc diem:**
- Bench 40% A-tier — bo cuoc som
- Avg 1.2 iterations — goi task_complete ngay khong du thong tin
- Khong dang tin cay cho real task

**Dung cho**: **SKIP**. Giu alias cho experiment sau neu model duoc update.

---

### qwen3-max — Qwen 3 Max via OpenRouter

**Uu diem:**
- $0.78 per 1M — re hon Sonnet 4x
- Claim top tier

**Nhuoc diem:**
- Bench 60% A-tier — kem qwen3-plus du dat hon
- Iteration 5 trung binh — over-explore
- Ctx 262K < qwen3-plus 1M

**Dung cho**: **SKIP**. qwen3-plus tot hon voi gia thap hon.

---

### default — DeepSeek V3.2 via OpenRouter

**Uu diem:**
- $0.28 per 1M — re
- Coder/instruct model manh tren benchmark cong bo
- **Post-P1 fix improved significantly** (Round 4): 40% → 60% pass, cost $0.070 → $0.028

**Nhuoc diem:**
- Van kem cheap 100%
- Token-heavy kha nang over-explore (T03 avg 7 iter, 71K token)
- 51s avg wall — cham
- T05 timeout (chua ro nguyen nhan)

**Round 4 re-bench (post-P1 token fix)**:
| Task | Pass | Cost | Wall | Iter |
|:-:|:-:|:-:|:-:|:-:|
| T01 | PASS | $0.039 | 33s | 3 |
| T02 | PASS | $0.026 | 25s | 2 |
| T03 | FAIL | $0.073 | 76s | 7 |
| T04 | PASS | $0.000† | 60s | n/a |
| T05 | FAIL | $0.000† | 60s | timeout |

† Cost null = parse fail (token count dropped qua fast co the do stream interrupt)

**Dung cho**: Vẫn **KHONG vao role map** — cheap van tot hon. Giu alias de experiment.

---

### kimi — Kimi K2.5 via OpenRouter (Moonshot AI)

**Uu diem:**
- $1/$3 per 1M — re hon Sonnet 3x, dat hon cheap 7x
- Reasoning model (co `reasoning_content` field)
- 128K ctx

**Nhuoc diem:**
- Bench Round 4 post-P1: **60% pass** (3/5), cung fail T03+T05 nhu DeepSeek
- 55s avg wall — **cham 7x cheap**
- 1.6 iter avg — it iteration (khong over-explore nhu DeepSeek)
- Task parse fail o 3/5 (tokens_in=null) — co the do reasoning_content khong parse dung

**Round 4 bench**:
| Task | Pass | Cost | Wall | Iter |
|:-:|:-:|:-:|:-:|:-:|
| T01 | PASS | $0.022 | 20s | 2 |
| T02 | PASS | $0 (parse fail) | 31s | n/a |
| T03 | FAIL | $0 (parse fail) | 120s | n/a |
| T04 | PASS | $0 (parse fail) | 60s | n/a |
| T05 | FAIL | $0.098 | 43s | 6 |

**Quan sat**: Kimi va DeepSeek cung fail T03 (rename multi-location) va T05 (output format chinh xac). cheap pass ca 2 → GPT-5.4 Mini **follow instruction tot hon** cho agentic workflow.

**Dung cho**: **KHONG vao role map**. Giu alias legacy (tu v1).

---

### smart / sonnet — Claude Sonnet 4.6 via OpenRouter

**Uu diem:**
- Brand tot, cong bo score cao tren benchmark
- Anthropic quality control

**Nhuoc diem:**
- **$3/$15 per 1M** — dat nhat tru Opus
- Bench **60% A-tier** (pre-P1 fix) — cheap 100%
- Cost/Pass $0.203 — 22x cheap
- **Khong use case nao** trong role map ma cheap khong match

**⚠ Caveat quan trong**: 60% pass la tu Round 1 (pre-P1). DeepSeek cung model thay doi 40% → 60% sau P1 fix. Sonnet **co the** improve tuong tu (70-85%?) nhung **chua re-bench**.

Van con 2 ly do khong re-bench ngay:
1. Cost 20x cheap — ngay ca neu Sonnet len 90%, Cost/Pass van ~15x cheap
2. User yeu cau khong dung Sonnet (2026-04-18)

**Dung cho**: **REMOVED hoan toan 2026-04-18**. Alias xoa khoi config.  
Neu can lai: 
1. Add entry vao `litellm_config.yaml`
2. Re-bench post-P1 A+B+R tier
3. Chung minh pass rate >= 100% VA Cost/Pass canh tranh
4. Document use case cu the

---

### architect — Claude Opus 4.6 via OpenRouter

**Uu diem:**
- Top reasoning model
- Best cho SA/design/extreme complexity

**Nhuoc diem:**
- **$15/$75 per 1M** — dat nhat
- Chua bench (uoc luong 2% workload)
- Cost/task du kien $0.30+

**Dung cho**: role `architect` — chi khi task cuc kho (design kien truc, critical refactor). Uoc tinh 2% workload.

---

### Free tier OpenRouter (:free suffix)

**Uu diem chung:**
- Ten thuc la free (khong co cost khi quota con)
- Thu nghiem low-risk
- Co model lon (405B hermes, 120B nemotron-super)

**Nhuoc diem chung:**
- Rate limit 429 thuong xuyen (4/8 chua test duoc)
- Bill khi quota het (khong true free)
- Slow hoac timeout
- Pass rate thap (hau het 40-80%)

**Dung cho**: experiment, prototype — khong production.

---

### Local models (LM Studio, offline)

**Uu diem:**
- Free thuc su (chay tren may ban)
- Privacy-sensitive data
- Offline fallback
- Voi RAG (stage-based) co the dat 81-82% tren Qwen 2.5 Coder 7B

**Nhuoc diem:**
- Phu thuoc hardware
- Slower than cloud
- Context limited

**Dung cho**: privacy/offline scenarios, khong mac dinh.

## Framework so sanh model moi (cho future ADR updates)

Khi nhan duoc model moi (vd "Grok 4 Coder", "Gemini 4", "Llama 5"...), thu tu danh gia:

### Buoc 1: Sanity check (5 phut, khong ton token)
- [ ] Model ton tai tren provider nao? (OpenRouter, direct API, local)
- [ ] Pricing input/output per 1M?
- [ ] Context window max?
- [ ] Pricing co "hon" cheap $0.15/$0.60 khong? Neu DAT hon 5x → can phai BENCH CHUNG MINH worth

### Buoc 2: Infrastructure (15 phut, ~$0.01)
- [ ] Add alias vao `litellm_config.yaml`
- [ ] `docker restart orcai-litellm && sleep 15`
- [ ] Ping test: `curl /v1/chat/completions -d '{"model":"...","messages":[...]}'`
- [ ] Xac nhan response valid

### Buoc 3: A-tier bench (10-15 phut, ~$0.05-0.30 tuy model)
```bash
set -a && source .env && set +a
ORCAI_BENCHMARK=1 node benchmark/runner.js --tier A --model <new-alias>
```
- [ ] Pass rate >= 80%? Neu KHONG → skip (khong dung production)
- [ ] Cost/task so voi cheap?
- [ ] Wall time?
- [ ] Tokens avg?

### Buoc 4: B-tier bench (15-20 phut, ~$0.10-0.50)
- [ ] Multi-file refactor pass >= 80%?
- [ ] So sanh cost/wall voi cheap

### Buoc 5: R-tier bench (15-20 phut, ~$0.05-0.50)
- [ ] Reasoning task tren WebTemplate repo — pass 3/3?
- [ ] **Doc log thuc te** — model co tim duoc real issue hay "miss" giong qwen3-plus?
- [ ] Output quality so voi cheap?

### Buoc 6: Decision matrix

| Tinh huong | Action |
|---|---|
| Pass >= 100% + Cost/Pass < $0.010 | Thay cheap cho moi role (unlikely) |
| Pass >= 100% + Cost/Pass tuong duong cheap + ctx > 400K | Them vao role map thay qwen3-plus |
| Pass >= 100% + Cost/Pass cao hon cheap | Keep as alias opt-in only |
| Pass 80-99% | Free: giu alias. Paid: skip. |
| Pass < 80% | Skip, khong add alias |
| Pass 100% nhung miss real issues (R02-style) | Xem xet kha nang dung cho audit/security |

### Buoc 7: Documentation
- [ ] Update `docs/MODEL-COMPARISON.md` bang bench data
- [ ] Update `benchmark/results/BENCHMARK-LEADERBOARD.md`
- [ ] Update ADR nay (them row bang tong hop)
- [ ] Neu thay model trong role map → update ADR + commit rieng

## Bug + Issue dang ton tai

### Upstream (khong the sua)

| ID | Model | Bug | Workaround |
|---|---|---|---|
| B1 | 4 free model (qwen-coder/next, hermes, llama70b) | 429 lien tuc tren OpenRouter free tier | Nap $5 credit hoac cho traffic giam |
| B2 | qwen3-coder-flash | Bo cuoc som 1.2 iter avg | Skip, khong dung |
| B3 | qwen3-plus | Miss real security issues (R02) — tra "none" khi thuc te co leak | Dung cheap cho audit/debug |

### Project code (priority thap)

| ID | File | Bug | Trang thai |
|---|---|---|---|
| B4 | test/fuzz-tools.test.js | 2/90 test bug non-tool (tu Round 3 cu) | Ton tai, chua fix |
| B5 | lib/agent-loop.js | `_applyRagIfLocal` alias cho backwards-compat | By design, khong can sua |

### Observation (khong bug)

| ID | Ghi chu |
|---|---|
| O1 | Free model :free bi bill khi quota het (fallback paid) — P/P tinh phuc tap |
| O2 | Alias `smart` gio tro Gemini (truoc la Sonnet) — scripts cu van hoat dong |
| O3 | Context cache stale check tu dong khi bat dau phien |

## Important caveats (doc phai nho)

### Caveat 1: Round 1 bench co the bi "P1 bug" lam sai lech

Round 1 bench (2026-04-16 → 2026-04-18 pre-session) chay **TRUOC** khi fix P1 token inefficiency. Bug: agent doc file 3 lan sau khi search_files da tra ket qua. Anh huong:
- Model nao hay "paranoid re-check" (Sonnet, DeepSeek) → nhieu token, nhieu iteration, de over-budget va fail
- Model nao "trust grep" tu nhien (cheap, qwen3-plus) → pass ngay

**Evidence post-P1**: DeepSeek 40% → 60% sau P1. Sonnet chua re-bench nhung co the improve tuong tu.

**Ngam**: Roi rac giua "model quality" va "agent-loop quality" kho cat ranh. Bench moi can:
1. Agent-loop on dinh (da xong voi P1)
2. Prompt on dinh (co the them stage-based RAG, v.v.)
3. Verify deterministic (san roi — A-tier)

### Caveat 2: qwen3-plus R02 miss

R02 qwen3-plus tra "LEAK_CANDIDATE: none" — nhung thuc te co leak (sitemapCache). **Verify regex chap nhan "none" → ve ky thuat PASS**. Nhung thuc te fail audit.

**Bai hoc**: Verify cho reasoning task phai kiem tra **correctness of finding**, khong chi **format match**. Future bench:
- R02 cap nhat verify — phai match `sitemapCache` hoac `\w+Cache` keyword
- Them ground-truth check layer

### Caveat 3: Free tier bill fallback

OpenRouter :free model co the bi bill khi quota het (fallback to paid variant). Ghi chu nay da co trong BENCHMARK-LEADERBOARD.md Section I.

### Caveat 4: Chua bench Opus + Gemini fast direct

- Opus (architect role) chua bench — uoc luong 2% workload
- Gemini fast direct (dung cho reviewer/dispatcher) chi ping test, chua full bench

Neu mot ngay thay ket qua bi thien kien → can bench 2 model nay.

## Open questions (can them bench)

1. ~~Sonnet 4.6 post-P1 re-bench~~ — **User decision 2026-04-18: KHONG re-bench, chi phi Sonnet $3/1M qua cao. Giu removed.**
2. **qwen3-plus multi-turn (>10 turn)** — Co tot hon cheap trong conversation dai?
3. **Opus architect worth $0.30/task** — Can bench D-tier spec/design task.
4. **Local Qwen2.5-coder-7b + stage-RAG** — 81-82% so bo, co dat cheap khong? Privacy use case.
5. **Retry 4 model 429** (qwen-coder/next, hermes, llama70b) — Khi co credit OpenRouter.
6. **Gemini fast direct full A+B+R bench** — Compare voi cheap cho reviewer/dispatcher role.
7. **DeepSeek V3.2 tren B+R tier post-P1** — Dong lai lo hong data cho future decision.

## Rationale

### Tai sao data-driven > theory-driven?

ADR-0001 chon Sonnet cho tech-lead vi "Sonnet tot hon DeepSeek ve reasoning". Bench thuc te: Sonnet 60% < cheap (GPT-5.4 Mini) 100%. **Brand va benchmark cong bo KHAC voi real-world agentic task**.

### Tai sao cheap wins moi role?

Hypothesis ban dau: model lon + dat = tot hon. Bench bac bo:
- Cheap **tim duoc security leak** ma qwen3-plus miss
- Cheap follow instruction chuan hon (output format chinh xac)
- Cheap iter efficient (3-5 vs 5-10) — khong over-explore
- Cheap speed nhanh — ket qua tuong tu voi thoi gian 1/2

GPT-5.4 Mini co le duoc tune cho agentic task cu the — ket qua khong co gi ky la neu xem day la model chuyen dung, khong phai "nho hon nen kem hon".

### Tai sao giu Opus architect?

- Chua bench thuc su → khong du basis de remove
- Theo ly thuyet + ADR-0005 escalation ladder, architect la floor cuoi cung
- 2% workload → cost $1-2/day khong dang ke
- **Action**: bench D-tier (architect/spec task) phien sau de xac nhan

### Tai sao giu qwen3-plus alias (opt-in)?

- Case duy nhat cheap khong dap ung duoc: **context > 400K**
- $50/1000 task KHONG dat khi that su can
- Alias co (khong active) → khong ton chi phi
- Removal dong nghia mat option emergency

## Consequences

### Tich cuc
- **56% cost reduction** vs v2.1 ($810→$360/month @ 1000 task/day)
- **Pass rate 40-60% → 95%+** — bench data thuc te
- Simpler config (it model hon, de debug)
- Bench harness + methodology reproducible — moi nguoi sau co the re-validate
- Tranh **cam bay tam ly**: "model dat hon = tot hon"

### Tieu cuc
- Mat option Sonnet (neu mot ngay can cho ly do cu the)
- Phu thuoc 1 provider (OpenRouter → OpenAI) cho 95% workload
- Chua bench Opus — co rui ro uoc luong sai
- Framework so sanh cho model moi cost ~$0.30-1.50 per model / tier

### Rui ro
- **OpenRouter outage** → mitigation: fast-or (Gemini via OR) + fast (Gemini direct) + qwen3-plus (Alibaba)
- **OpenAI deprecate GPT-5.4 Mini** → mitigation: bench model thay the kip thoi (framework da co)
- **Price change** → monitor DAILY_BUDGET + alert

## Alternatives Considered

### Alt 1: Giu Sonnet cho tech-lead (ADR-0001 nguyen ban)
- **Nhuoc**: Bench chung minh cheap vuot Sonnet 100% vs 60%. Tra 13x cost cho kem performance.

### Alt 2: qwen3-plus cho all thinking roles (v2.2 superseded)
- **Nhuoc**: R-tier bench chung minh qwen3-plus miss real leak + 5.7x cost cheap. Khong worth.

### Alt 3: All-cheap (even reviewer/dispatcher)
- **Nhuoc**: reviewer/dispatcher can speed (1M ctx + 1-turn output). Gemini Flash fit hon.

### Alt 4: Router dynamic (tu chon model theo task complexity)
- **Nhuoc**: Complex logic, khong needed. cheap pass tat ca A+B+R — dynamic routing khong giup.
- Tuong lai neu co task where cheap fail → xay dung fallback chain thay dynamic router.

## Implementation Notes

### File lien quan
- `router/orchestrator-agent.js:38-50` — AGENT_ROLE_MAP v2.3
- `router/smart-router.js:19-135` — scoring logic
- `litellm_config.yaml` — model aliases (post-Sonnet removal, 31 aliases)
- `benchmark/runner.js` — harness (A/B/R tier support)
- `benchmark/verify.js` — multi-file verify + 5 check kinds
- `benchmark/tasks.json` — 13 task definitions (T01-T10, R01-R03)
- `benchmark/fixtures/b-tier/` — isolated fixtures per task
- `docs/MODEL-COMPARISON.md` — bench data breakdown

### Commits
- `e453d66` perf(agent-loop): token cache + stuck detector
- `4a88098` feat(bench): B-tier T06-T10
- `927e159` feat(router): v2.2 (superseded by v2.3)
- `1656db1` feat(router): v2.3 all-cheap + R-tier bench
- `bbbe63a` chore(config): remove Sonnet 4.6 alias + MODEL-COMPARISON

### Reproducibility
```bash
# Full bench chay lai:
set -a && source .env && set +a
ORCAI_BENCHMARK=1 node benchmark/runner.js --tier A --model cheap,qwen3-plus
ORCAI_BENCHMARK=1 node benchmark/runner.js --tier B --model cheap,qwen3-plus
ORCAI_BENCHMARK=1 node benchmark/runner.js --tier R --model cheap,qwen3-plus
```

## References

- Supersedes: **ADR-0001** (5-tier model hierarchy)
- Related: ADR-0004 (LiteLLM gateway), ADR-0005 (escalation), ADR-0007 (budget)
- Data: `docs/MODEL-COMPARISON.md`, `benchmark/results/BENCHMARK-LEADERBOARD.md`
- Raw bench: `benchmark/results/2026-04-18-mo482pen.jsonl` (A-tier Qwen), `2026-04-18-mo489v2u.jsonl` (B-tier), `2026-04-18-mo496zvr.jsonl` (R-tier)
