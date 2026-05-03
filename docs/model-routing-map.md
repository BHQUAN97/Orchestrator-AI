# Model Routing Map — Agent Task → Model

> OrcAI goi model qua LiteLLM proxy.
> LiteLLM tu dong route + fallback + track cost.
> Updated: 2026-05-03 — v2.3 lineup (DeepSeek V4 + Gemini 3 Flash)

## Execution Flow (v2.3)

```
User Request
    ↓
[1] Scanner (cheap/GPT-5.4 Mini) → quet project, doc file, thu thap context
    ↓
[2] Planner (default/DeepSeek V4 Flash) → xay dung plan tu scan data thuc te
    ↓
[3] Tech Lead (smart/Gemini 3 Flash) → review plan, approve/modify/reject
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
| planner | plan | **default** | DeepSeek V4 Flash | Xay dung plan tu scan data. GIA VUA. |
| architect | design | **architect** | DeepSeek V4 Pro | SA — thiet ke kien truc he thong |
| escalation | escalation | **architect** | DeepSeek V4 Pro | Smart gap kho → escalate len Pro |
| tech-lead | review | **smart** | Gemini 3 Flash | Review plan, reasoning nhanh |
| debugger | debug_complex | **smart** | Gemini 3 Flash | Trace across layers, context lon |
| `/spec` | spec | **smart** | Gemini 3 Flash | It ao giac, reasoning sau |
| `/build` | build | **default** | DeepSeek V4 Flash | Code gen manh, gia re, it drift |
| `/task` | task_single | **default** | DeepSeek V4 Flash | Task don le, ro rang |
| `/fix` | fix | **default** | DeepSeek V4 Flash | Bug fix — logic tot |
| `/plan` | plan | **default** | DeepSeek V4 Flash | Planning nhanh |
| `/check` | review | **fast** | Gemini 3 Flash | Pattern scan nhanh |
| `/review` | review | **fast** | Gemini 3 Flash | Code review |
| `/security` | security | **fast** | Gemini 3 Flash | OWASP scan |
| `/ui-test` | ui_test | **fast** | Gemini 3 Flash | Multimodal, doc screenshot |
| `/cleanup` | cleanup | **cheap** | GPT-5.4 Mini | Don gian, it bua hon model re |
| `/docs` | docs | **cheap** | GPT-5.4 Mini | Text generation chinh xac |
| `/wire-memory` | wire | **cheap** | GPT-5.4 Mini | Tong hop text |
| `/perf` | perf | **default** | DeepSeek V4 Flash | Profiling + fix |

> **Khi can Opus:** Dung `--model opus-legacy` tuong minh. Opus 4.6 khong duoc tu dong routing
> vi chi phi ($15/1M) qua cao so voi V4 Pro ($2-5/1M).

## Fallback Chain (tu dong boi LiteLLM)

```
architect: DeepSeek V4 Pro (OpenRouter)
smart:     Gemini 3 Flash (Google direct) → Gemini 3 Flash (OpenRouter)
default:   DeepSeek V4 Flash (OpenRouter)
fast:      Gemini 3 Flash (Google direct) → Gemini 3 Flash (OpenRouter)
cheap:     GPT-5.4 Mini (OpenRouter)
opus-legacy: Claude Opus 4.6 (OpenRouter) — chi dung khi goi tuong minh
```

## Escalation Flow

```
cheap → default → smart → architect
  ↑        ↑         ↑         ↑
GPT Mini  DS V4 Flash  Gemini  DS V4 Pro
  $0.20    ~$0.50     $0.15    ~$2-5

Khi model tier thap gap kho (confidence < 0.6, error loop, hoac
user request) → tu dong escalate len tier cao hon.
architect (V4 Pro) la tier cao nhat — khong escalate tiep.
```

## Cost Estimates (per 1M tokens)

| Model Name | Provider | Input | Output | Hallucination |
|---|---|---|---|---|
| architect (DeepSeek V4 Pro) | OpenRouter | ~$2-5 | ~$8-15 | Thap |
| smart/fast (Gemini 3 Flash) | Google/OpenRouter | $0.15 | $0.60 | Trung binh |
| default (DeepSeek V4 Flash) | OpenRouter | ~$0.30-0.50 | ~$1.20 | Thap-TB |
| cheap (GPT-5.4 Mini) | OpenRouter | $0.20 | $0.80 | TB |
| opus-legacy (Claude Opus 4.6) | OpenRouter | $15.00 | $75.00 | Rat thap |

## Goi model cu the trong OrcAI

```bash
# Dung model architect (DeepSeek V4 Pro) cho thiet ke kien truc
orcai "thiet ke microservice architecture" --model architect

# Dung model smart (Gemini 3 Flash) cho spec/debug
orcai "thiet ke auth module" --model smart

# Dung model default (DeepSeek V4 Flash) cho build/fix
orcai "fix bug upload" --model default

# Dung model fast (Gemini 3 Flash) cho review
orcai "review file src/auth" --model fast

# Dung model cheap (GPT-5.4 Mini) cho docs
orcai "viet JSDoc cho utils/" --model cheap

# Dung Opus khi thuc su can (dat — yeu cau tuong minh)
orcai "audit toan bo kien truc he thong" --model opus-legacy
```

## LiteLLM API truc tiep

```bash
# LiteLLM port: 5002 (khong phai 4001)
curl http://localhost:5002/v1/chat/completions \
  -H "Authorization: Bearer sk-master-change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "cheap",
    "messages": [{"role": "user", "content": "Viet JSDoc cho function nay: ..."}]
  }'
```
