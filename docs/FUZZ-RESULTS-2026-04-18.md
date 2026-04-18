# Fuzz Test Results — 2026-04-18

**Agent:** Agent B (fuzz-tools)
**Test file:** `test/fuzz-tools.test.js`
**Chạy:** `node --test test/fuzz-tools.test.js`

---

## Tổng quan

| Metric | Value |
|--------|-------|
| Tools tested | 29 |
| Test cases | 90 |
| Pass | 82 |
| **Fail (= bug)** | **8** |
| Duration | ~3.8s |

---

## Phân loại bug

| Loại | Count | Mô tả |
|------|-------|--------|
| CRASH (throw unhandled) | 5 | Tool throw exception thay vì return `{success: false}` |
| WRONG_SHAPE | 1 | Tool return sai field name (contract mismatch) |
| TEST_BUG | 2 | Lỗi test expectation (không phải bug tool thật) |

---

## Bugs theo priority

### CRITICAL — CRASH (throw unhandled exception)

#### Bug #1 — `write_file` crash khi path rỗng (`""`)
- **File:** `tools/file-manager.js` — `writeFile()` method
- **Severity:** CRITICAL
- **Reproduce:** `fm.writeFile({ path: '', content: 'test' })`
- **Error:** `EISDIR: illegal operation on a directory, open 'E:\DEVELOP\ai-orchestrator'`
- **Root cause:** `_validateWritePath('')` resolve `''` thành `process.cwd()` (project root), pass validation vì nằm trong project. Sau đó `fs.writeFileSync(projectDir, content)` throw EISDIR vì đang ghi vào directory.
- **Fix:** Trong `_validateWritePath`, thêm guard: `if (!filePath) return { blocked, reason: 'path is empty' }` hoặc throw trước khi resolve.

#### Bug #2 — `write_file` crash khi content là null
- **File:** `tools/file-manager.js` — `writeFile()` method, line ~196
- **Severity:** CRITICAL
- **Reproduce:** `fm.writeFile({ path: '.orcai/test.txt', content: null })`
- **Error:** `TypeError: The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received null`
- **Root cause:** `fs.writeFileSync(resolved, content, 'utf-8')` không kiểm tra `content !== null`. LLM có thể gửi `null` nếu hallucinate.
- **Fix:** Thêm validation: `if (content == null) return { success: false, error: 'content must be a string' }` trước khi gọi `fs.writeFileSync`.

#### Bug #3 — `edit_file` crash khi `old_string` là null
- **File:** `tools/file-manager.js` — `editFile()` method, line ~231
- **Severity:** CRITICAL
- **Reproduce:** `fm.editFile({ path: 'package.json', old_string: null, new_string: 'y' })`
- **Error:** `TypeError: Cannot read properties of null (reading 'trim')`
- **Root cause:** Code chạy `old_string.trim()` trong gợi ý error message mà không kiểm tra null trước. Xảy ra ở dòng: `` const trimmedMatch = content.split('\n').find(line => line.trim() === old_string.trim()) ``
- **Fix:** Thêm guard: `if (old_string == null) return { success: false, error: 'old_string must be a string' }` đầu hàm `editFile`.

#### Bug #4 — `search_files` crash khi pattern là invalid regex
- **File:** `tools/file-manager.js` — `searchFiles()` method, line ~346
- **Severity:** CRITICAL
- **Reproduce:** `fm.searchFiles({ pattern: '[invalid-regex((' })`
- **Error:** `SyntaxError: Invalid regular expression: /[invalid-regex-zxq((/gi: Unterminated character class`
- **Root cause:** `new RegExp(pattern, 'gi')` được gọi không trong try/catch block. LLM có thể gửi regex sai cú pháp.
- **Fix:** Wrap `new RegExp(pattern, 'gi')` trong try/catch, return `{ success: false, error: \`Invalid regex: ${e.message}\` }` khi fail.

#### Bug #5 — `edit_files` (batchEdit) crash khi args là null
- **File:** `tools/batch-edit.js` — `batchEdit()` function, line ~21
- **Severity:** CRITICAL
- **Reproduce:** `batchEdit(null, fm)`
- **Error:** `TypeError: Cannot destructure property 'edits' of 'args' as it is null.`
- **Root cause:** `const { edits } = args` destructure ngay đầu hàm mà không kiểm tra `args != null`.
- **Fix:** Thêm guard: `if (!args) return { success: false, error: 'args required' }` trước destructure.

---

### HIGH — WRONG_SHAPE (contract mismatch)

#### Bug #6 — `bg_list` trả về `procs` thay vì `processes`
- **File:** `tools/background-bash.js` — `bgList()` function, line ~143
- **Severity:** HIGH
- **Reproduce:** `bgList()` → `{ success: true, total: 0, procs: [] }`
- **Issue:** Định nghĩa tool trong `definitions.js` và test expectation mong đợi field `processes`, nhưng implementation trả về `procs`. Gây nhầm lẫn cho LLM khi parse kết quả.
- **Note:** Không gây crash nhưng là contract inconsistency — cần quyết định tên field nhất quán.
- **Fix:** Đổi `bgList()` trả về `processes` thay vì `procs`, hoặc update schema/test cho nhất quán.

