# Hướng dẫn sử dụng

## 1. Cài đặt

### Prerequisites

```bash
# Node.js >= 18
node --version  # v18.x trở lên

# Docker (cho LiteLLM + services)
docker --version

# LM Studio (optional, cho local model)
# Download tại lmstudio.ai, load Qwen 2.5 7B Instruct Q4_K_M
```

### Clone và cài đặt

```bash
git clone https://github.com/BHQUAN97/Orchestrator-AI.git
cd ai-orchestrator
npm install

# Link CLI globally (để gọi `orcai` từ bất kỳ đâu)
npm link
```

### Khởi động services

```bash
# Khởi động tất cả services
docker compose up -d

# Hoặc chỉ LiteLLM (bắt buộc)
docker compose up -d litellm

# Kiểm tra health
orcai --doctor
```

### Cấu hình

```bash
# Tạo .env từ template
cp .env.example .env
# Chỉnh sửa: OPENROUTER_API_KEY, GOOGLE_API_KEY, LITELLM_KEY, GATEWAY_TOKEN
```

---

## 2. Sử dụng cơ bản

### One-shot mode

```bash
# Task đơn giản
orcai "sửa bug login không redirect"

# Chỉ định project
orcai -p /path/to/project "thêm unit test cho AuthService"

# Chọn model
orcai --model architect "redesign database schema cho multi-tenant"

# Giới hạn budget
orcai --budget 0.50 "refactor toàn bộ auth module"

# Plan trước khi chạy
orcai --plan "migrate từ REST sang GraphQL"
```

### Interactive mode

```bash
# Bắt đầu session interactive
orcai -i

# Với project cụ thể
orcai -i -p /path/to/project

# Auto-approve mọi change (dùng cẩn thận)
orcai -i -y

# Worktree isolation (an toàn hơn cho thay đổi lớn)
orcai --worktree -i

# Resume session cũ
orcai --resume
orcai --resume ses_abc123xyz
```

### Prompt conventions

```bash
# Attach file vào context
orcai "review code này" @src/auth/login.ts
orcai "tại sao lỗi này?" @logs/error.log @src/api/users.ts

# Multiple files
orcai "sync schema" @src/models/User.ts @src/types/api.ts

# File với space trong tên
orcai "sửa bug" @"src/components/My Component.tsx"
```

---

## 3. CLI Options Reference

### Cơ bản

| Option | Short | Default | Mô tả |
|--------|-------|---------|-------|
| `[prompt...]` | | | Task prompt (one-shot) |
| `--interactive` | `-i` | `false` | Interactive mode |
| `--project <path>` | `-p` | `cwd` | Project directory |
| `--model <name>` | `-m` | `smart` | Model alias |
| `--role <role>` | `-r` | `builder` | Agent role |
| `--yes` | `-y` | `false` | Auto-approve file changes |

### Model aliases

| Alias | Provider | Dùng khi |
|-------|---------|----------|
| `cheap` | GPT-5.4 Mini | Default cho 95% tasks (nhanh + rẻ nhất) |
| `fast` | Gemini 3 Flash | Review, simple Q&A |
| `smart` | Gemini 3 Flash | Multi-file, debug (mapped từ Sonnet) |
| `default` | DeepSeek V3.2 | Fallback |
| `kimi` | Kimi K2.5 | Long context tasks |
| `architect` | Claude Opus 4.6 | System design, major refactor |
| `local-heavy` | Qwen 7B (LM Studio) | Offline, privacy-sensitive |
| `local-classifier` | Qwen 1.5B | Routing only (auto) |

### Agent roles

| Role | Permissions | Dùng khi |
|------|-------------|----------|
| `builder` | read+write+execute | Default: implement features, fix bugs |
| `fe-dev` | read+write (*.tsx/css) | Frontend-only changes |
| `be-dev` | read+write (*.ts/py/go) | Backend-only changes |
| `reviewer` | read only | Code review, audit |
| `planner` | read only | Architecture planning |
| `debugger` | read+execute | Debug, no write |

### Performance & Cost

| Option | Default | Mô tả |
|--------|---------|-------|
| `--budget <usd>` | Infinity | Cap session cost |
| `--no-cache` | | Tắt Anthropic prompt caching |
| `--direct` | | Skip repo scan (nhanh hơn cho task nhỏ) |
| `--no-parallel` | | Tắt parallel tool execution |
| `--max-iterations <n>` | 30 | Giới hạn tool call iterations |
| `--retries <n>` | 3 | LLM fetch retries |
| `--estimate-threshold <usd>` | 0.50 | Confirm nếu cost ước tính > threshold |

