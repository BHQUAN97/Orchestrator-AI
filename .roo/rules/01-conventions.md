# Conventions chung

## Language
- Comment business logic: tieng Viet co dau
- Comment technical/API: tieng Anh
- UI text: tieng Viet co dau, font-size min 14px

## Code
- Commit: type(scope): mo ta — type: feat/fix/refactor/chore/docs
- Khong commit: .env, node_modules, __pycache__, .DS_Store
- Moi function > 20 dong: comment muc dich

## LiteLLM Models (http://localhost:4001)
- `default` = Kimi K2.5 ($1/1M) — frontend, general
- `smart` = Sonnet 4 ($3/1M) — architecture, complex
- `fast` = Gemini Flash ($0.15/1M) — review, scan
- `cheap` = DeepSeek ($0.27/1M) — backend, seed data
