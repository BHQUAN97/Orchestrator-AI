# Model Routing Map — Agent Task → Model

> Hermes goi model qua LiteLLM proxy.
> LiteLLM tu dong route + fallback + track cost.

## Routing Rules

| Agent Command | Task Type | LiteLLM Model Name | Primary Model | Ly do |
|---|---|---|---|---|
| `/spec` | spec | **smart** | Claude Sonnet 4 | Can reasoning sau, multi-file context |
| `/debug` (complex) | debug_complex | **smart** | Claude Sonnet 4 | Trace across layers |
| `/build` | build | **default** | Kimi K2.5 | Code generation tot, 128K context |
| `/task` | task_single | **default** | Kimi K2.5 | Task don le, ro rang |
| `/fix` | fix | **default** | Kimi K2.5 | Bug fix trung binh |
| `/plan` | plan | **default** | Kimi K2.5 | Planning nhanh |
| `/check` | review | **fast** | Gemini 2.5 Flash | Pattern scan, re |
| `/review` | review | **fast** | Gemini 2.5 Flash | Code review |
| `/security` | security | **fast** | Gemini 2.5 Flash | OWASP scan |
| `/ui-test` | ui_test | **fast** | Gemini 2.5 Flash | Multimodal, doc screenshot |
| `/cleanup` | cleanup | **cheap** | DeepSeek Chat | Don gian, re nhat |
| `/docs` | docs | **cheap** | DeepSeek Chat | Text generation |
| `/wire-memory` | wire | **cheap** | DeepSeek Chat | Tong hop text |
| `/perf` | perf | **default** | Kimi K2.5 | Profiling + fix |

## Fallback Chain (tu dong boi LiteLLM)

```
default:  Kimi K2.5 → OpenRouter/Kimi → DeepSeek
smart:    Sonnet 4 → OpenRouter/Sonnet → Kimi K2.5
fast:     Gemini Flash → OpenRouter/Gemini → DeepSeek
cheap:    DeepSeek → OpenRouter/DeepSeek → Gemini Flash
```

## Cost Estimates (per 1M tokens)

| Model Name | Provider | Input | Output | Cache Hit |
|---|---|---|---|---|
| default (Kimi K2.5) | Moonshot | $1.00 | $4.00 | ~$0.10 |
| smart (Sonnet 4) | Anthropic | $3.00 | $15.00 | ~$0.30 |
| fast (Gemini Flash) | Google | $0.15 | $0.60 | ~$0.02 |
| cheap (DeepSeek) | DeepSeek | $0.27 | $1.10 | ~$0.03 |

## Goi model cu the trong Hermes

Hermes goi qua LiteLLM proxy:
```bash
# Dung model default (Kimi K2.5)
hermes "fix bug upload" --model default

# Dung model smart (Sonnet) cho task phuc tap
hermes "thiet ke auth module" --model smart

# Dung model fast (Gemini) cho review
hermes "review file src/auth" --model fast

# Dung model cheap (DeepSeek) cho docs
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
