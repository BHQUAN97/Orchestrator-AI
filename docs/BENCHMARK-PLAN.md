# Benchmark Plan — OrcAI vs Claude Code

> Plan chi tiet DE CHUAN BI — chua chay. Doc + duyet + tinh chinh truoc khi bam nut.
> Tac gia: review phien 2026-04-18. Chu nhan: BHQUAN97.

---

## 0. Mục tiêu (what success looks like)

**Đo 3 thứ** (theo thứ tự ưu tiên):

1. **Correctness** — task hoàn thành đúng không? (pass tiêu chí verify)
2. **Cost** — tốn bao nhiêu token & USD cho mỗi task?
3. **Speed** — từ prompt đến khi task_complete hết bao lâu?

**KHÔNG đo**:
- Code style / aesthetic (chủ quan)
- Edge cases siêu hiếm
- Performance của LLM vendor (ngoài tầm kiểm soát)

---

## 1. Hiện trạng đã có (không phải dựng mới)

### Test hiện tại (đã chạy pass 2026-04-18)
- `test/parity.test.js` — 109 test **API surface** (import + schema + signature). Không E2E.
- `test/problems-realistic.test.js` — (chưa đọc kỹ) có vẻ là E2E thực
- `test/coding-quality-bench.js` và `coding-quality-bench-rag.js` — benchmark coding quality (CÓ SẴN!)
- `test/hardening.test.js` — 65 test error handling
- Các test khác: audit-log, cost-tracker, trace-store, stack-profile, rag-prompt-builder...

### Feature CLI đã có
- `--plan` → plan mode (analyze → user duyệt → execute)
- `--worktree` → chạy trong isolated git worktree (an toàn)
- `--budget <usd>` → cap session cost, abort khi vượt
- `--resume [id]` → resume session cũ
- `--dry` (via API) → plan + estimate không execute
- `/api/vision`, `/api/vision-run` → analyze screenshot + fix code
- SSE live stream `/api/stream/<traceId>` → theo dõi pipeline real-time

### Tool surface
- **61 tool** (không phải 46 như README claim — cần update README)
- Core 26, AST 4, git_advanced (8 subaction), embed 4, research 4, screenshot 3, Windows 22

---

## 2. Scope benchmark

### In scope
- Coding task thực tế (fix bug, implement feature, refactor, debug, review)
- Multi-file operations
- Tool use đa dạng (read/edit/grep/bash/git)
- Plan mode flow
- Shadow-git rollback flow

### Out of scope (giai đoạn 1)
- MCP integration với external server (cần network)
- Vision tasks (cần hình ảnh chuẩn bị riêng)
- Long-running task (>30 iteration)
- Multi-agent orchestration (để phase 2)

---

## 3. Test suite đề xuất — 25 task

### A. Simple single-file (5 task — baseline dễ)
1. **Read-only grep** — Đếm số function async trong `lib/agent-loop.js`. Expected: numeric answer.
2. **Add JSDoc** — Thêm JSDoc cho function `runPlanFlow` trong `lib/plan-mode.js`. Verify: JSDoc valid, không break existing code.
3. **Rename variable** — Rename biến `passed` → `passCount` trong `test/parity.test.js`. Verify: test vẫn pass sau đổi tên.
4. **Fix typo** — Sửa typo "Diem manh" trong README.md (nếu có). Verify: file changed, diff nhỏ.
5. **Add unit test** — Viết 1 test mới cho `formatBytes` util (nếu có). Verify: test pass.

### B. Multi-file refactor (5 task — vừa)
6. **Extract helper** — Tách logic đếm token trùng lặp thành `lib/token-utils.js`. Verify: test cũ pass.
7. **Add flag** — Thêm `--dry` flag vào `bin/orcai.js`, print plan không execute. Verify: `orcai "test" --dry` không modify file.
8. **Update schema** — Thêm field `description` optional vào tool `memory_save`. Verify: parity.test.js pass.
9. **Migrate deprecated** — Replace `fs.existsSync` → `fs.access` async (3-5 chỗ). Verify: test pass.
10. **Standardize error** — Thống nhất error class trong `tools/executor.js`. Verify: hardening.test.js pass.

### C. Debug/investigation (5 task — khó)
11. **Find leak** — Giải thích `this.history` trong `agent-bus.js` có grow unbounded không? Trả lời yes/no + evidence.
12. **Trace flow** — Khi user gõ `orcai "fix bug" --plan`, trace qua 5 file đầu tiên bị invoke (theo thứ tự). Output: ordered list.
13. **Identify duplicate** — Tìm 2 function trong repo có logic >80% giống nhau. Output: file:line của 2 function.
14. **Find dead code** — List function exported nhưng không được require ở đâu. Output: path + export name.
15. **Security audit** — Check `tools/executor.js` có path traversal không? Output: yes/no + fix suggestion nếu có.

