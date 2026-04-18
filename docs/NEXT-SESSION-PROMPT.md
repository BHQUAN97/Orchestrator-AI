# PROMPT cho Session Mới — Comprehensive Test + Benchmark + Auto-fix

> Copy toàn bộ block bên dưới vào session mới ở `E:\DEVELOP\ai-orchestrator`.

---

Tôi đang làm việc ở `E:\DEVELOP\ai-orchestrator`. Đọc `docs/NEXT-SESSION.md` + `benchmark/results/2026-04-18-MODEL-RECOMMENDATIONS.md` + `benchmark/FREE-MODELS-PLAN.md` trước khi bắt đầu. Sau đó thực hiện **song song 3 mục tiêu** qua `Agent` tool.

## Bối cảnh (2026-04-18 đã làm)

**Commits gần nhất**:
- `94a3cbb` — thêm 5 free model variants + recommendations
- `8ea9d0a` — fix 6 bug harness + P/P scorer
- `eb98e1a` — handoff doc
- `ff419c6` — session complete 14/14

**6 bug đã fix**:
1. `bin/orcai.js` budget prompt bypass `--no-confirm`
2. `tools/file-manager.js` `searchFiles` handle file-path (ENOTDIR)
3. `benchmark/tasks.json` T01 deterministic `ASYNC_COUNT=<N>` format
4. `benchmark/runner.js` parseMetrics regex match format thực tế
5. `litellm_config.yaml` tách `fast` (Gemini direct) / `fast-or` (OpenRouter)
6. 5 `free-*` model thêm vào config

**P/P winner** (5 A-tier × 6 model):
- 🥇 `cheap` (GPT-5.4-mini): 100% / $0.009 / P/P 112
- 🥈 `fast-or` (Gemini via OR): 100% / $0.045 / P/P 22
- 🥉 `free-glm` (GLM 4.5 Air): 60% / ~$0.06 / P/P 10
- `smart` (Sonnet 4.6): 60% / $0.12
- `default` (DeepSeek V3.2): 40% / $0.07
- `free-minimax` (MiniMax M2.5): 40% / free (timeout nhiều)

**Chưa benchmark**: 22 free model còn lại (qwen3-coder, qwen3-next-80b, hermes-3-405b, nemotron-3-super-120b, gemma-4-31b, llama-3.3-70b, etc.)