---

### MEDIUM — Test bugs (không phải bug tool)

#### Non-bug #7 — Test `embed_stats` gọi sai signature
- **Test case:** `fuzz embed_stats — fresh store (no index)`
- **Status:** Test viết sai, không phải bug tool
- **Root cause:** `embedStats({ embeddingStore: store })` — test truyền store trong args, nhưng signature thật là `embedStats(args, ctx)` với `ctx.embeddingStore`. Tool hoạt động đúng khi gọi đúng cách.
- **Action:** Fix test signature: `embedStats({}, { embeddingStore: store })` → sẽ pass

#### Non-bug #8 — Test `embed_clear` gọi sai signature + thiếu `confirm:true`
- **Test case:** `fuzz embed_clear — fresh store`
- **Status:** Test viết sai
- **Root cause:** Tương tự #7 — signature sai + `embedClear` yêu cầu `confirm:true` để clear. Tool đang hoạt động đúng (safety guard).
- **Action:** Fix test: `embedClear({ confirm: true }, { embeddingStore: store })` → sẽ pass

---

## Bugs theo tool

| Tool | Cases | Pass | Fail | Severity cao nhất |
|------|-------|------|------|-------------------|
| read_file | 8 | 8 | 0 | — |
| write_file | 5 | 3 | 2 | CRITICAL |
| edit_file | 5 | 4 | 1 | CRITICAL |
| list_files | 4 | 4 | 0 | — |
| search_files | 4 | 3 | 1 | CRITICAL |
| glob | 5 | 5 | 0 | — |
| execute_command | 7 | 7 | 0 | — |
| edit_files | 5 | 4 | 1 | CRITICAL |
| todo_write | 5 | 5 | 0 | — |
| todo_list | 1 | 1 | 0 | — |
| memory_save | 2 | 2 | 0 | — |
| memory_recall | 2 | 2 | 0 | — |
| memory_list | 1 | 1 | 0 | — |
| ast_parse | 4 | 4 | 0 | — |
| ast_find_symbol | 3 | 3 | 0 | — |
| ast_find_usages | 2 | 2 | 0 | — |
| ast_rename_symbol | 1 | 1 | 0 | — |
| git_advanced | 5 | 5 | 0 | — |
| embed_search | 2 | 2 | 0 | — |
| embed_stats | 1 | 0 | 1 | MEDIUM (test bug) |
| embed_clear | 1 | 0 | 1 | MEDIUM (test bug) |
| bg_list | 1 | 0 | 1 | HIGH |
| bg_output | 2 | 2 | 0 | — |
| bg_kill | 1 | 1 | 0 | — |
| web_fetch | 6 | 6 | 0 | — |
| web_search | 2 | 2 | 0 | — |
| ps_command | 1 | 1 | 0 | — (Windows) |
| clipboard_read | 1 | 1 | 0 | — (Windows) |
| sys_info | 1 | 1 | 0 | — (Windows) |
| registry_read | 2 | 2 | 0 | — (Windows) |

---

## Ghi chú thêm

### Tools được skip / không test
- `spawn_subagent`, `spawn_team` — cần LLM API (budget $0)
- `decompose_task` — cần Hermes bridge
- `create_skill` — side effect tạo file skill
- `ask_user_question` — cần interactive mode
- `task_complete` — wrapper đơn giản, low risk
- `read_mcp_resource` — cần MCP registry
- `embed_index` — cần real LLM endpoint để embed
- `deep_research`, `github_code_search`, `npm_info` — cần network calls
- `capture_screen`, `capture_window`, `list_monitors` — Windows screen tools (không ảnh hưởng logic)
- `everything_search`, `wmi_query`, `wsl_exec`, `winget_search`, `event_log`, `scheduled_tasks`, `services` — complex Windows-only

### Các điểm đáng chú ý (không phải bug nhưng design concern)
1. `execute_command` với `command: null` — không crash nhưng chạy được lệnh shell với `null` converted thành string "null". Nên validate trước.
2. `execute_command` với timeout âm — dùng default thay vì báo lỗi. Có thể gây confuse.
3. `edit_file` với `old_string: ''` (empty string) — không crash nhưng logic phức tạp (mọi string đều chứa empty string). Nên validate.

---

## Tổng kết thực tế

**5 bugs cần fix ngay (CRITICAL):**
1. `write_file(path='')` → EISDIR crash (file-manager.js)
2. `write_file(content=null)` → TypeError crash (file-manager.js)
3. `edit_file(old_string=null)` → TypeError crash (file-manager.js)
4. `search_files(pattern='[invalid')` → SyntaxError crash (file-manager.js)
5. `edit_files(null)` → TypeError crash (batch-edit.js)

**1 bug fix thấp ưu tiên (HIGH):**
6. `bg_list` trả về `procs` thay vì `processes` (background-bash.js)

**2 test fix (KHÔNG phải bug tool):**
7-8. `embed_stats`/`embed_clear` test gọi sai API signature
