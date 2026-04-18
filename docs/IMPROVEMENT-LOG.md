# Improvement Log — AI Orchestrator v2.2 → v2.3

> Nhat ky cai tien tu 2026-04-18. Moi entry ghi: van de → gia thuyet → action → ket qua thuc te.
> Moi lan chay lai phien, doc file nay truoc de biet da lam den dau.

---

## Phien 2026-04-18 Round 3 — Comprehensive test + security + auto-fix

**Format**: 3 agent song song (Sonnet) → consolidate → fix Critical/High → re-bench.

### Agent A — Benchmark 8 free model moi
- Them qwen-coder, qwen-next, hermes-405b, nemotron-super/nano, gemma4-31b/26b, llama70b vao litellm_config.yaml
- 4/8 pass ping (4 bi 429 upstream — retry sau)
- 2 model usable moi: **free-nemotron-nano** (80% pass, P/P 14.5, 17s avg) va **free-nemotron-super** (80% pass, P/P 13.2, 53s avg)
- Cost: $0.56 — report: `benchmark/results/2026-04-18-free-expanded-report.md`
- Commit: `9469398 bench: test 8 more free OpenRouter models`

### Agent B — Fuzz test 29 tools (90 case)
- Test file moi: `test/fuzz-tools.test.js`
- Phat hien **5 CRITICAL crash** + 1 HIGH + 2 test-bugs (khong phai tool bug)
- 5 CRIT da fix (commit `f6f6185`): write_file empty path/null content, edit_file null old_string, search_files invalid regex, batch_edit null args
- 1 HIGH fix (commit `18de1cd`): bg_list rename `procs` → `processes`

### Agent C — Security + quality audit (98 files, 24.5K LOC)
- Phat hien **2 CRITICAL + 3 HIGH + 4 MEDIUM + 2 LOW**
- 2 CRIT + 2 HIGH da fix (commit `709dad1`):
  - CRIT-1 `wsl_exec` shell bypass — them `checkBlocked()` export tu terminal-runner
  - CRIT-2 `worktree.js` execSync string template — chuyen execFileSync argv + validate baseBranch regex
  - HIGH-1 `wmi-query` PS injection qua properties — allowlist `/^[A-Za-z_][A-Za-z0-9_]*$/`
  - HIGH-2 `services` filter script block escape — allowlist `[A-Za-z0-9\-_.]`
- HIGH-3 ReDoS `searchFiles` fix-bundled trong commit `f6f6185` (reject nested quantifier)
- 4 MEDIUM (shadow-git path interp, glob-tool cwd, ast-parse absPath, session-continuity listener leak) + 2 LOW → **pending phien sau**

### Re-benchmark
- `cheap` (GPT-5.4-mini) post-fix: **5/5 PASS 100%** (same as baseline) — no regression
- Defensive fix khong anh huong path benchmark (input deterministic)

### Deliverable
- 4 commit fix + 1 commit test/docs + 1 commit leaderboard
- `benchmark/results/BENCHMARK-LEADERBOARD.md` — **canonical** cross-session (10 model, methodology, reproducibility checklist)
- `docs/AUDIT-2026-04-18.md` — security audit report
- `docs/FUZZ-RESULTS-2026-04-18.md` — fuzz bug list
- `test/fuzz-tools.test.js` — regression suite moi

### Test state sau phien
- 533 test:all pass (giu nguyen)
- 88/90 fuzz pass (2 fail la test bug khong phai tool bug)
- 9/9 bench-verify pass (fix stale T01 stdout format)