### Routing & Model Selection

| Option | Default | Mô tả |
|--------|---------|-------|
| `--use-classifier` | | Dùng LLM classifier (chính xác hơn, ~$0.0001/call) |
| `--no-hermes` | | Tắt Hermes bridge (SmartRouter + Memory) |
| `--via-orchestrator` | | Dùng full Orchestrator pipeline |
| `--orchestrator-url <url>` | `:5003` | Orchestrator endpoint |

### Context & Memory

| Option | Default | Mô tả |
|--------|---------|-------|
| `--resume [id]` | | Resume session cũ (latest nếu không có id) |
| `--no-memory` | | Tắt memory store |
| `--no-warm-context` | | Không inject files từ session trước |
| `--no-context-guard` | | Tắt hallucination detection |

### Debugging

| Option | Default | Mô tả |
|--------|---------|-------|
| `--doctor` | | Health check và exit |
| `--plan` | | Analyze + hiện plan trước khi execute |
| `--thinking` | | Bật extended thinking (Claude models) |
| `--thinking-budget <n>` | 8000 | Thinking token budget |
| `--no-thinking-auto` | | Tắt auto-thinking cho complex keywords |
| `--no-transcript` | | Tắt transcript logging |
| `--replay <id>` | | Replay transcript (`"latest"`) |
| `--replay-speed <ms>` | 0 | Delay giữa events khi replay |
| `--replay-filter <type>` | | Filter: message\|tool_call\|tool_result\|meta\|error |

### Other

| Option | Default | Mô tả |
|--------|---------|-------|
| `--worktree` | | Chạy trong isolated git worktree |
| `--no-confirm` | | Bỏ qua confirm lệnh nguy hiểm |
| `--no-hooks` | | Tắt hooks (Pre/PostToolUse/Stop) |
| `--no-mcp` | | Tắt MCP servers |
| `--mcp-config <path>` | | Thêm MCP config JSON |
| `--watch` | | Fs watcher invalidate cache khi file thay đổi |
| `--no-markdown` | | Tắt markdown rendering |
| `--no-status-line` | | Ẩn status line |
| `--url <url>` | `:5002` | LiteLLM URL |
| `--key <key>` | env | LiteLLM API key |

---

## 4. Slash Commands (Interactive Mode)

### Session & Navigation

| Command | Mô tả |
|---------|-------|
| `/help` | Hiện danh sách tất cả commands |
| `/exit` hoặc `/quit` | Thoát session |
| `/sessions` | Danh sách sessions gần đây (5 gần nhất) |
| `/resume` | Chọn session cũ để load lại (inquirer list) |
| `/redo` | Re-run last user prompt |

### Files & Changes

| Command | Mô tả |
|---------|-------|
| `/files` | Danh sách files đã thay đổi trong session |
| `/undo` | Undo last file change (restore trước đó) |

### Stats & Cost

| Command | Mô tả |
|---------|-------|
| `/stats` | Tool call statistics (JSON) |
| `/tokens` hoặc `/cost` | Token count + cache hit rate + cost |
| `/budget` | Session budget + daily budget status + countdown đến reset |
| `/compact` | Nén conversation history về 40% context window |

### Planning & Execution

| Command | Mô tả |
|---------|-------|
| `/plan <task>` | Chạy plan mode: analyze → show plan → approve/reject → execute |
| `/init [--force]` | Tạo CLAUDE.md từ repo scan |
| `/todos` | Hiện agent todo list (TodoWrite items) |

### Routing & Model

| Command | Mô tả |
|---------|-------|
| `/route` | Last routing decisions (SmartRouter/classifier) |
| `/locks` | Active decision locks (scope, decision, relatedFiles) |
| `/guard` | Context guard ground truth (files changed/read, commands run) |

### Memory

| Command | Syntax | Mô tả |
|---------|--------|-------|
| `/memory` | `/memory` hoặc `/memory list` | Xem 10 entries gần nhất |
| `/memory search <query>` | `/memory search auth bug` | TF-IDF search memory |
| `/memory clear` | `/memory clear` | Xóa tất cả memory (không thể undo) |

### MCP Commands

