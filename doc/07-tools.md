# Tool Reference

OrcAI cung cấp **61 tools** cho agent sử dụng. Agent tự chọn tool phù hợp dựa trên task.

---

## 1. Core Tools (26)

### File Operations

| Tool | Args | Mô tả |
|------|------|-------|
| `read_file` | `path, offset?, limit?` | Đọc file. offset/limit = dòng (pagination cho file lớn) |
| `write_file` | `path, content` | Ghi file (create hoặc overwrite). Trigger diff approval nếu interactive |
| `edit_file` | `path, old_string, new_string, replace_all?` | Search & replace trong file. An toàn hơn write_file |
| `list_files` | `path?, recursive?` | List files trong directory |
| `search_files` | `pattern, path?, type?` | Ripgrep search content trong files |
| `glob` | `pattern, path?` | Glob file paths (fast-glob) |
| `batch_edit` / `edit_files` | `[{ path, edits[] }]` | Multi-file edit trong 1 call |

**Best practices**:
- Dùng `edit_file` thay `write_file` khi chỉ sửa 1 phần — tiết kiệm token
- `search_files` với pattern cụ thể trước khi `read_file` — tránh đọc file không cần
- `glob` để tìm files theo pattern, không cần `list_files` recursive

### Command Execution

| Tool | Args | Mô tả |
|------|------|-------|
| `execute_command` | `command, cwd?, timeout?` | Chạy shell command. Nguy hiểm → confirm trước khi chạy `rm`, `DROP`, v.v. |

**Timeout**: default 30s, có thể tăng cho build/test dài.  
**cwd**: relative to projectDir nếu không set.

### Web

| Tool | Args | Mô tả |
|------|------|-------|
| `web_fetch` | `url, headers?` | Fetch URL, trả text content |
| `web_search` | `query, max_results?` | Web search (Brave API) |

### Multi-Agent

| Tool | Args | Mô tả |
|------|------|-------|
| `spawn_subagent` | `description, task, role?, model?` | Spawn sub-agent độc lập. Best for: task song song, task cần isolated context |
| `spawn_team` | `[{ description, task, role? }]` | Spawn nhiều sub-agents song song (max 5). Best for: parallel independent tasks |
| `task_decompose` | `task, strategy?` | Decompose task thành subtasks (JSON output, không execute) |

**Khi nào dùng spawn_subagent vs spawn_team**:
- `spawn_subagent`: 1 task độc lập, cần context sạch
- `spawn_team`: 2-5 tasks có thể chạy song song hoàn toàn

### Memory

| Tool | Args | Mô tả |
|------|------|-------|
| `memory_save` | `type, summary, tags?` | Lưu memory entry (lesson/gotcha/fact/manual) |
| `memory_recall` | `query, topK?` | TF-IDF search memory, trả relevant entries |

**Best practice**: Gọi `memory_recall(query)` ở đầu mỗi task để check kinh nghiệm cũ.

### User Interaction

| Tool | Args | Mô tả |
|------|------|-------|
| `ask_user_question` | `question, options?` | Hỏi user trong interactive mode. Mute InputQueue tránh conflict |

### Task Management

| Tool | Args | Mô tả |
|------|------|-------|
| `todo_write` | `todos[]` | Ghi/update agent todo list (user thấy real-time) |
| `todo_read` | | Đọc todo list hiện tại |
| `task_complete` | `summary, files_changed?` | Báo hoàn thành task. Kết thúc agent loop |

**Best practice**: Dùng `todo_write` cho task > 3 steps để track progress.

### Skills

| Tool | Args | Mô tả |
|------|------|-------|
| `create_skill` | `name, description, content` | Tạo custom skill (markdown template) |

### Background Processes

| Tool | Args | Mô tả |
|------|------|-------|
| `bg_bash` | `command, name?` | Chạy command background (không block) |
| `bg_list` | | List background processes + status |
| `bg_output` | `pid` | Đọc stdout của background process |
| `bg_kill` | `pid` | Kill background process |

---

## 2. AST Tools (4)

Yêu cầu: `@babel/parser`, `@babel/traverse`, `@babel/generator`

| Tool | Args | Mô tả |
|------|------|-------|
| `ast_parse` | `path, language?` | Parse file thành AST, trả structure summary |
| `ast_find_symbol` | `path, name, type?` | Tìm function/class/variable theo tên |
| `ast_find_usages` | `path, name` | Tìm tất cả usages của 1 symbol |
| `ast_rename_symbol` | `path, oldName, newName` | Rename symbol an toàn (AST-aware) |

**Khi nào dùng**: Refactor rename, tìm usages cross-file, parse structure mà không đọc toàn bộ file.

---

## 3. Embedding Tools (4)

| Tool | Args | Mô tả |
|------|------|-------|
| `embed_index` | `paths[]` | Index files vào embedding store |
| `embed_search` | `query, topK?` | Semantic search trong indexed files |
| `embed_stats` | | Embedding store stats (indexed files, vectors) |
| `embed_clear` | | Xóa embedding index |

**Dùng khi**: Codebase lớn, cần tìm code theo semantic meaning thay vì keyword exact.

---

## 4. Git Advanced (1 tool, 8 actions)

| Action | Args | Mô tả |
|--------|------|-------|
| `git_advanced status` | | Git status + staged/unstaged changes |
| `git_advanced diff` | `file?, staged?` | Xem diff |
| `git_advanced log` | `limit?, since?` | Commit log |
| `git_advanced branch` | `name?, action?` | List/create/delete branch |
| `git_advanced checkout` | `branch` | Checkout branch |
| `git_advanced commit` | `message, files?` | Commit changes |
| `git_advanced stash` | `action?` | Stash/pop/list |
| `git_advanced cherry-pick` | `commit` | Cherry-pick commit |