### Con lai cho phien sau (truoc continuation)
- Retry 4 model 429 (qwen-coder, qwen-next, hermes, llama70b)
- Fix 4 MEDIUM + 2 LOW security finding tu audit
- Fix 2 test-bug signature (embed_stats, embed_clear)
- Token inefficiency (Priority #1 handoff cu — van chua dung)

---

## Phien 2026-04-18 Round 3 Continuation — P0/P1/P3 cleanup

Sau Round 3 chinh, tiep tuc xu ly P0 (MED + LOW security) + P1 (retry free models) + P3 (test bugs).

### P1 — Retry 4 rate-limited free model
- Ping lai lan 2: tat ca **van 429** upstream
- Ket luan: 4 model nay **khong kha dung tren free tier OpenRouter** o thoi diem nay
- Update LEADERBOARD them section "Option de unblock" (credit, provider khac, doi time, skip)

### P0 — Fix 4 MEDIUM + 2 LOW security finding
- **MED-1 shadow-git** (commit `6b7e2f0`): them `_execArgs()` execFileSync argv, migrate 3 callsite co input dong (rollback checkout, diff name-status + hunks)
- **MED-2 glob-tool** (commit `6b7e2f0`): **false positive** — line 33 da co boundary check, audit Agent C doc sai line 29
- **MED-3 ast-parse** (commit `6b7e2f0`): them `_resolveInProject(filePath, projectDir)` helper, apply cho 4 function (astParse/astFindSymbol/astFindUsages/astRenameSymbol). Update executor truyen `this.projectDir` vao
- **MED-4 session-continuity** (commit `6b7e2f0`): named handler + `detach()` method → caller co the off() khi session end, tranh listener accumulation
- **LOW-1 init-project** (commit `6b7e2f0`): execSync string → execFileSync argv cho consistency
- **LOW-2 orcai-loop-start** (commit `6b7e2f0`): them comment giai thich shell:true la co y (Windows .cmd spawn, args hardcoded, khong co user input)

### P3 — Fix 2 test-bug signature
- fuzz embed_stats/embed_clear goi sai signature: truyen store trong args thay vi ctx. Fix ve form (args, ctx) + them confirm:true cho embedClear.
- Ket qua: **90/90 fuzz pass** (tu 88/90)

### Commit
- `6b7e2f0` fix(security): MED-1/3/4 + LOW-1/2 + test-bug signatures (7 files, +87/-35)
- `a9002e2` docs(bench): LEADERBOARD note 4 model still 429

### Test state cuoi Round 3 Continuation
- 533 test:all pass
- **90/90 fuzz pass** (het 2 test-bug)
- 9/9 bench-verify pass
- Push origin/main thanh cong

### Con lai cho phien sau
- **P2: Token inefficiency** (agent dung 68K token cho task "dem async function" — can fix context-guard, stuck-detector, agent-loop cache + system prompt)
- **P4: B-tier benchmark** (5 multi-file refactor task) — yeu cau harness support multi-file fixture
- 4 model 429 — retry khi co credit/provider moi
- Token tracing tool: log tung tool call de debug 68K inflation

---

## Bối cảnh ban đầu (2026-04-18)

**Đánh giá v2.2 so với Claude Code** xác định 6 vấn đề:
1. Model quality (kém hơn Opus/Sonnet)
2. UX polish (thiếu plan mode, hooks chuẩn, IDE integration)
3. Độ ổn định (38K LOC, test coverage thấp, 3 agent engines nghi trùng lặp)
4. Tool parity quality (46 tools nhưng edge cases chưa tốt)
5. Extended thinking chưa wire
6. Git hygiene (22 modified + 35 untracked chưa commit)

**Quyết định**: Bỏ qua #1 (phụ thuộc bên ngoài). Tập trung #2-6.

---

## Phát hiện #1 — 3 agent engines KHÔNG trùng lặp (2026-04-18)

**Giả thuyết ban đầu**: `agent-loop.js`, `orchestrator-v3.js`, `agent-bus.js` là 3 engine chồng chéo → cần dedupe.

**Khảo sát thực tế** (grep require từ toàn codebase):
```
AgentLoop  → dùng ở: index.js, bin/orcai.js, orchestrator-v3.js, subagent.js, parity.test.js
OrchestratorV3 → dùng ở: index.js, src/api-server.js
AgentBus   → dùng ở: bin/orcai.js, parity.test.js
```

**Kết luận**: Đây là 3 lớp khác nhau trong kiến trúc, không phải duplicate:
- **AgentLoop** (lib/agent-loop.js) = CORE think-act-verify loop (tương đương Claude Code agentic loop)
- **OrchestratorV3** (lib/orchestrator-v3.js) = MULTI-AGENT orchestration, `extends OrchestratorAgent`, bao lớp AgentLoop cho mỗi subtask
- **AgentBus** (lib/agent-bus.js) = EventEmitter cho pub/sub parent ↔ subagent (progress streaming)

→ **Hành động**: Task #4 đóng. Architecture giữ nguyên. Document lại 3 vai trò trong docs/ARCHITECTURE.md (pending).

---

## Roadmap 6 mục (uu tien theo ROI / risk)

### Priority 1 — Git hygiene (1 giờ, risk thấp)
- [ ] Phân loại 22 modified + 35 untracked theo chủ đề
- [ ] Commit lần lượt theo nhóm: feat / perf / test / docs / fix
- [ ] Không commit `.env`, `node_modules`, cache dirs
- [ ] Push lên remote

### Priority 2 — Test baseline + CI (1 tuần)
- [ ] Chạy toàn bộ test hiện tại, ghi baseline (pass/fail/time)
- [ ] Setup `.github/workflows/ci.yml` (node 18 + 20)
- [ ] Pre-commit hook chặn commit nếu test fail

### Priority 3 — Tool parity quality (2 tuần)
- [ ] Mở rộng test/parity.test.js lên 20+ task thực tế
- [ ] Fuzz test: input rác, path lạ, encoding UTF-8/BOM, file lớn
- [ ] Contract test: mỗi tool có schema + 3-5 test edge

### Priority 4 — UX polish (1 tuần)
- [ ] Wire `lib/plan-mode.js` vào CLI (`orcai --plan`)
- [ ] Chuẩn hóa hooks spec theo Claude Code format (PreToolUse, PostToolUse, Stop, SessionStart)
- [ ] Tạo `docs/HOOKS.md`
- [ ] Status line + progress polish

### Priority 5 — Extended thinking (3 ngày)
- [ ] Kiểm tra `lib/extended-thinking.js` hiện tại
- [ ] Wire qua LiteLLM cho: Gemini 2.5 thinking, DeepSeek-R1 reasoning, Sonnet 4.6+ extended
- [ ] Test thực tế 1 task phức tạp so sánh on/off

### Priority 6 — Document architecture (1 ngày)
- [ ] `docs/ARCHITECTURE.md` giải thích 3 lớp AgentLoop / OrchestratorV3 / AgentBus
- [ ] Update README.md link vào ARCHITECTURE.md

---

## Nhật ký tiến độ

### 2026-04-18 — Kick off
- [x] Đọc README.md, UPGRADE-PLAN.md, 11 ADR
- [x] Khảo sát 3 agent engines → phát hiện #1 (không trùng lặp)
- [x] Tạo 14 task tracker
- [x] Tạo file này (IMPROVEMENT-LOG.md)
- [x] Chạy test baseline: ~400+ test pass (xem phát hiện #2)
- [x] Review parity.test.js = 109 test API surface (unit, không E2E)
- [x] Audit tools/definitions.js: 61 tool thật (README claim 46 → sai lệch)
- [x] Audit CLI flags: `--plan`, `--worktree`, `--budget`, `--resume` đã có sẵn
- [x] Tạo docs/BENCHMARK-PLAN.md chi tiết 10 mục + 25 task + pre-flight checklist

## Phát hiện #2 — Test coverage & pass rate (2026-04-18)

`npm test` CHỈ chạy 3 file: `test-v2.2.js` + `test/hardening.test.js` + `router/test-router.js` = 164 test pass.
Nhưng trong `test/` còn **19 file .test.js khác** không được `npm test` gọi.

Kiểm tra thủ công 8 file: audit-log(37), cost-tracker(21), parity(109), stack-profile(22), trace-store(15), windows-tools(15), cross-project-memory(10), rag-prompt-builder(21) → **250 test pass**.

**Chưa kiểm tra**: bench-rag, dynamic-lock-ttl, hybrid-router, improve-loop, problems-realistic, research-tools, session-continuity, shadow-git-rollback, shared-budget-pool, training-extract, coding-quality-bench, coding-quality-bench-rag.

→ **Tổng estimated pass: 400+ test** (chưa confirm hết).
→ **Action**: Sửa `package.json` scripts để `npm test` chạy toàn bộ `test/*.test.js`.

## Phát hiện #3 — Tool count không khớp (2026-04-18)

README v2.3 claim: "46 tools".
Thực tế audit tools/definitions.js + windows/index.js + embedding-search + research-tools + git-advanced + screenshot = **61 tool**.

Breakdown:
- Core: 26 (read/write/edit/list/search/glob/web_fetch/web_search/execute_command/bg_*/edit_files/read_mcp_resource/spawn_subagent/memory_*/create_skill/decompose_task/spawn_team/todo_*/ask_user_question/task_complete)
- AST: 4 (parse/find_symbol/find_usages/rename_symbol)
- git_advanced: 1 tool / 8 subaction (blame/log/diff/stash/branch/status/show/cherry_pick)
- Embedding: 4 (index/search/stats/clear)
- Research: 4 (github_code_search/github_issue_search/npm_info/deep_research)
- Screenshot (Win): 3 (capture_screen/capture_window/list_monitors)
- Windows-native: 22 (ps_command/everything_search/clipboard_r+w/event_log/wmi_query/wsl_exec/winget_search/sys_info + registry x4 + tasks x6 + services x6)

→ **Action**: Update README section "Claude Code Parity (v2.3)" → đổi "46 tools" thành "61 tools".

## Phát hiện #4 — UX polish đã nhiều hơn tưởng (2026-04-18)

Đánh giá ban đầu nói "thiếu plan mode, hooks chuẩn, --budget" — thực tế **đã có trong bin/orcai.js**:
- `--plan` → wire `lib/plan-mode.js` (line 89)
- `--no-hooks` → wire `lib/hooks.js` (line 95)
- `--budget <usd>` → cap cost (line 91)
- `--worktree` → isolated git worktree (line 98)
- `--resume [id]` → session continuity (line 90)
- `--direct` → skip repo scan (line 88)
- `--mcp-config <path>` → MCP overlay (line 97)

→ **Action**: Task #7, #8 giảm scope từ "wire từ đầu" xuống "audit + document + fix gap nếu có".

## Phát hiện #5 — Token inefficiency trong agent loop (2026-04-18)

**Bối cảnh**: Chạy thử T01 (đếm async function trong `lib/agent-loop.js` — task đơn giản) với model `fast` (Gemini Flash).

**Kết quả**: Agent xài **68983 input token + 176 output token** trong 8 iteration → vượt OpenRouter free tier context limit (14466) → FAIL.

**Trace**:
1. Agent gọi `list_files` → OK
2. `search_files` → ENOTDIR error (path bug)
3. `read_file` lần 1 (line 1-200)
4. `execute_command grep` → trả 0 (grep args có thể wrong)
5. `execute_command grep` lần 2 → trả 0
6. `read_file` lần 2 (line 201-700)
7. `read_file` lần 3 (line 701-1163) → đọc hết file
8. Gửi LLM lại với full context = 16K+ tokens → vượt limit

**Gap phát hiện**:
- Agent KHÔNG dừng khi grep đã đủ thông tin (giữ đọc full file)
- Context rolling không evict tool result cũ khi task đơn giản
- Prompt cache không hit (cache hit: 0%)

**So với Claude Code**: Claude Code 1-2 tool call là xong task này (grep đơn + đếm). OrcAI dùng 8 iteration.

**Action**:
- [ ] **Opt 1**: Thêm system prompt hint cho `--direct` mode: "Ưu tiên grep/wc trước, không read_file full"
- [ ] **Opt 2**: Cache control ở message level — detect khi tool result trùng lặp
- [ ] **Opt 3**: Stuck detector đã có (`lib/stuck-detector.js`) — kiểm tra có hoạt động không
- [ ] **Opt 4**: Review `lib/context-guard.js` có evict đúng không

**Priority**: High — đây là core efficiency bug, ảnh hưởng MỌI task, không chỉ benchmark.

## Phát hiện #6 — OpenRouter free tier không đủ benchmark (2026-04-18)

**Status**: OpenRouter free tier context window ≈ 14K token cho `fast` (Gemini). Benchmark thực tế thường cần 20-50K.

**Action cần user quyết**:
1. Nạp credit OpenRouter ($10+) → tier cao hơn, context rộng hơn
2. HOẶC switch sang Gemini API direct (free quota 1500 req/day, context 1M)
3. HOẶC dùng Moonshot API direct (free tier Kimi K2)

→ **Blocker cho Bước E (full benchmark run)**. Các bước A-D đã xong.

---

## Nhật ký phiên 2026-04-18 — Tổng kết

**Đã làm** (9/14 task complete, 1 in_progress, 4 pending):
- ✅ Khảo sát + 6 phát hiện quan trọng
- ✅ IMPROVEMENT-LOG.md + BENCHMARK-PLAN.md
- ✅ 17 commit git (clean state, tag benchmark-baseline-2026-04-18, push GitHub)
- ✅ Test baseline 164/164 pass sau refactor
- ✅ Benchmark harness đầy đủ (runner + verify + scorer + 9 smoke test pass)
- ✅ Dry run → phát hiện token inefficiency + credit limit

**Blocker**:
- OpenRouter credit / cần chọn provider khác trước khi chạy full benchmark

**Tiếp theo khi user đáp ứng blocker**:
- Bước E: Full benchmark 25 task × 4 model
- Fix phát hiện #5 (token efficiency)

---

## Nhật ký 2026-04-18 — Phiên tiếp (sau credit block)

**Đã làm thêm**:
- ✅ Task #6: CI GitHub Actions (Node 18+20 matrix + Windows job)
- ✅ `npm run test:all` chạy 16 file = 533 test pass (trước đó `npm test` chỉ 3 file = 164 test)
- ✅ Task #7: Plan mode audit — đã hoàn chỉnh, tạo `docs/PLAN-MODE.md`
- ✅ Task #8: Hooks audit — đã chuẩn Claude Code format, tạo `docs/HOOKS.md`
- ✅ Task #9: Extended thinking mở rộng Claude → 4 provider family (Claude + Gemini 2.5 + DeepSeek-R1 + o1/o3). 20 test pass. Không cần credit (verify param construction).

**Commit mới**:
- `ci: GitHub Actions + test:all` (eebf41c)
- `feat(thinking): multi-provider + PLAN/HOOKS docs` (6cde1d4)

**Total phiên 2026-04-18**: 14/14 task xong. 20 commit tới origin/main.

**Còn blocker duy nhất**: OpenRouter credit cho full benchmark run (Bước E).
**Option unblock**:
1. Nạp $10 OpenRouter → full context window
2. Dùng Google AI API direct (free 1500 req/day, 1M context)
3. Dùng Moonshot Kimi API direct

---

## Nhật ký 2026-04-18 — Phiên 3 (unblock + full benchmark)

**User action**: Nạp $10 OpenRouter → unblock #6.

**Đã làm**:
- ✅ Bước E: Full benchmark 5 A-tier task × 4 model = 20 run
- ✅ Scorer report: `benchmark/results/2026-04-18-full-report.md`
- ✅ Analysis: `benchmark/results/2026-04-18-analysis.md`

**Kết quả pass rate**:
| Model | Pass | % | Avg wall |
|---|---|---|---|
| cheap (GPT-5.4-mini) | 4/5 | **80%** | 7.4s |
| gemini (direct) | 3/5 | 60% | 53s |
| default (DeepSeek V3.2) | 2/5 | 40% | 33s |
| smart (Sonnet 4.6) | 2/5 | 40% | 3.6s* |

\* smart ngắn do bug budget prompt (Finding #2 mới).

**Phát hiện mới từ benchmark** (6 findings — xem analysis.md):
1. T01 verify regex quá strict (`\b(\d+)\s*async`) — mọi model fail
2. **BUG**: `--no-confirm` không skip budget prompt → smart runs hang
3. Fixture T01 incomplete (search 0 match trong file có async)
4. Gemini free tier = 20 req/day → không đủ full 25 task
5. parseMetrics regex không khớp format output (`cost: $X.XX`)
6. Router `fast` model không pin deployment → call 2 đổi provider

**Takeaway**: `cheap` (GPT-5.4-mini) là cost-perf winner. Trước khi mở rộng B/C/D/E tier cần fix 6 bug này.

→ **Bước E: DONE**. **Phát hiện #6: CLOSED** (user nạp $10).
→ **Bug backlog**: 6 issue mới từ benchmark — ưu tiên Finding #2 (budget prompt).

---

## Nguyên tắc

1. **Freeze feature mới trong 1 tháng** — chỉ fix / test / cleanup / docs.
2. **Mỗi phiên kết thúc** phải update file này + commit.
3. **Trước khi xóa code** bất kỳ, phải grep usage toàn repo và document lý do.
4. **Test trước, refactor sau** — không refactor code chưa có test coverage.
5. **Nhỏ và thường xuyên** — commit nhỏ, push thường, không batch 50 file.
