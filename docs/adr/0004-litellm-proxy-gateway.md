# ADR-0004: LiteLLM Proxy Gateway (abstraction layer cho moi LLM call)

- **Status**: accepted
- **Date**: 2026-04-10
- **Tags**: infra, ai-routing

## Context

Support 5+ LLM provider: Anthropic, Google Gemini, DeepSeek, Moonshot Kimi, OpenAI. Moi provider co:
- API endpoint khac
- Auth header khac
- Rate limit (RPM) khac
- Response format khac (chua nhiet do chap nhan, chuan hoa thanh OpenAI-compatible la tren hen)

Neu code truc tiep call API → coupling cao, doi provider = refactor toan bo.

## Decision

**Tat ca LLM call qua LiteLLM Proxy** (`http://localhost:5002`):

1. Config `litellm_config.yaml` dinh nghia alias: `default`, `smart`, `fast`, `cheap`, `architect`
2. Orchestrator chi biet alias → LiteLLM route den provider thuc
3. Fallback chain: neu DeepSeek down → auto switch OpenRouter/DeepSeek → Kimi
4. RPM enforce tai LiteLLM (khong phai tai code)

Key alias:
```yaml
- model_name: "default"
  litellm_params:
    model: "openai/deepseek/deepseek-v3.2"
    api_key: "os.environ/OPENROUTER_API_KEY"
    rpm: 30

- model_name: "smart"
  litellm_params:
    model: "openai/anthropic/claude-sonnet-4-6"
    rpm: 20
```

## Rationale

- Provider-agnostic → swap model khong sua code
- Fallback chain → resilience khi provider tam down
- RPM enforce tap trung → khong vuot rate limit vi code logic sai
- OpenRouter la primary → 200+ model backup

## Consequences

### Tich cuc
- Doi model = sua YAML, khong compile
- Visibility: LiteLLM log tat ca call → audit cost/latency
- Provider outage khong lam die service

### Tieu cuc
- Them 1 network hop (~50ms latency)
- LiteLLM phai chay (1 container), se-n-gle point of failure cho non-critical path
- YAML config co the sai → can test smoke

### Rui ro
- **LiteLLM container crash** → mitigation: Docker restart policy `unless-stopped`, health check `/health/liveliness`
- **API key leak qua env** → mitigation: LITELLM_MASTER_KEY bearer auth

## Alternatives Considered

### Direct SDK call moi provider
- **Nhuoc**: 5+ SDK, 5+ auth flow, khong fallback

### Custom wrapper
- **Uu**: control
- **Nhuoc**: reinvent wheel, LiteLLM da chin

### Portkey / OpenRouter truc tiep
- **Uu**: giong LiteLLM
- **Nhuoc**: vendor lock-in (LiteLLM self-host duoc)

## References

- `/litellm_config.yaml`
- Related: ADR-0001 (tier), ADR-0007 (budget)