Usage: `execute({ function: { name: 'git_advanced', arguments: '{"action":"status"}' } })`

---

## 5. Screenshot Tools (3)

Windows + macOS only.

| Tool | Args | Mô tả |
|------|------|-------|
| `capture_screen` | `monitor?` | Chụp toàn bộ màn hình |
| `capture_window` | `title?` | Chụp cửa sổ cụ thể |
| `list_monitors` | | Danh sách monitors |

---

## 6. Research Tools (4)

| Tool | Args | Mô tả |
|------|------|-------|
| `github_code` | `query, repo?` | Search code trên GitHub |
| `github_issue` | `repo, query` | Search GitHub issues |
| `npm_info` | `package` | NPM package info + versions |
| `deep_research` | `query, depth?` | Multi-step web research |

---

## 7. Windows Native Tools (22)

Chỉ available trên Windows. Lazy-load — không crash trên macOS.

### System

| Tool | Mô tả |
|------|-------|
| `ps_command` | PowerShell command execution |
| `everything_search` | Everything (ultra-fast file search) |
| `clipboard_read` / `clipboard_write` | Clipboard access |
| `event_log_query` | Windows Event Log query |
| `wmi_query` | WMI query |
| `wsl_exec` | Execute trong WSL |
| `winget_search` | Winget package search |
| `sys_info` | System info (CPU, RAM, disk) |

### Registry (4)

| Tool | Args | Mô tả |
|------|------|-------|
| `get_registry` | `key, name?` | Đọc registry value |
| `set_registry` | `key, name, value, type?` | Ghi registry value |
| `create_registry_key` | `key` | Tạo registry key |
| `delete_registry_value` | `key, name` | Xóa registry value |

### Scheduled Tasks (6)

| Tool | Mô tả |
|------|-------|
| `list_scheduled_tasks` | Danh sách scheduled tasks |
| `create_scheduled_task` | Tạo scheduled task |
| `enable_task` / `disable_task` | Enable/disable task |
| `delete_task` | Xóa task |
| `get_task_info` | Task details + last run status |

### Services (6)

| Tool | Mô tả |
|------|-------|
| `list_services` | Danh sách Windows services |
| `get_service` | Service details + status |
| `start_service` / `stop_service` / `restart_service` | Control service |
| `set_service_start` | Thay đổi startup type |

---

## 8. MCP Tools

OrcAI tự động inherit MCP servers từ `~/.claude.json` và `~/.claude/settings.json` (Claude Code config). Có thể thêm servers qua `.orcai/mcp.json`.

**Supported MCP servers** (nếu đã cài):

| Server | Transport | Tools |
|--------|-----------|-------|
| `playwright` | stdio | browser_navigate, browser_click, browser_fill, ... |
| `context7` | stdio | query-docs, resolve-library-id |
| `github` | stdio | create_issue, get_pr, search_code, ... |
| `linear` | stdio | create_issue, update_issue, ... |
| `notion` | stdio | API-post-page, API-query-database, ... |
| `filesystem` | stdio | read_file, write_file, create_directory, ... |
| `memory` | stdio | create_entities, search_nodes, ... |
| `brave-search` | stdio | brave_web_search, brave_local_search |
| `docker` | stdio | list_containers, exec_command, ... |
| `mysql` | stdio | mysql_query |

**Tool naming convention**: `mcp__<server>__<tool>`  
Ví dụ: `mcp__playwright__browser_navigate`, `mcp__github__create_issue`

**Khi nào dùng MCP tools**: Tasks liên quan external services (GitHub PRs, database, browser automation, cloud resources). Agent tự chọn khi thấy relevant trong prompt.

---

## 9. Tool Permissions

```
Role-based permissions (tools/permissions.js):

builder:   read + write + execute (full access trong projectDir)
fe-dev:    read + write (*.tsx, *.vue, *.css, *.html, *.sass, *.less)
be-dev:    read + write (*.ts, *.js, *.py, *.go, *.rs, *.sql, *.java)
reviewer:  read only (không write, không execute)
planner:   read only
debugger:  read + execute (không write)

readableRoots: project dir + additional readable paths
              (ngăn đọc file ngoài project mà không có permission)
```

---

## 10. Tool Result Cache

Read-safe tools được cache per-run (Map LRU, max 50 entries):

```
Cacheable: read_file, list_files, search_files, glob, ast_parse, ast_find_symbol, ast_find_usages
Not cached: write_file, edit_file, execute_command, spawn_*, memory_*, ask_user_question

Cache key: "toolName:argsJSON"
TTL: per-run (clear khi bắt đầu agent.run())
Size: max 50 entries, LRU eviction

Khi cache hit:
  result.content = "[cached from iteration N — content unchanged]\n" + original
  Agent biết đây là cached result — không re-execute
  Vẫn track trong StuckDetector
```

Xem stats: `agent.getToolCacheStats()` → `{ hits, misses, tokensSaved, size }`

---

## 11. Parallel Tool Execution

Read-safe tools trong cùng 1 batch (cùng 1 LLM response) sẽ chạy song song:

```js
isBatchReadSafe(toolCalls):
  Tất cả tools đều là read-safe → Promise.all()
  Có ít nhất 1 write/execute → for loop (serial)

Read-safe: read_file, list_files, search_files, glob, ast_*, embed_search
Not safe: write_file, edit_file, execute_command, spawn_*, web_fetch
```

Ví dụ: Agent gọi 5 `read_file` cùng lúc → chạy parallel → ~3x nhanh hơn serial.