### D. Feature implementation (5 task — nặng)
16. **New tool** — Thêm tool `get_env` đọc biến môi trường (whitelist). Update definitions + executor + test.
17. **New CLI flag** — Thêm `--verbose` log mọi tool call. Update bin/orcai.js + test.
18. **Fix existing bug** — (cần chọn 1 bug thật từ issue tracker — chưa có, skip nếu không có)
19. **Refactor module** — Tách `lib/agent-loop.js` phần retry ra `lib/retry-agent.js`. Verify: parity test pass.
20. **Config migration** — Đổi `.orcai/config.json` schema v1 → v2 với migration script.

### E. End-to-end workflow (5 task — integration)
21. **Full spec-build-check** — Viết spec ngắn → plan → build → tự verify. Tool: spawn_team.
22. **Plan mode flow** — Chạy với `--plan`, verify user prompt hiện ra, approve → execute.
23. **Rollback flow** — Sửa sai cố ý → shadow-git snapshot → rollback → file khôi phục.
24. **Budget cap** — Set `--budget 0.05`, run task lớn, verify abort khi vượt ngưỡng.
25. **Resume session** — Chạy task, kill giữa chừng, `--resume` → tiếp tục đúng điểm dừng.

---

## 4. Measurement framework

### Per-task metrics
| Metric | Cách đo | Đơn vị |
|---|---|---|
| `correct` | Assertion pass/fail | boolean |
| `iterations` | Số vòng lặp tool call | int |
| `tokens_in` | Prompt tokens | int |
| `tokens_out` | Completion tokens | int |
| `cost_usd` | `tokens * price/1M` | float |
| `wall_time_ms` | Từ send đầu → task_complete | int |
| `tool_calls` | Mỗi tool gọi bao nhiêu lần | object |

### Per-model run
Chạy 5 model: `smart` (Sonnet), `default` (Kimi), `cheap` (DeepSeek), `fast` (Gemini), `control` (Claude Code thực, human-run).

→ Matrix 25 task × 5 model = 125 run. Thực tế: `control` chạy tay hoặc skip.

### Output format
JSON-lines trong `benchmark/results/YYYY-MM-DD-<run-id>.jsonl`:
```json
{"task":"T01","model":"default","correct":true,"iterations":4,"tokens_in":1200,"tokens_out":450,"cost_usd":0.0015,"wall_ms":8200,"tool_calls":{"read_file":2,"execute_command":1}}
```

---

## 5. Pass criteria

### Overall
- **≥ 80% task correct** với `smart` (Sonnet) → PASS
- **≥ 60% task correct** với `default` (Kimi) → PASS cho production use
- **< 50% task correct** với `cheap` (DeepSeek) → DOWNGRADE route

### Per task
- A-tier (1-5): phải ≥ 90% correct với bất kỳ model nào
- B-tier (6-10): ≥ 70% với smart, ≥ 50% với default
- C-tier (11-15): ≥ 60% với smart, KHÔNG bắt buộc với default
- D-tier (16-20): ≥ 50% với smart (hard tasks)
- E-tier (21-25): integration test, PASS/FAIL theo assertion

---

## 6. Chuẩn bị trước khi chạy (PRE-FLIGHT CHECKLIST)

### Môi trường
- [ ] `.env` có ít nhất 1 API key hoạt động (OpenRouter khuyên dùng)
- [ ] LiteLLM proxy chạy tại `http://localhost:5002` — verify `curl /health`
- [ ] Budget daily đặt ≥ $5 (default $2 có thể không đủ 1 run)
- [ ] Docker compose up 6 service, verify port 5000-5005 listen
- [ ] Free disk space ≥ 1GB (trace log có thể lớn)

### Code
- [ ] Commit toàn bộ 22 modified + 35 untracked TRƯỚC khi benchmark (không dirty state)
- [ ] Tag baseline: `git tag benchmark-baseline-2026-04-18`
- [ ] Checkout fresh branch `benchmark/run-1`
- [ ] Tất cả test hiện tại PASS (400+ test)

### Test harness
- [ ] Tạo `benchmark/` directory
- [ ] Tạo `benchmark/tasks.json` — định nghĩa 25 task
- [ ] Tạo `benchmark/verify.js` — assertion cho từng task
- [ ] Tạo `benchmark/runner.js` — chạy tuần tự, log JSONL
- [ ] Tạo `benchmark/fixtures/` — chứa sample code cho task (không dùng main codebase để tránh side effect)
- [ ] Tạo `benchmark/scorer.js` — aggregate metrics, sinh markdown report

### Isolation
- [ ] Mỗi task chạy trong **temp dir riêng** (copy fixture vào)
- [ ] **KHÔNG chạy trên main codebase** (risk ô nhiễm)
- [ ] Hoặc dùng `--worktree` để isolate

### Logging
- [ ] Enable full trace: `ORCAI_TRACE=1`
- [ ] Save raw stdout/stderr mỗi task
- [ ] Save LiteLLM response body (verify token count)

### Safety
- [ ] `--no-confirm` để không hỏi từng bước (cần budget cap)
- [ ] Max iterations per task = 20 (tránh infinite loop)
- [ ] Timeout per task = 180s (tránh treo)
- [ ] Kill switch: `Ctrl+C` stop toàn bộ runner, save partial results

