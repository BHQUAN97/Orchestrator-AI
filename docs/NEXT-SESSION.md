# Next Session — Handoff 2026-04-18 → 2026-04-XX

> Doc file nay TRUOC khi bat dau session moi voi project ai-orchestrator.
> Session 2026-04-18 da lam: xem docs/IMPROVEMENT-LOG.md

---

## Trang thai repo khi dong phien

- **Branch**: main (clean, khong file un-committed)
- **Latest commit**: `ff419c6 docs: session 2026-04-18 complete — 14/14 tasks done`
- **Tag**: `benchmark-baseline-2026-04-18` (truoc cac thay doi session nay)
- **Remote**: `origin/main` synced
- **Tests**: `npm run test:all` = 533/533 passing
- **CI**: GitHub Actions wired (.github/workflows/ci.yml)

## Blocker duy nhat con lai

**OpenRouter credit** (phat hien #5, #6 trong IMPROVEMENT-LOG):
- Free tier context ≈ 14K token cho model `fast` (Gemini)
- Benchmark task thuc te can 20-50K → FAIL truoc khi complete
- Agent loop xai 68K token cho task "dem async function" (inefficient)

**3 option unblock** (chon 1):
1. Nap $10 OpenRouter → len tier context lon hon
2. Switch sang Google AI API direct: free 1500 req/day, 1M context, nhanh
3. Dung Moonshot Kimi API direct: free tier Kimi K2

→ User phai quyet dinh 1 option truoc khi tiep tuc Buoc E.

---

## Viec can lam trong session sau — theo thu tu uu tien

### Priority 1 — FIX TOKEN INEFFICIENCY (Phat hien #5)

**Van de**: Agent dung 68K input token cho task don gian (dem async function). Claude Code chi can 1-2 tool call.

**Root cause can dieu tra**:
1. `lib/context-guard.js` — check evict logic co hoat dong khong? Co remove tool result cu khi task chuyen phase?
2. `lib/stuck-detector.js` — co detect repeated read cung file khong? Neu co sao khong block?
3. `lib/agent-loop.js` — co cache tool result trong 1 session? Grep da tra 0 nhung agent van doc file.
4. System prompt trong `--direct` mode — co nhan manh "Uu tien grep/wc truoc, khong read_file full" khong?

**Steps lam**:
```bash
# 1. Reproduce bug
cd E:/DEVELOP/ai-orchestrator
node bin/orcai.js --direct --model fast -p /tmp/test-fixture "count async functions in lib/agent-loop.js"

# 2. Trace full
ORCAI_TRACE=1 node bin/orcai.js ...

# 3. Doc 3 file tren
# 4. Fix 1 trong cac root cause
# 5. Re-run, confirm token giam duoi 10K
```

**Deliverable**:
- Commit `perf(agent-loop): cache tool result + stricter evict`
- Test regression chung minh reduce token > 80% cho T01
- Update IMPROVEMENT-LOG phat hien #5 → DONE

**Thoi gian uoc luong**: 2-4 gio

---

### Priority 2 — FULL BENCHMARK (Buoc E — sau khi unblock credit)

**Tien de**: Option 1/2/3 da chon, can API key va credit du.

**Steps**:
```bash
# 1. Verify credit + API
curl -H "Authorization: Bearer $NEW_KEY" http://localhost:5002/v1/models
curl ... /v1/chat/completions -d '{"model":"fast","messages":[{"role":"user","content":"test"}]}'

# 2. Dry run 5 A-tier task voi `fast` (re nhat)
node benchmark/runner.js --tier A --model fast

# 3. Neu pass > 80%: full run
node benchmark/runner.js --all --model fast,cheap,default,smart

# 4. Generate report
node benchmark/scorer.js benchmark/results/<latest>.jsonl

# 5. Analyze:
#    - Model nao pass % cao nhat / re nhat
#    - Task tier nao fail nhieu → fix prompt hoac fix code
#    - Update IMPROVEMENT-LOG #6 → DONE
```

**Cost estimate**: $2-5 cho full 25 task × 4 model (cost uoc tinh theo $0.02/task trung binh).

**Deliverable**:
- `benchmark/results/<date>-report.md`
- Cap nhat README voi bang score
- Issue list cho task fail (document gap)

---

### Priority 3 — MO RONG BENCHMARK 20 TASK CON LAI

Session 2026-04-18 chi tao 5 A-tier task (simple single-file). Con lai 20 task trong BENCHMARK-PLAN.md:
- **B-tier** (5): multi-file refactor (extract helper, add flag, migrate deprecated, standardize error, update schema)
- **C-tier** (5): debug/investigation (find leak, trace flow, find duplicate, find dead code, security audit)
- **D-tier** (5): feature implementation (new tool, new CLI flag, refactor module, config migration, fix existing bug)
- **E-tier** (5): integration workflow (full spec-build-check, plan mode flow, rollback flow, budget cap, resume session)

**Steps**:
1. Viet task definitions trong `benchmark/tasks.json` (task T06-T25)
2. Viet verify logic trong `benchmark/verify.js`
3. Tao fixture can thiet trong `benchmark/fixtures/` (neu fixture phuc tap hon repo-snapshot)
4. Dry run tung task
5. Fix bug harness neu co

**Thoi gian**: 3-4 gio

---

### Priority 4 — UPDATE README

Phat hien session 2026-04-18:
- README claim 46 tools → thuc te 61 tools (sai so)
- README khong mention test count (533 tests)
- Khong co CI badge
- Khong co benchmark section

**Steps**:
1. Update so tools: 46 → 61, kem breakdown (core 26, AST 4, git 1, embed 4, research 4, screenshot 3, Windows 22)
2. Them badge CI tu GitHub Actions
3. Them section "Testing" voi `npm run test:all` → 533 tests
4. Them section "Benchmark" link den BENCHMARK-PLAN.md + result (sau khi co)
5. Them doc/PLAN-MODE.md va doc/HOOKS.md vao section "Docs"

**Thoi gian**: 30 phut

---

### Priority 5 — FUZZ TEST TOOL PARITY

Tu danh gia ban dau (phat hien gap so Claude Code):
- Tool parity "46 tools danh nghia OK, nhung edge case chua tot"
- Can fuzz test: input rac, path la, encoding UTF-8/BOM, file lon, symlink, permission denied

**Steps**:
1. Tao `test/fuzz-tools.test.js`
2. Cho moi tool (61 total), test 3 case:
   - Input valid binh thuong
   - Input edge (empty, max size, unicode, special chars)
   - Input rac (null, undefined, wrong type) — phai fail gracefully
3. Confirm tat ca tool co error handling thong nhat

**Thoi gian**: 4-6 gio (nhieu tool)

---

### Priority 6 — ADDITIONAL TASKS TU CHECKLIST BAN DAU

| Task | Trang thai | Thoi gian |
|---|---|---|
| Contract test per tool | Chua lam | 3h |
| Pre-commit hook chan test fail | Chua lam | 30 phut |
| ARCHITECTURE.md giai thich 3 lop AgentLoop/OrchestratorV3/AgentBus | Chua lam | 1h |

---

## Context quan trong can nho cho session sau

### Kien truc (TU IMPROVEMENT-LOG phat hien #1)

**3 layer doc lap, KHONG trung lap** (da confirm 2026-04-18):
- `lib/agent-loop.js` — CORE think-act-verify loop (tuong duong Claude Code agentic loop)
- `lib/orchestrator-v3.js` — extends OrchestratorAgent, multi-agent orchestration (scan → plan → review → execute)
- `lib/agent-bus.js` — EventEmitter pub/sub parent ↔ subagent (progress streaming)

KHONG dedupe. Neu thay code "trung" thi check luong lai.

### Tool surface (TU IMPROVEMENT-LOG phat hien #3)

**61 tool** (khong phai 46 nhu README):
- Core 26: read_file/write_file/edit_file/list_files/search_files/glob/web_fetch/web_search/execute_command/bg_*/edit_files/read_mcp_resource/spawn_subagent/memory_*/create_skill/decompose_task/spawn_team/todo_*/ask_user_question/task_complete
- AST 4: ast_parse/ast_find_symbol/ast_find_usages/ast_rename_symbol
- git_advanced: 1 tool / 8 subaction (blame/log/diff/stash/branch/status/show/cherry_pick)
- Embedding 4: embed_index/embed_search/embed_stats/embed_clear
- Research 4: github_code_search/github_issue_search/npm_info/deep_research
- Screenshot 3 (Win): capture_screen/capture_window/list_monitors
- Windows-native 22: ps_command/everything_search/clipboard_r+w/event_log/wmi_query/wsl_exec/winget_search/sys_info + registry x4 + tasks x6 + services x6

### CLI flag co san (TU IMPROVEMENT-LOG phat hien #4)

KHONG viet lai nhung flag nay — da co:
- `--plan` → plan-mode.js
- `--worktree` → isolated worktree
- `--budget <usd>` → cost cap
- `--resume [id]` → session continuity
- `--direct` → skip repo scan
- `--mcp-config <path>` → MCP overlay
- `--no-hooks` → disable hooks
- `--no-cache` → disable prompt cache
- `--no-confirm` → skip confirm

### Test infrastructure

- `npm test` = 164 test (nhanh, 3 file)
- `npm run test:all` = 533 test (full, 16 file) — dung khi thay doi lon
- `node benchmark/test-verify.js` = 9 smoke test cho verify logic
- `node benchmark/runner.js --tier A --dry-run` = test harness khong chay LLM

### CI

`.github/workflows/ci.yml`:
- Matrix Node 18 + 20 tren Ubuntu
- Windows-latest job chay `test/windows-tools.test.js`
- Trigger: push main + PR to main

---

## File quan trong nhat (doc khi session sau bat dau)

1. `docs/IMPROVEMENT-LOG.md` — nhat ky + 6 phat hien
2. `docs/BENCHMARK-PLAN.md` — plan benchmark full
3. `docs/NEXT-SESSION.md` — (file nay)
4. `docs/PLAN-MODE.md` — cach dung --plan
5. `docs/HOOKS.md` — cach cau hinh hooks
6. `docs/adr/` — 10 ADR ve kien truc
7. `benchmark/README.md` — cach chay benchmark

---

## Neu quen khong biet bat dau tu dau

1. Doc file nay tu tren xuong
2. Chay `git log --oneline -25` xem session truoc da lam gi
3. Chay `npm run test:all` confirm chua bi regression
4. Bat dau Priority 1 (fix token inefficiency) — khong can credit de lam
5. Hoi user ve credit option truoc khi lam Priority 2-3