**Bug còn lại** (Priority #1 handoff): token inefficiency — agent đọc full file thay vì grep (default model dùng 54K input tokens cho task count).

## Phân công song song — Spawn 3 Agent ngay turn đầu

**BẮT BUỘC**: ở tin nhắn đầu tiên, dùng `TaskCreate` tổng + spawn **3 `Agent` tool call song song** trong cùng 1 message.

### Agent A — Benchmark free models (Tier S + Tier A)

**Goal**: Test 10 free models chưa benchmark, tìm ra 3-5 model usable (≥60% pass, ≤30s wall).

**Setup**:
```bash
source .env
export LITELLM_URL=http://localhost:5002
export LITELLM_KEY=$LITELLM_MASTER_KEY
```

**Phase 1 — Ping (5 phút)**:
- Thêm 8 model mới vào `litellm_config.yaml` (prefix `free-`):
  - `qwen/qwen3-coder:free` → `free-qwen-coder`
  - `qwen/qwen3-next-80b-a3b-instruct:free` → `free-qwen-next`
  - `nousresearch/hermes-3-llama-3.1-405b:free` → `free-hermes`
  - `nvidia/nemotron-3-super-120b-a12b:free` → `free-nemotron-super`
  - `nvidia/nemotron-3-nano-30b-a3b:free` → `free-nemotron-nano`
  - `google/gemma-4-31b-it:free` → `free-gemma4-31b`
  - `google/gemma-4-26b-a4b-it:free` → `free-gemma4-26b`
  - `meta-llama/llama-3.3-70b-instruct:free` → `free-llama70b`
- `docker restart orcai-litellm` + chờ ready
- Ping mỗi model với "Reply PING", max_tokens 50 → filter endpoint sống

**Phase 2 — Speed test T04 (10 phút)**:
- Chỉ run T04 (Find typo README — task nhẹ nhất) trên các model pass Phase 1
- `node benchmark/runner.js --task T04 --model <filtered,list>`
- Loại model timeout / fail format

**Phase 3 — Full 5 A-tier (30 phút)**:
- Run `--tier A --model <top-5-stable>`
- Ghi kết quả: `benchmark/results/<date>-free-expanded.jsonl`
- Generate report: `node benchmark/scorer.js <file>`

**Output**:
- File: `benchmark/results/<date>-free-expanded-report.md` với P/P table
- Update `benchmark/results/2026-04-18-MODEL-RECOMMENDATIONS.md` thêm section free model
- Commit: `bench: test 8 more free OpenRouter models`

**Budget**: ≤$1 (free tier có thể bill nhỏ khi fallback).

### Agent B — Fuzz test 61 tools (tìm bug)

**Goal**: Scan `tools/definitions.js` (61 tools), với mỗi tool test 3 edge case. Output: danh sách bug phát hiện.

**Setup**:
- Tạo `test/fuzz-tools.test.js`
- Đọc `tools/definitions.js` để lấy danh sách tool + schema
- Với mỗi tool, test 3 case:
  1. **Valid input**: tham số đúng kiểu, giá trị hợp lý
  2. **Edge case**: empty string, unicode (日本語, 🎉), 10K char, Windows path với space/dấu, symlink (nếu có)
  3. **Invalid**: `null`, `undefined`, wrong type, path traversal `../../../etc/passwd`
- Expectation: tool trả `{ success: false, error: '...' }` cho invalid, **KHÔNG crash process**
- Dùng `try/catch` wrap mỗi call, ghi kết quả `{ tool, case, status: 'OK'|'CRASH'|'WRONG_SHAPE', detail }`

**Output**:
- `test/fuzz-tools.test.js` — test suite mới
- `docs/FUZZ-RESULTS-2026-04-XX.md` — danh sách bug (tool nào crash, tool nào không handle gracefully)
- **Không tự fix** — chỉ liệt kê để Claude Code fix sau

**Budget**: $0 (không gọi LLM, chạy tool trực tiếp).

### Agent C — Audit code (security + quality)

**Goal**: Read-only scan codebase để tìm bug/vulnerability chưa biết.

**Scope**: `lib/**/*.js`, `tools/**/*.js`, `bin/**/*.js`, `src/**/*.js`.

**Checklist**:
1. Hard-coded secrets / API keys (grep `sk-`, `pk_`, `AKIA`, token-like strings)
2. Command injection — `execSync`, `spawn` với user input không sanitize
3. Path traversal — path join với input không validate
4. Unhandled promise rejection — async function thiếu `.catch()` hoặc `try/catch`
5. Race condition — file read/write không await, shared state không lock
6. Memory leak — `setInterval` không `clear`, `on()` không `off()` cleanup
7. SQL injection (nếu có query raw)
8. Regex DoS (regex phức tạp user-controllable)

**Output**:
- `docs/AUDIT-2026-04-XX.md`
- Format mỗi finding:
  ```
  ## [CRITICAL|HIGH|MEDIUM|LOW] <title>
  - File: `path/to/file.js:L123`
  - Issue: mô tả
  - Suggested fix: code snippet hoặc hướng giải
  ```
- Không sửa code, chỉ liệt kê.

**Budget**: $0 (chỉ grep/read file).

## Sau khi 3 Agent xong — Claude Code chủ động fix bug

1. **Consolidate**: merge bug từ Agent B + C thành 1 checklist có priority
2. **Fix loop** (lặp cho đến hết Critical + High):
   - Đọc file:line của bug
   - Implement fix theo suggestion
   - Viết regression test (nếu chưa có) trong `test/`
   - Chạy `npm run test:all` → phải 533+ pass, no regression
   - Commit: `fix(<scope>): <desc>` — 1 commit/1 bug
3. **Re-benchmark** sau khi fix:
   - `node benchmark/runner.js --tier A --model cheap,fast-or` → so pass rate before/after
   - Nếu tăng → ghi vào `IMPROVEMENT-LOG.md`
4. **Update docs**:
   - `docs/IMPROVEMENT-LOG.md` thêm section "2026-04-XX Phiên fuzz + audit"
   - `benchmark/results/2026-04-XX-MODEL-RECOMMENDATIONS.md` cập nhật nếu đổi tier
5. **End-of-session auto-update** (theo global CLAUDE.md):
   - Update `E:\DEVELOP\.claude-shared\context-cache\ai-orchestrator.context.md`
   - Update `E:\DEVELOP\.claude-shared\git-nexus.md`
   - Commit `.claude-shared`: `sync: <date>`
6. **Push**: `git push origin main`

## Ràng buộc tổng thể

- **Budget hard cap $5** toàn phiên (LiteLLM đã set max_budget $2/ngày)
- **Model default**: `cheap` (GPT-5.4-mini) cho subagent — P/P cao nhất
- `smart` (Sonnet 4.6) **chỉ dùng cho Agent C audit** (cần reasoning)
- `free-glm` cho dry-run / preview nếu cần
- **KHÔNG** chạm production/deployment files
- **KHÔNG** skip pre-commit hook (`--no-verify`)
- **Mỗi fix phải có test** chứng minh — regression hoặc new test
- Nếu 1 task block > 15 phút → skip + ghi `docs/NEXT-SESSION.md` cho lần sau
- Báo cáo ngắn gọn (mobile-friendly theo global CLAUDE.md)

## Tiêu chí "xong"

✅ 3 Agent complete + report files
✅ Bug Critical + High fix hết + test pass
✅ Re-benchmark cho số liệu before/after
✅ Free model expand — biết thêm ≥3 model usable (hoặc confirm tất cả không dùng được)
✅ Commit + push lên `origin/main`
✅ `.claude-shared` sync + push
✅ `docs/IMPROVEMENT-LOG.md` update
✅ `docs/NEXT-SESSION.md` ghi việc còn lại (nếu có)

## Output cuối phiên (gửi user)

1 bản tóm tắt ngắn (≤15 dòng):
- N Agent xong, N bug fix, N commit
- Pass rate delta: before X% → after Y%
- Free model added: danh sách + P/P score
- Cost tổng + thời gian tổng
- Việc còn lại (nếu có) — link `docs/NEXT-SESSION.md`

---

**Bắt đầu**: `TaskCreate` tổng → spawn 3 Agent parallel trong tin nhắn đầu tiên.