---

## 7. Risk + Assumption

### Risk cao
1. **Cost blow-up** — 125 run × $0.02 avg = $2.50 (OK) nhưng với Sonnet có thể $15+
   → Mitigation: chạy `cheap` + `default` trước, Sonnet chỉ cho subset
2. **Non-determinism** — LLM output thay đổi mỗi lần
   → Mitigation: temperature=0, chạy 3 lần/task, lấy majority pass
3. **Tool failure cascade** — 1 tool break → task fail oan
   → Mitigation: phân loại failure reason (tool_error vs reasoning_error)
4. **Network flakiness** — LiteLLM timeout 
   → Mitigation: retry 3 lần, skip task nếu vẫn fail

### Assumption
- LiteLLM proxy hoạt động đúng routing (đã test qua router/test-router.js)
- Price table (`litellm_config.yaml`) khớp giá vendor thật (cần audit riêng)
- Model `kimi-k2.5` thực sự available (có thể Moonshot rename)

### Unknown
- Claude Code không có API để auto-chạy cùng task → "control" arm phải human-run
- Không rõ Claude Code token count có public → khó so cost 1-1

---

## 8. Timeline đề xuất

| Bước | Thời gian | Lý do |
|---|---|---|
| 1. Duyệt plan này với user | 10 phút | Tránh làm lại |
| 2. Commit backlog (Priority 1) | 1 giờ | Clean state |
| 3. Viết `benchmark/` scaffold (runner + scorer) | 2 giờ | Code tool harness |
| 4. Viết 5 task A-tier + verify | 1 giờ | Dễ, validate harness |
| 5. Dry run 5 task với `default` model | 30 phút | Bắt bug harness |
| 6. Viết 20 task còn lại | 3-4 giờ | Task thiết kế |
| 7. Full run 25 task × 3 model (default/cheap/smart) | 1-2 giờ wall | $2-5 cost |
| 8. Generate report | 30 phút | Auto |
| 9. Analyze + document in `IMPROVEMENT-LOG.md` | 1 giờ | Học gì |
| **Tổng** | **~10-12 giờ công** | |

---

## 9. Quyết định cần user xác nhận TRƯỚC khi bắt đầu

1. **Budget**: OK chi bao nhiêu USD cho 1 full benchmark run? (đề xuất $5-10)
2. **Model scope**: Chạy cả 4 model hay chỉ `default` + `smart`?
3. **Claude Code control arm**: Có chạy tay Claude Code cho 5-10 task để so không?
4. **Fixture source**: Dùng fixture tự tạo (đề xuất) hay copy snapshot từ FashionEcom/VietNet?
5. **Run frequency**: 1 lần rồi phân tích? Hay thiết lập CI để chạy định kỳ?
6. **Freeze feature?** — Có đồng ý pause feature mới trong 2 tuần để benchmark + fix gap không?

---

## 10. Deliverables sau khi chạy

1. `benchmark/results/YYYY-MM-DD-*.jsonl` — raw data
2. `benchmark/results/YYYY-MM-DD-report.md` — markdown report (bảng matrix, pass rate theo tier)
3. Update `IMPROVEMENT-LOG.md` — insight, gap phát hiện, action item mới
4. Update `README.md` — claim chính xác (61 tool, test pass X/Y, benchmark score)
5. Issue list cho gap phát hiện (github issue hoặc task tracker)

---

## Phụ lục A — Template verify.js

```js
// benchmark/verify.js
module.exports = {
  T01: async ({ stdout }) => {
    const m = stdout.match(/\b(\d+)\s+async\s+function/i);
    return m ? { pass: true, value: parseInt(m[1]) } : { pass: false, reason: 'no number found' };
  },
  T02: async ({ workDir }) => {
    const content = await fs.readFile(path.join(workDir, 'lib/plan-mode.js'), 'utf8');
    return { pass: /\/\*\*[\s\S]*@param[\s\S]*\*\//.test(content), reason: 'JSDoc missing' };
  },
  // ... T25
};
```

## Phụ lục B — Template runner.js skeleton

```js
// benchmark/runner.js
const tasks = require('./tasks.json');
const verify = require('./verify');

async function runOne(task, model) {
  const workDir = await setupFixture(task);
  const start = Date.now();
  const result = await exec(`orcai --direct --model ${model} --no-confirm --budget 0.10 "${task.prompt}"`, { cwd: workDir });
  const wall_ms = Date.now() - start;
  const v = await verify[task.id]({ stdout: result.stdout, workDir });
  return { task: task.id, model, correct: v.pass, wall_ms, ...parseMetrics(result.stdout) };
}

for (const task of tasks) {
  for (const model of ['default', 'cheap', 'smart']) {
    const r = await runOne(task, model);
    appendJsonl(resultFile, r);
  }
}
```

---

**End of plan**. Review + duyệt trước khi đi bước tiếp theo.
