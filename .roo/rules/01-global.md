# Global Rules — Tat ca modes

## LiteLLM Proxy
- API Gateway: http://localhost:4001
- Models: default (Kimi K2.5), smart (Sonnet 4), fast (Gemini Flash), cheap (DeepSeek)
- Master Key: (set in .env as LITELLM_MASTER_KEY)

## Convention
- Comment business logic: tieng Viet co dau
- Comment technical/API: tieng Anh
- Commit format: type(scope): mo ta
- Khong commit: .env, node_modules, __pycache__, .DS_Store

## Project Structure
- analytics/ — Cost tracking dashboard + API server
- router/ — Smart Router + Orchestrator Agent
- graph/ — Trust Graph (context reduction)
- data/ — Analytics data (JSON)
- docs/ — Documentation

## Ports
- 4001: LiteLLM Proxy
- 3000: Hermes Agent Dashboard
- 9080: Orchestrator Dashboard
- 9081: Analytics API + Dashboard
