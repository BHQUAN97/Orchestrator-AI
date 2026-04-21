# OrcAI Documentation

> AI Coding Agent v2.3 — Multi-model orchestration với tool use

## Mục lục

| File | Nội dung |
|------|----------|
| [01-introduction.md](01-introduction.md) | Giới thiệu dự án — mục tiêu, ý nghĩa, kiến trúc tổng quan |
| [02-flows.md](02-flows.md) | Business flows — CLI, Agent Loop, Orchestrator Pipeline |
| [03-adr.md](03-adr.md) | Architecture Decision Records (ADR-0001 → ADR-0011) |
| [04-architecture.md](04-architecture.md) | Thiết kế chi tiết — components, data model, ports |
| [05-components.md](05-components.md) | Chi tiết từng module: HermesBridge, Memory, Budget, Hooks… |
| [06-usage.md](06-usage.md) | Hướng dẫn sử dụng — cài đặt, CLI options, slash commands |
| [07-tools.md](07-tools.md) | Tool reference — 61 tools, permissions, MCP |

## Quick Start

```bash
# Cài đặt
git clone https://github.com/BHQUAN97/Orchestrator-AI.git
cd ai-orchestrator && npm install && npm link

# One-shot
orcai "sửa bug login không redirect"

# Interactive
orcai -i -p /path/to/project

# Plan trước khi chạy
orcai --plan "refactor auth module"

# Giới hạn budget $0.50
orcai -i --budget 0.50
```

## Services Map

| Port | Service | Vai trò |
|------|---------|---------|
| 5000 | Hermes | Brain — memory, learning, decision-making |
| 5002 | LiteLLM | Model gateway — alias routing, cost cap |
| 5003 | Orchestrator | Hands — scan → plan → execute pipeline |
| 5004 | Analytics | Cost dashboard |
| 5005 | Gateway + Portal | Auth, SSE streaming, mobile UI |