| Command | Mô tả |
|---------|-------|
| `/mcp` | MCP server status |
| `/mcp list` | Danh sách available servers |
| `/mcp tools <server>` | Tools của 1 server cụ thể |
| `/mcp enable <server>` | Enable MCP server |
| `/mcp disable <server>` | Disable MCP server |
| `/mcp call <mcp__s__t> <json>` | Gọi trực tiếp 1 MCP tool |

### Monitoring & Debug

| Command | Mô tả |
|---------|-------|
| `/doctor` | Health check: LiteLLM, MCP, hooks, memory, env vars |
| `/transcript` | Path đến file transcript hiện tại |
| `/transcripts` | List 10 transcripts gần nhất + size |
| `/replay [id]` | Replay transcript (default: latest) |
| `/cache on\|off` | Bật/tắt Anthropic prompt caching |
| `/ratelimit` hoặc `/rl` | API rate limit state + retry count |
| `/heal` hoặc `/healer` | Self-healer stats + recent errors |

### Orchestrator & Background

| Command | Mô tả |
|---------|-------|
| `/orchestrator` hoặc `/orch` | Check Orchestrator health (:5003) |
| `/delegate <task>` | Delegate task sang full Orchestrator pipeline |
| `/bg` | Danh sách background processes (bg_bash) |

### Advanced

| Command | Mô tả |
|---------|-------|
| `/claudemd` | CLAUDE.md hierarchy đã load (path + size) |
| `/team` | Multi-agent team status |

---

## 5. Keyboard Shortcuts (Terminal)

### InputQueue — Always-on Listener

OrcAI dùng custom `InputQueue` thay vì readline thông thường. Có thể gõ trong khi agent đang chạy — tin nhắn được buffer và dùng làm amendment.

| Key | Action |
|-----|--------|
| `Ctrl+C` (1 lần) | Interrupt agent sau iteration hiện tại, prompt amendment |
| `Ctrl+C` (2 lần nhanh) | Force quit session |
| `Enter` (khi agent chạy) | Buffer message, dùng làm amendment khi agent dừng |
| `Tab` | Autocomplete slash commands + file paths |
| `↑` / `↓` | History navigation (readline history) |
| `Ctrl+A` | Đầu dòng |
| `Ctrl+E` | Cuối dòng |
| `Ctrl+U` | Xóa đến đầu dòng |
| `Ctrl+K` | Xóa từ cursor đến cuối dòng |
| `Ctrl+W` | Xóa word trước cursor |
| `Ctrl+L` | Clear screen (readline default) |

### Autocomplete

Tab autocomplete hoạt động cho:
- Slash commands: `/` → Tab → hiện danh sách built-in + custom commands
- Custom commands từ `skills/*.md` + `.claude/commands/*.md`
- File paths sau `@`: `@src/` → Tab → danh sách files trong `src/`

### Interrupt & Amendment Flow

```
Agent đang chạy...
[User gõ: "thêm unit test nữa"]  ← buffer
[User nhấn Ctrl+C]
→ "⚡ Dừng sau 5 iter. Dùng context đã queue: 'thêm unit test nữa'"
→ Agent tiếp tục với context mới

Hoặc không có message đã queue:
→ "⚡ Dừng sau 5 iter. Bổ sung context? (Enter để bỏ qua)"
→ User gõ context → agent tiếp tục
→ User nhấn Enter → kết thúc
```

---

## 6. Advanced Usage

### Plan Mode

```bash
# One-shot với plan
orcai --plan "migrate auth từ session sang JWT"

# Interactive plan command
/plan migrate auth từ session sang JWT
```

Plan mode flow:
1. Agent phân tích request với role='planner' (read-only, không sửa gì)
2. Hiện plan markdown cho user review
3. User chọn: **Approve** / **Modify** (nhập text điều chỉnh) / **Reject**
4. Nếu approve → chạy agent builder với plan đã approve

### Worktree Mode

```bash
# Chạy trong isolated git worktree
orcai --worktree -i -p /path/to/project
```

- Tạo git worktree tạm thời trên branch riêng
- Agent làm việc trong đó — repo chính không bị ảnh hưởng
- Khi exit: nếu có changes → hiện đường dẫn để review + merge
- Nếu không có changes → auto-cleanup

### Extended Thinking (Claude Only)

```bash
# Force thinking
orcai --thinking "analyze security vulnerabilities trong auth module"

# Thinking với budget lớn hơn
orcai --thinking --thinking-budget 16000 "design distributed caching strategy"

# Auto-thinking (default on) — detect từ keywords trong prompt
# Keywords: "analyze", "design", "why", "explain", "compare", "evaluate"
orcai "analyze tại sao performance degraded sau khi deploy"
```

