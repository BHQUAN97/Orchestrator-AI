# Global Rules — Tat ca modes (v2.1 — 2026-04-16)

## Services (dai port 5000)
- Hermes Brain: http://localhost:5000
- Hermes WebUI: http://localhost:5001
- LiteLLM Gateway: http://localhost:5002
- Orchestrator API: http://localhost:5003
- Analytics: http://localhost:5004

## Models (v2.1)
- architect (Opus 4.6): system design, task cuc kho
- smart (Sonnet 4.6): review, debug, reasoning
- default (DeepSeek V3.2): FE/BE code gen
- fast (Gemini 3 Flash): review, scan
- cheap (GPT-5.4 Mini): docs, scanner

## Budget
- $2/ngay — auto-downgrade khi gan het

## Convention
- Comment business logic: tieng Viet
- Comment technical/API: tieng Anh
- Commit format: type(scope): mo ta
- Khong commit: .env, node_modules, __pycache__, .DS_Store
