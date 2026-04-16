# Model Routing Map — Agent Task → Model

> Hermes goi model qua LiteLLM proxy.
> LiteLLM tu dong route + fallback + track cost.
> Updated: 2026-04-16 — Upgrade model lineup v2

## Execution Flow (v2.1)

```
User Request
    ↓
[1] Scanner (cheap/GPT-5.4 Mini) → quet project, doc file, thu thap context
    ↓
[2] Planner (default/DeepSeek V3.2) → xay dung plan tu scan data thuc te
    ↓
[3] Tech Lead (smart/Sonnet 4.6) → review plan, approve/modify/reject
    ↓
[4] Execute → dev agents chay song song
    ↓ (neu gap kho)
[5] Escalation: default → smart → architect
    ↓
[6] Synthesize (fast/Gemini 3 Flash) → tong hop ket qua
```

## Routing Rules

| Agent Role | Task Type | LiteLLM Model Name | Primary Model | Ly do |
|---|---|---|---|---|
| scanner | scan | **cheap** | GPT-5.4 Mini | Quet project, thu thap context. RE. |
| planner | plan | **default** | DeepSeek V3.2 | Xay dung plan tu scan data. GIA VUA. |
| architect | design | **architect** | Claude Opus 4.6 | SA — thiet ke kien truc he thong |
| escalation | escalation | **architect** | Claude Opus 4.6 | Smart gap kho → escalate len Opus |
| tech-lead | review | **smart** | Claude Sonnet 4.6 | Review plan, handle escalation |
| debugger | debug_complex | **smart** | Claude Sonnet 4.6 | Trace across layers, khong bua |
| `/spec` | spec | **smart** | Claude Sonnet 4.6 | It ao giac, reasoning sau |
| `/build` | build | **default** | DeepSeek V3.2 | Code gen manh, gia re, it drift |
| `/task` | task_single | **default** | DeepSeek V3.2 | Task don le, ro rang |
| `/fix` | fix | **default** | DeepSeek V3.2 | Bug fix — logic tot |
| `/plan` | plan | **default** | DeepSeek V3.2 | Planning nhanh |
| `/check` | review | **fast** | Gemini 3 Flash | Pattern scan nhanh |
| `/review` | review | **fast** | Gemini 3 Flash | Code review |
| `/security` | security | **fast** | Gemini 3 Flash | OWASP scan |
| `/ui-test` | ui_test | **fast** | Gemini 3 Flash | Multimodal, doc screenshot |
| `/cleanup` | cleanup | **cheap** | GPT-5.4 Mini | Don gian, it bua hon model re |
| `/docs` | docs | **cheap** | GPT-5.4 Mini | Text generation chinh xac |
| `/wire-memory` | wire | **cheap** | GPT-5.4 Mini | Tong hop text |
| `/perf` | perf | **default** | DeepSeek V3.2 | Profiling + fix |

## Fallback Chain (tu dong boi LiteLLM)

```
architect: Opus 4.6 → Sonnet 4.6
smart:     Sonnet 4.6 → DeepSeek V3.2
default:   DeepSeek V3.2 → Kimi K2.5 (legacy)
fast:      Gemini 3 Flash (direct) → Gemini 3 Flash (OpenRouter)
cheap:     GPT-5.4 Mini → Gemini 3 Flash
```

## Escalation Flow

```
cheap → default → smart → architect
  ↑        ↑         ↑         ↑
GPT Mini  DS V3.2  Sonnet   Opus 4.6
  $0.20    $0.30    $3.00    $15.00

Khi model tier thap gap kho (confidence < 0.6, error loop, hoac
user request) → tu dong escalate len tier cao hon.
architect (Opus) la tier cao nhat — khong escalate tiep.
```

## Cost Estimates (per 1M tokens)

| Model Name | Provider | Input | Output | Hallucination |
|---|---|---|---|---|
| architect (Opus 4.6) | Anthropic | $15.00 | $75.00 | Rat thap |
| smart (Sonnet 4.6) | Anthropic | $3.00 | $15.00 | Rat thap |
| default (DeepSeek V3.2) | DeepSeek | $0.30 | $1.20 | Thap-TB |
| fast (Gemini 3 Flash) | Google | $0.15 | $0.60 | Trung binh |
| cheap (GPT-5.4 Mini) | OpenAI | $0.20 | $0.80 | TB |

