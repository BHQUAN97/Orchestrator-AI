# Roo Code + Hermes Infrastructure — Hướng dẫn setup

## Tổng quan kiến trúc

```
┌─────────────────────────────────────────────┐
│         VS Code + Roo Code Extension        │
│         (IDE layer — edit, run, test)        │
│                                             │
│  Mode: Spec │ Build │ Review │ Debug │ Docs │
│         │       │       │        │      │   │
│         ▼       ▼       ▼        ▼      ▼   │
│    ┌──────────────────────────────────────┐  │
│    │       LiteLLM Proxy (:4001)         │  │
│    │       + Smart Router                │  │
│    └────────┬────────┬────────┬──────────┘  │
│             │        │        │             │
│         Sonnet    Kimi     Gemini  DeepSeek │
│         $3/1M    $1/1M   $0.15/1M  $0.27   │
└─────────────────────────────────────────────┘
         │
    ┌────┴────────────────────────┐
    │  Hermes Infrastructure     │
    │  • Analytics Dashboard     │
    │  • Trust Graph             │
    │  • Skills (self-improving) │
    │  • 24/7 Cron automation    │
    └────────────────────────────┘
```

## Bước 1: Cài Roo Code

```bash
code --install-extension RooVeterinaryInc.roo-cline
```

## Bước 2: Cấu hình API → LiteLLM

1. Mở VS Code
2. Click icon Roo Code ở sidebar (hoặc `Ctrl+Shift+P` → "Roo Code: Open")
3. Click ⚙️ Settings (góc trên phải panel Roo Code)
4. Cấu hình:

| Setting | Giá trị |
|---------|---------|
| API Provider | **LiteLLM** |
| Base URL | `http://localhost:4001` |
| API Key | `sk-master-change-me` |
| Model | Chọn từ dropdown (auto-fetch) |

## Bước 3: Tạo API Profiles (model theo mode)

Trong Roo Code Settings → API Configuration:

| Profile Name | Model | Dùng cho |
|-------------|-------|----------|
| **Reasoning** | `smart` (Sonnet 4) | Spec, Debug, Architecture |
| **Coding** | `default` (Kimi K2.5) | Build, Code |
| **Review** | `fast` (Gemini Flash) | Review, Scan |
| **Cheap** | `cheap` (DeepSeek) | Docs, Seed data, Ask |

## Bước 4: Gán Profile cho Mode

| Mode | Profile | Chi phí |
|------|---------|---------|
| `spec` | Reasoning (Sonnet) | $3/1M |
| `architect` | Reasoning (Sonnet) | $3/1M |
| `build` | Coding (Kimi K2.5) | $1/1M |
| `code` | Coding (Kimi K2.5) | $1/1M |
| `review` | Review (Gemini) | $0.15/1M |
| `debug` | Reasoning (Sonnet) | $3/1M |
| `docs` | Cheap (DeepSeek) | $0.27/1M |
| `seed` | Cheap (DeepSeek) | $0.27/1M |
| `ask` | Cheap (DeepSeek) | $0.27/1M |

## Bước 5: Custom Modes (đã có sẵn)

File `.roomodes` đã được tạo cho tất cả projects:
- LeQuyDon, FashionEcom, VietNet2026, WebPhoto, RemoteTerminal, VIETNET, ai-orchestrator

Mỗi project có 6 custom modes: **spec, build, review, debug, docs, seed**

## Sử dụng

### Chuyển mode trong Roo Code
- Click mode selector ở panel Roo Code
- Hoặc gõ `/mode spec` trong chat

### Workflow thường ngày
```
1. Mở project trong VS Code
2. Mở Roo Code panel
3. Chọn mode phù hợp:
   - Thiết kế feature → mode "spec" (Sonnet)
   - Code feature → mode "build" (Kimi K2.5)
   - Review code → mode "review" (Gemini Flash)
   - Debug lỗi → mode "debug" (Sonnet)
   - Viết docs → mode "docs" (DeepSeek)
   - Seed data → mode "seed" (DeepSeek)
4. Chat và làm việc
5. Model tự động chọn theo mode → tối ưu chi phí
```

### Kết hợp với Claude Code
```
Claude Code ($100/tháng Max 5x):
  → Build feature lớn, multi-file
  → Architecture decisions
  → Complex debugging

Roo Code + LiteLLM (~$15-40/tháng):
  → Review code (Gemini Flash — gần free)
  → Seed data (DeepSeek — rẻ)
  → Simple fix (Kimi K2.5 — rẻ)
  → Docs (DeepSeek — rẻ)
  → Spec draft (Sonnet qua OpenRouter — $3/1M)
```

## Troubleshooting

### Roo Code không thấy model
- Kiểm tra LiteLLM đang chạy: `curl http://localhost:4001/health`
- Kiểm tra Docker: `docker ps | grep litellm`
- Start services: chạy `orchestrator.bat` → [1] Start all

### Model trả lỗi
- Check API key: `curl http://localhost:4001/v1/models -H "Authorization: Bearer sk-master-change-me"`
- Check OpenRouter balance: https://openrouter.ai/credits
- Check logs: `docker logs litellm-proxy --tail 20`

### Thêm model mới
1. Sửa `litellm_config.yaml` → thêm model
2. Chạy `orchestrator.bat` → [R] Restart LiteLLM
3. Model mới tự xuất hiện trong Roo Code dropdown