### Via Orchestrator (Full Pipeline)

```bash
# Delegate sang Orchestrator
orcai --via-orchestrator "implement complete user registration flow"

# Hoặc trong interactive mode
/delegate implement complete user registration flow
```

Pipeline thực hiện: Scanner → Planner → TechLead → Parallel Dev Agents → Synthesizer

### Replay Transcript

```bash
# Replay session gần nhất
orcai --replay latest

# Replay session cụ thể
orcai --replay ses_abc123xyz

# Chỉ xem tool calls
orcai --replay latest --replay-filter tool_call

# Chậm lại để đọc
orcai --replay latest --replay-speed 500  # 500ms per event

# Verbose (full args)
orcai --replay latest --replay-verbose
```

---

## 7. Configuration

### `.orcai/settings.json` (Project-level)

```json
{
  "model": "cheap",
  "budget_usd": 2.0,
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "write_file|edit_file",
        "command": "bash scripts/pre-write.sh"
      }
    ],
    "PostToolUse": [
      {
        "matcher": "execute_command",
        "command": "bash scripts/log-command.sh"
      }
    ],
    "Stop": [
      {
        "command": "bash scripts/notify.sh"
      }
    ]
  }
}
```

### `~/.claude/settings.json` (Global)

Giống format trên. Load trước project settings (additive, không override).

### `.orcai/mcp.json` (MCP Config)

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/path/to/mcp-server.js"],
      "transport": "stdio"
    },
    "remote-server": {
      "url": "http://localhost:3000/mcp",
      "transport": "sse"
    }
  }
}
```

### Environment Variables

| Variable | Default | Mô tả |
|----------|---------|-------|
| `LITELLM_URL` | `http://localhost:5002` | LiteLLM gateway |
| `LITELLM_KEY` | `sk-master-change-me` | LiteLLM API key |
| `LMSTUDIO_URL` | `http://localhost:1234` | LM Studio endpoint |
| `GATEWAY_TOKEN` | | Portal auth token |
| `ORCAI_BENCHMARK` | `0` | Set `1` để skip cost prompts |
| `ORCAI_RAG_DISABLE` | `0` | Set `1` để tắt RAG |
| `ORCAI_THINKING` | `0` | Set `1` để bật thinking |
| `ORCAI_MAX_OUTPUT_TOKENS` | `4096` | Max output tokens |
| `ORCAI_DEBUG` | | Set để xem debug logs |
| `HERMES_CROSS_PROJECT` | `0` | Set `1` cho cross-project memory |
| `DECISION_LOCK_TTL_HOURS` | `4` | Decision lock TTL |
| `BUDGET_TZ` | `Asia/Ho_Chi_Minh` | Budget reset timezone |
| `OPENROUTER_API_KEY` | | OpenRouter key |
| `GOOGLE_API_KEY` | | Google AI key |
| `ANTHROPIC_API_KEY` | | Anthropic key (direct, nếu không dùng OpenRouter) |

---

## 8. Tips & Best Practices

### Cost optimization

```bash
# Dùng --direct cho task nhỏ (skip repo scan ~0.5K tokens)
orcai --direct "thêm validation cho email field"

# Dùng @mention thay vì để agent read_file (tiết kiệm iteration)
orcai "review" @src/auth.ts

# Set budget cap để không bị surprise
orcai -i --budget 1.00

# Dùng cheap model explicit nếu task đơn giản
orcai -m cheap "rename variable x → userId"
```

### Workflow tips

```bash
# Check health trước khi bắt đầu
orcai --doctor

# Dùng plan mode cho task phức tạp
orcai --plan "redesign checkout flow"

# Dùng worktree cho changes lớn
orcai --worktree --plan "migrate database schema"

# Resume nếu session bị interrupt
orcai --resume
```

### Memory & Learning

```bash
# Search memory để xem kinh nghiệm cũ
/memory search auth bug

# Xem gotchas gần đây
/memory list
# (type: gotcha = tự động lưu khi lỗi lặp)

# Agent tự save lesson khi task success
# User không cần làm gì
```

### Debugging

```bash
# Xem routing decision
/route

# Xem token usage
/tokens

# Xem healer stats nếu agent hay bị stuck
/heal

# Replay để hiểu agent làm gì
orcai --replay latest --replay-filter tool_call --replay-verbose
```