## So sanh chi phi: v1 vs v2

### Model lineup

| Tier | v1 (cu) | v2 (moi) | Ly do upgrade |
|---|---|---|---|
| architect | *(khong co)* | Opus 4.6 | MOI — SA tier, task cuc kho |
| smart | Sonnet 4 ($3/$15) | Sonnet 4.6 ($3/$15) | Upgrade nhe, it ao giac hon |
| default | Kimi K2.5 ($1/$4) | DeepSeek V3.2 ($0.30/$1.20) | **Re hon 3x**, code tot hon, it bua |
| fast | Gemini 2.5 Flash ($0.15/$0.60) | Gemini 3 Flash ($0.15/$0.60) | Gia tuong duong, model moi hon |
| cheap | DeepSeek v3-0324 ($0.27/$1.10) | GPT-5.4 Mini ($0.20/$0.80) | Re hon, it bua hon |

### Uoc tinh chi phi ngay (100 request/ngay)

| Scenario | v1 (cu) | v2 (moi) | Chenh lech |
|---|---|---|---|
| 60 default requests (avg 2K in + 4K out tokens) | $0.60 | **$0.32** | -47% ↓ |
| 20 fast requests (avg 5K in + 1K out tokens) | $0.03 | $0.03 | 0% |
| 15 smart requests (avg 3K in + 3K out tokens) | $0.20 | $0.20 | 0% |
| 5 cheap requests (avg 1K in + 2K out tokens) | $0.01 | $0.01 | 0% |
| 2 architect requests (avg 5K in + 5K out tokens) | $0.00 | **$0.53** | +$0.53 ↑ |
| **TONG/NGAY** | **$0.84** | **$1.09** | **+$0.25 (+30%)** |
| **TONG/THANG (30 ngay)** | **$25.20** | **$32.70** | **+$7.50** |

### Budget cap: $2/ngay (CUNG)

Orchestrator co budget guard tu dong:
- Truoc moi API call → check con du budget khong
- Neu khong du → **tu dong downgrade** model: architect → smart → default → fast → cheap
- Neu het sach → throw error, dung lai
- Reset moi ngay 00:00

### Uoc tinh so request trong $2/ngay

| Model | Cost/req (avg 3K tokens) | Max requests/ngay |
|---|---|---|
| architect (Opus) | ~$0.135 | ~14 |
| smart (Sonnet) | ~$0.027 | ~74 |
| default (DeepSeek) | ~$0.002 | ~1000 |
| fast (Gemini) | ~$0.001 | ~2000 |
| cheap (GPT Mini) | ~$0.0015 | ~1300 |

### Mix thuc te (trong $2/ngay)

| Scenario | architect | smart | default | fast | cheap | Tong |
|---|---|---|---|---|---|---|
| Heavy build | 1 | 5 | 40 | 15 | 10 | ~$0.45 |
| Complex debug | 2 | 10 | 20 | 10 | 5 | ~$0.65 |
| System design | 3 | 8 | 15 | 10 | 5 | ~$0.73 |
| Max day | 5 | 15 | 60 | 20 | 20 | ~$1.40 |

**$2/ngay thoai mai cho 99% use cases.** Chi vuot khi spam architect (>14 req/ngay).

## Goi model cu the trong Hermes

Hermes goi qua LiteLLM proxy:
```bash
# Dung model architect (Opus 4.6) cho thiet ke kien truc
hermes "thiet ke microservice architecture" --model architect

# Dung model smart (Sonnet 4.6) cho spec/debug
hermes "thiet ke auth module" --model smart

# Dung model default (DeepSeek V3.2) cho build/fix
hermes "fix bug upload" --model default

# Dung model fast (Gemini 3 Flash) cho review
hermes "review file src/auth" --model fast

# Dung model cheap (GPT-5.4 Mini) cho docs
hermes "viet JSDoc cho utils/" --model cheap
```

## Trong Claude Code — goi LiteLLM cho task nhe

Claude Code van dung Opus cho task chinh.
Nhung co the delegate task nhe qua LiteLLM:

```bash
# Goi truc tiep LiteLLM API
curl http://localhost:4001/v1/chat/completions \
  -H "Authorization: Bearer sk-master-change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cheap",
    "messages": [{"role": "user", "content": "Viet JSDoc cho function nay: ..."}]
  }'
```
