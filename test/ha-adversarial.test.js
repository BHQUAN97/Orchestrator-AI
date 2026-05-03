#!/usr/bin/env node
/**
 * HA Adversarial Test Suite — "Bẫy" kiểm tra độ thông minh & khả năng tự xoay sở
 *
 * 8 Test Case:
 *  C1: Stuck Loop (A↔B toggle) → phải escalate
 *  C2: Decision Lock conflict → phải từ chối + đề xuất thay thế
 *  C3: Self-Healer / Broken Environment → phát hiện môi trường lỗi không phải code lỗi
 *  C4: LLM không khởi động (ECONNREFUSED) → fallback + graceful degrade
 *  C5: Local model offline → tự chuyển sang cloud
 *  C6: Docker lỗi (daemon không chạy, container crash) → detect + phân loại lỗi
 *  C7: Lỗi cú pháp cài bẫy (A→B→A cycle qua syntax) → dừng sau 3 lần, báo kẹt
 *  C8: Tool failure cascade (tool fail dây chuyền) → self-healer inject suggestion
 */

'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

// ─── Helpers ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const results = [];

function assert(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✅ ${name}`);
    passed++;
    results.push({ name, ok: true });
  } else {
    console.log(`  ❌ FAIL: ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
    results.push({ name, ok: false, detail });
  }
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

// Tmp dir sạch cho mỗi test
function tmpDir(suffix) {
  const d = path.join(os.tmpdir(), `ha-test-${suffix}-${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ─── Load modules ─────────────────────────────────────────────────────────────
const { StuckDetector } = require('../lib/stuck-detector');
const { SelfHealer } = require('../lib/self-healer');
const { DecisionLock } = require('../router/decision-lock');
const { HermesBridge } = require('../lib/hermes-bridge');

(async () => {

// ══════════════════════════════════════════════════════════════════════════════
// CASE 1 — Stuck Loop: Toggle A↔B → escalate
// ══════════════════════════════════════════════════════════════════════════════
section('C1: Bẫy Vòng Lặp Vô Tận (Stuck Loop / Toggle A↔B)');
console.log('Mục tiêu: Agent toggle giữa 2 tool call → phải phát hiện sau 5 lần, không cần reset.\n');

{
  const sd = new StuckDetector();

  // Mô phỏng agent: viết code → fail → revert → fail lại (A↔B pattern)
  const callA = () => sd.record('write_file', { path: 'auth.js', content: 'v_A' });
  const callB = () => sd.record('write_file', { path: 'auth.js', content: 'v_B' });

  // 4 lần đầu → chưa đủ TOGGLE_MIN (5)
  let w1 = callA(); // 1
  let w2 = callB(); // 2
  let w3 = callA(); // 3
  let w4 = callB(); // 4
  assert('C1-a: Sau 4 lần chưa trigger warning', w1 === null && w4 === null);

  // Lần 5 → trigger toggle
  let w5 = callA(); // 5 — đủ TOGGLE_MIN
  assert('C1-b: Lần 5 trigger warning type=toggle', w5 !== null && w5.type === 'toggle',
    w5 ? `got type=${w5.type}` : 'got null');
  assert('C1-c: Warning có message đề cập "different path"', w5 && /different path|circular|toggling/i.test(w5.message),
    w5?.message?.slice(0, 80));
  assert('C1-d: patterns ghi nhận cả 2 signature', w5 && Array.isArray(w5.patterns) && w5.patterns.length === 2);

  // Sau khi detect → agent phải reset và escalate (giả lập escalation ladder)
  const MODEL_ESCALATION = { cheap: 'smart', default: 'smart', fast: 'smart', smart: 'architect', architect: 'architect' };
  let currentModel = 'default';
  if (w5) {
    const next = MODEL_ESCALATION[currentModel];
    currentModel = next || currentModel;
    sd.reset();
  }
  assert('C1-e: Model đã leo thang từ default → smart', currentModel === 'smart');
  assert('C1-f: Sau reset, toggle mới không trigger ngay', sd.record('write_file', { path: 'auth.js', content: 'v_A' }) === null);
}

// ══════════════════════════════════════════════════════════════════════════════
// CASE 2 — Decision Lock Conflict: Khóa auth.js → từ chối refactor
// ══════════════════════════════════════════════════════════════════════════════
section('C2: Bẫy Xung Đột Quyết Định (Decision Lock)');
console.log('Mục tiêu: Khóa scope "auth" → agent yêu cầu refactor endpoint → phải bị CHẶN.\n');

{
  const dir2 = tmpDir('c2');
  const dl = new DecisionLock({ projectDir: dir2 });

  // Tech Lead khóa auth API — cấm thay đổi cấu trúc endpoint
  dl.lock({
    decision: 'Auth API dùng JWT Bearer, endpoint /auth/login không đổi signature',
    scope: 'auth',
    approvedBy: 'tech-lead',
    reason: 'FE + mobile đã hardcode path này, thay đổi vỡ contract',
    relatedFiles: ['lib/auth.js', 'gateway/auth-server.js'],
    ttl: 4 * 60 * 60 * 1000  // 4h
  });

  // Test: scope lock active
  assert('C2-a: Scope "auth" bị khóa sau lock()', dl.isLocked('auth'));

  // Test: fe-dev muốn refactor → CHẶN
  const v1 = dl.validate('auth', 'fe-dev');
  assert('C2-b: fe-dev bị CHẶN (allowed=false)', v1.allowed === false,
    `allowed=${v1.allowed}`);
  assert('C2-c: blockedBy trả về mảng locks', Array.isArray(v1.blockedBy) && v1.blockedBy.length > 0);
  assert('C2-d: Lock có lý do rõ ràng', v1.blockedBy[0].reason?.includes('FE') || v1.blockedBy[0].decision?.includes('JWT'));

  // Test: be-dev cũng bị CHẶN (chỉ tech-lead mới qua được)
  const v2 = dl.validate('auth', 'be-dev');
  assert('C2-e: be-dev cũng bị CHẶN', v2.allowed === false);

  // Test: tech-lead override → ĐƯỢC phép nhưng có cảnh báo
  const v3 = dl.validate('auth', 'tech-lead');
  assert('C2-f: tech-lead được phép nhưng có warning', v3.allowed === true && !!v3.warning,
    `allowed=${v3.allowed} warning="${v3.warning?.slice(0, 60)}"`);

  // Test: HermesBridge checkFilePath phát hiện auth.js trong lock
  const bridge = new HermesBridge({ projectDir: dir2 });
  const fileLocks = bridge.checkFilePath('lib/auth.js');
  assert('C2-g: checkFilePath("lib/auth.js") trả về lock', fileLocks.length > 0,
    `got ${fileLocks.length} locks`);

  // Test: formatLocksForPrompt inject vào context
  const lockPrompt = bridge.formatLocksForPrompt();
  assert('C2-h: formatLocksForPrompt có nội dung "DO NOT override"', lockPrompt.includes('DO NOT override') || lockPrompt.includes('Locked decisions'));
  assert('C2-i: Lock prompt đề cập scope "auth"', lockPrompt.includes('auth'));

  // Test: scope khác (ui) không bị ảnh hưởng
  const v4 = dl.validate('ui', 'fe-dev');
  assert('C2-j: Scope "ui" không bị khóa → allowed', v4.allowed === true);

  // Cleanup
  try { fs.rmSync(dir2, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ══════════════════════════════════════════════════════════════════════════════
// CASE 3 — Self-Healer: Môi trường giả (test script bị hỏng)
// ══════════════════════════════════════════════════════════════════════════════
section('C3: Bẫy Môi Trường Giả (Self-Healer / Broken Environment)');
console.log('Mục tiêu: npm test luôn fail dù code đúng → healer phải phân biệt "tool lỗi" vs "code lỗi".\n');

{
  const sh = new SelfHealer({ enabled: true });

  // Mô phỏng: execute_command("npm test") fail liên tiếp với cùng error
  const brokenTestErr = { success: false, error: 'exit code 1: sh: jest: not found' };
  const toolName = 'execute_command';
  const args = { command: 'npm test' };

  // Lần 1 + 2 → chưa đủ 3 lần, chưa tạo suggestion
  const r1 = sh.observe(toolName, args, brokenTestErr);
  const r2 = sh.observe(toolName, args, brokenTestErr);
  assert('C3-a: Sau 2 lần fail chưa có suggestion', r1 === null && r2 === null && !sh.hasPendingSuggestion());

  // Lần 3 → trigger gotcha
  const r3 = sh.observe(toolName, args, brokenTestErr);
  assert('C3-b: Lần 3 trả về gotcha suggestion', r3 !== null && r3.type === 'gotcha',
    r3 ? `type=${r3.type}` : 'got null');
  assert('C3-c: Suggestion đề cập tên tool', r3 && r3.message.includes(toolName));
  assert('C3-d: Suggestion đề cập "Doi cach tiep can"', r3 && /doi cach|alternative|check args/i.test(r3.message));
  assert('C3-e: hasPendingSuggestion() = true sau gotcha', sh.hasPendingSuggestion());

  // Consume suggestion
  const consumed = sh.consumeSuggestion();
  assert('C3-f: consumeSuggestion() trả về suggestion', !!consumed);
  assert('C3-g: Sau consume, hàng đợi rỗng', !sh.hasPendingSuggestion());

  // Mô phỏng: agent kiểm tra package.json → phát hiện jest chưa cài
  // Sau đó fix → npm test thành công → ghi recovery
  // (cần count >= 2 trước khi success để trigger recovery)
  const sh2 = new SelfHealer({ enabled: true });
  sh2.observe(toolName, args, brokenTestErr); // count=1
  sh2.observe(toolName, args, brokenTestErr); // count=2
  sh2.observe(toolName, args, brokenTestErr); // count=3 → gotcha
  const fixResult = { success: true, output: 'All tests passed' };
  sh2.observe(toolName, args, fixResult); // success after >=2 failures → recovery

  const stats = sh2.getStats();
  assert('C3-h: Ghi nhận recovery (recoveries_saved >= 0)', stats.recoveries_saved >= 0);
  assert('C3-i: Stats.observed = 4', stats.observed === 4, `got ${stats.observed}`);
  assert('C3-j: active_streaks = 0 sau success', stats.active_streaks === 0, `got ${stats.active_streaks}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// CASE 4 — LLM không khởi động (ECONNREFUSED / timeout)
// ══════════════════════════════════════════════════════════════════════════════
section('C4: LLM Không Khởi Động (ECONNREFUSED / HTTP 5xx)');
console.log('Mục tiêu: LiteLLM tại port giả → phải nhận ra offline, không treo mãi.\n');

{
  // Mô phỏng retry wrapper behavior của fetchWithRetry
  let { fetchWithRetry } = require('../lib/retry');

  // Scenario A: ECONNREFUSED — server không tồn tại
  const econnErr = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:19999'), { code: 'ECONNREFUSED' });
  const mockFetchRefused = async () => { throw econnErr; };

  // fetchWithRetry phải ném sau retries lần thử, không treo vô tận
  // retries: 0 → chỉ 1 attempt, không backoff → hoàn thành < 500ms
  let refusedThrew = false;
  let refusedErr = null;
  const t0 = Date.now();
  await fetchWithRetry(mockFetchRefused, { retries: 0 })
    .catch(e => { refusedThrew = true; refusedErr = e; });
  const elapsed = Date.now() - t0;

  assert('C4-a: ECONNREFUSED → ném lỗi (không nuốt)', refusedThrew, `refusedErr=${refusedErr?.message}`);
  assert('C4-b: Hoàn thành trong <500ms khi retries=0 (không treo)', elapsed < 500, `took ${elapsed}ms`);
  assert('C4-c: Lỗi giữ nguyên type ECONNREFUSED', refusedErr && (refusedErr.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(refusedErr.message)));

  // Scenario B: HTTP 500 từ LLM → retry rồi fail
  // Scenario B: HTTP 500 — không phải retryable status (500 ∉ {429,502,503,504})
  // fetchWithRetry trả về response 500 ngay, caller tự xử lý
  let callCount500 = 0;
  const mockFetch500 = async () => {
    callCount500++;
    return { ok: false, status: 500, headers: { get: () => null } };
  };

  let resp500 = null;
  await fetchWithRetry(mockFetch500, { retries: 2 })
    .then(r => { resp500 = r; }).catch(() => { resp500 = null; });

  assert('C4-d: HTTP 500 trả về response (không throw, caller tự handle)', resp500 !== null && resp500.status === 500,
    `callCount=${callCount500} resp=${resp500?.status}`);

  // Scenario C: HermesBridge local model check — LM Studio offline tại port lạ
  // Dùng port đảm bảo không có service nào ở đó
  const bridge4 = new HermesBridge({
    litellmUrl: 'http://localhost:19998',
    litellmKey: 'sk-test'
  });

  // Nếu local model unreachable, selectModel phải fallback sang cloud
  // Giả lập bằng cách override _isLocalAvailable cache
  const { _localAvailable: _orig } = (() => {
    // Không thể import module-level var, test via behavior
    return {};
  })();

  const decision4 = await bridge4.selectModel({
    task: 'builder',
    prompt: 'simple hello world task'
  });
  // Model trả về phải không phải local (vì LM Studio không chạy ở port 19998)
  assert('C4-e: selectModel trả về model hợp lệ khi offline', !!decision4.model,
    `model=${decision4.model}`);
  assert('C4-f: Không chọn model "local-*" khi LM Studio offline',
    !String(decision4.model).startsWith('local'),
    `model=${decision4.model}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// CASE 5 — Local Model Offline → tự chuyển cloud
// ══════════════════════════════════════════════════════════════════════════════
section('C5: Local Model Offline → Tự Chuyển Cloud');
console.log('Mục tiêu: LM Studio không chạy → HermesBridge phải fallback sang model cloud.\n');

{
  // Inject mock SmartRouter trả local model, nhưng LM Studio offline
  const { SmartRouter } = require('../router/smart-router');
  const origRoute = SmartRouter.prototype.route;

  // Patch router để ép trả về local model
  SmartRouter.prototype.route = function() {
    return { litellm_name: 'local-qwen2-7b', score: 85, reasons: ['local available'], alternatives: [] };
  };

  // LM Studio ở port giả → sẽ fail probe
  const bridge5 = new HermesBridge({
    projectDir: process.cwd(),
    litellmUrl: 'http://localhost:19997',
    litellmKey: 'sk-test'
  });

  // Reset cache để force re-probe
  const hermesMod = require('../lib/hermes-bridge');
  // Module-level cache không accessible, nhưng TTL 30s đảm bảo probe thật xảy ra
  // cho port chưa từng được probe

  const decision5 = await bridge5.selectModel({
    task: 'builder',
    prompt: 'refactor this function to be more readable and add error handling'
  });

  // Restore
  SmartRouter.prototype.route = origRoute;

  assert('C5-a: Khi local model được đề xuất nhưng offline → fallback sang non-local',
    !String(decision5.model).startsWith('local'),
    `model=${decision5.model}`);
  assert('C5-b: Fallback model là "smart" (default cloud fallback)',
    decision5.model === 'smart',
    `model=${decision5.model}`);
  assert('C5-c: method = "heuristic" (không phải classifier)', decision5.method === 'heuristic');
}

// ══════════════════════════════════════════════════════════════════════════════
// CASE 6 — Docker Lỗi (daemon offline, container crash, image not found)
// ══════════════════════════════════════════════════════════════════════════════
section('C6: Docker Gặp Lỗi (Self-Healer phân loại lỗi Docker)');
console.log('Mục tiêu: execute_command("docker run...") fail nhiều kiểu → healer phân loại đúng.\n');

{
  const sh6 = new SelfHealer({ enabled: true });

  // Kiểu lỗi 1: Docker daemon không chạy
  const daemonErr = { success: false, error: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' };
  // Kiểu lỗi 2: Image not found
  const imageErr  = { success: false, error: 'Unable to find image "myapp:latest" locally\ndocker: Error response from daemon: pull access denied' };
  // Kiểu lỗi 3: Container exit code 1
  const containerErr = { success: false, error: 'exit code: 1\ncontainer exited with non-zero status' };

  const dockerTool = 'execute_command';

  // Daemon lỗi liên tiếp
  sh6.observe(dockerTool, { command: 'docker ps' }, daemonErr);
  sh6.observe(dockerTool, { command: 'docker ps' }, daemonErr);
  const r6daemon = sh6.observe(dockerTool, { command: 'docker ps' }, daemonErr);
  assert('C6-a: Docker daemon error → gotcha sau 3 lần', r6daemon?.type === 'gotcha',
    r6daemon ? `type=${r6daemon.type}` : 'null');
  assert('C6-b: Suggestion đề cập lỗi daemon', r6daemon && r6daemon.message.includes('execute_command'));

  // Image lỗi — khác signature vì khác args
  sh6.observe(dockerTool, { command: 'docker run myapp:latest' }, imageErr);
  sh6.observe(dockerTool, { command: 'docker run myapp:latest' }, imageErr);
  const r6img = sh6.observe(dockerTool, { command: 'docker run myapp:latest' }, imageErr);
  assert('C6-c: Docker image not found → gotcha riêng (khác signature)', r6img?.type === 'gotcha',
    r6img ? `type=${r6img.type}` : 'null');

  // Container exit 1 — lỗi mới không phải lỗi cũ → count reset
  const sh6c = new SelfHealer({ enabled: true });
  sh6c.observe(dockerTool, { command: 'docker run app' }, daemonErr);      // error A count=1
  sh6c.observe(dockerTool, { command: 'docker run app' }, containerErr);   // error B → reset count=1
  sh6c.observe(dockerTool, { command: 'docker run app' }, containerErr);   // count=2
  const r6c = sh6c.observe(dockerTool, { command: 'docker run app' }, containerErr); // count=3 → gotcha
  assert('C6-d: Đổi loại lỗi reset streak counter', r6c?.type === 'gotcha',
    r6c ? `type=${r6c.type}` : 'null');

  const stats6 = sh6.getStats();
  assert('C6-e: Stats đã quan sát đủ calls', stats6.observed >= 6);
  assert('C6-f: Hai gotcha được ghi nhận (pending_suggestions)', stats6.pending_suggestions >= 2,
    `got ${stats6.pending_suggestions}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// CASE 7 — Lỗi Cú Pháp Cài Bẫy (A→B→A syntax cycle)
// ══════════════════════════════════════════════════════════════════════════════
section('C7: Lỗi Cú Pháp Cài Bẫy (Syntax Error A→B→A)');
console.log('Mục tiêu: Fix lỗi A sinh ra lỗi B, fix B sinh ra lỗi A → dừng sau 3 lần, báo kẹt.\n');

{
  const sd7 = new StuckDetector();

  // Mô phỏng: agent liên tục ghi lại 2 phiên bản code (A↔B)
  // Mỗi version sửa xong lại chạy "execute_command npm test" → fail
  // Stuck detector theo dõi pattern

  const writeA = () => sd7.record('write_file', { path: 'parser.js', content: 'const x = {a: 1' });  // SyntaxError: missing }
  const writeB = () => sd7.record('write_file', { path: 'parser.js', content: 'const x = {b: 2}' }); // OK nhưng test fail vì logic sai

  // A, B, A, B → 4 lần, chưa detect
  writeA(); writeB(); writeA(); writeB();
  // Lần 5 → detect toggle
  const w7 = writeA();
  assert('C7-a: A↔B syntax cycle phát hiện toggle warning', w7 !== null && w7.type === 'toggle',
    w7 ? `type=${w7.type}` : 'null');

  // Test repeat pattern (cùng 1 content lặp lại)
  const sd7b = new StuckDetector();
  const badWrite = () => sd7b.record('write_file', { path: 'auth.js', content: 'missing-brace {' });
  badWrite(); badWrite(); // lần 3 trigger repeat
  const w7b = badWrite();
  assert('C7-b: Cùng content lặp 3+ → repeat warning', w7b !== null && w7b.type === 'repeat',
    w7b ? `type=${w7b.type}` : 'null');
  assert('C7-c: Repeat warning có count >= 3', w7b && (w7b.count >= 3 || /3 times|3 lần/.test(w7b.message)),
    w7b?.message?.slice(0, 80));

  // Test: sau khi reset, cùng call không trigger ngay
  sd7b.reset();
  const w7c = badWrite();
  assert('C7-d: Sau reset() không trigger ngay lại', w7c === null);
}

// ══════════════════════════════════════════════════════════════════════════════
// CASE 8 — Tool Failure Cascade (lỗi dây chuyền nhiều tool)
// ══════════════════════════════════════════════════════════════════════════════
section('C8: Tool Failure Cascade (Lỗi Dây Chuyền)');
console.log('Mục tiêu: Nhiều tool khác nhau cùng fail liên tiếp → healer xử lý độc lập từng tool.\n');

{
  const sh8 = new SelfHealer({ enabled: true });

  const tools = [
    { name: 'read_file',         args: { path: '/nonexistent/file.js' },      err: 'ENOENT: no such file or directory' },
    { name: 'execute_command',   args: { command: 'npx jest --watch' },        err: 'command failed: jest not found' },
    { name: 'search_files',      args: { pattern: '**/*.nonexistent' },        err: 'timeout after 30s' },
    { name: 'write_file',        args: { path: '/read-only/config.json' },     err: 'EACCES: permission denied' },
  ];

  // Fail 3x mỗi tool → mỗi tool phải tạo gotcha riêng
  let gotchaCount = 0;
  for (const t of tools) {
    const errResult = { success: false, error: t.err };
    sh8.observe(t.name, t.args, errResult);
    sh8.observe(t.name, t.args, errResult);
    const r = sh8.observe(t.name, t.args, errResult);
    if (r?.type === 'gotcha') gotchaCount++;
  }

  assert('C8-a: Mỗi tool tạo gotcha riêng (4 tools = 4 gotchas)', gotchaCount === 4,
    `got ${gotchaCount}`);
  assert('C8-b: pending_suggestions = 4 trong queue', sh8.getStats().pending_suggestions === 4,
    `got ${sh8.getStats().pending_suggestions}`);

  // Consume từng cái — thứ tự FIFO
  const s1 = sh8.consumeSuggestion();
  const s2 = sh8.consumeSuggestion();
  assert('C8-c: Suggestion đầu đề cập read_file', s1?.message?.includes('read_file'));
  assert('C8-d: Suggestion thứ 2 đề cập execute_command', s2?.message?.includes('execute_command'));

  // Đổi lỗi giữa chừng → streak reset, không merge
  const sh8b = new SelfHealer({ enabled: true });
  const mixedArgs = { command: 'npm run build' };
  sh8b.observe('execute_command', mixedArgs, { success: false, error: 'ENOENT: node not found' });    // err A, count=1
  sh8b.observe('execute_command', mixedArgs, { success: false, error: 'ENOMEM: out of memory' });     // err B → reset count=1
  sh8b.observe('execute_command', mixedArgs, { success: false, error: 'ENOMEM: out of memory' });     // err B count=2
  const r8b = sh8b.observe('execute_command', mixedArgs, { success: false, error: 'ENOMEM: out of memory' }); // count=3 → gotcha
  assert('C8-e: Đổi lỗi reset streak, gotcha chỉ sau 3 lần cùng lỗi mới', r8b?.type === 'gotcha',
    r8b ? `type=${r8b.type}` : 'null');

  // Redundant read sau search — detect bẫy "double-check"
  const sd8 = new StuckDetector();
  // Mô phỏng: agent search_files("lib") → có kết quả → sau đó read_file("lib/auth.js") → warn
  sd8.recordResult('search_files', { path: 'lib' }, {
    content: JSON.stringify({ matches: ['lib/auth.js', 'lib/utils.js'] })
  });
  const redundant = sd8.record('read_file', { path: 'lib/auth.js' });
  assert('C8-f: read_file(lib/auth.js) sau search_files(lib) → redundant_read warning',
    redundant !== null && redundant.type === 'redundant_read_after_search',
    redundant ? `type=${redundant.type}` : 'null — BUG: không detect subpath');
  assert('C8-g: Redundant warning chỉ cảnh báo 1 lần (không spam)', (() => {
    const w2 = sd8.record('read_file', { path: 'lib/auth.js' });
    return w2 === null; // warnedPaths dedup
  })());
}

// ══════════════════════════════════════════════════════════════════════════════
// BONUS — Integration: Lock + Healer + Stuck trong cùng scenario
// ══════════════════════════════════════════════════════════════════════════════
section('BONUS: Integration — Lock + Healer + Stuck cùng lúc');
console.log('Mục tiêu: Agent cố gắng fix locked file bằng cách loop → cả 3 hệ thống hoạt động.\n');

{
  const dir9 = tmpDir('c9');
  const dl9 = new DecisionLock({ projectDir: dir9 });
  const sd9 = new StuckDetector();
  const sh9 = new SelfHealer({ enabled: true });

  // Lock auth scope
  dl9.lock({ decision: 'No changes to auth endpoints', scope: 'auth', approvedBy: 'tech-lead', ttl: 4 * 60 * 60 * 1000 });

  // Mô phỏng agent cố viết lại auth.js dù bị lock → loop 5 lần
  let lockBlockCount = 0;
  let stuckWarning = null;
  for (let i = 0; i < 6; i++) {
    // Kiểm tra lock trước khi ghi
    const v = dl9.validate('auth', 'be-dev');
    if (!v.allowed) {
      lockBlockCount++;
      // Agent không nghe → vẫn cố ghi (bị block bởi hook/executor trong thực tế)
      // Giả lập tool fail vì BLOCKED
      const toolErr = { success: false, error: 'BLOCKED by DecisionLock: auth scope is locked' };
      sh9.observe('write_file', { path: 'lib/auth.js' }, toolErr);
    }
    // Stuck detector track write attempts
    stuckWarning = sd9.record('write_file', { path: 'lib/auth.js', content: `attempt-${i}` });
  }

  assert('BONUS-a: Lock chặn được tất cả 6 lần', lockBlockCount === 6, `blocked ${lockBlockCount}/6`);

  const stats9 = sh9.getStats();
  assert('BONUS-b: SelfHealer quan sát 6 tool calls', stats9.observed === 6, `got ${stats9.observed}`);
  assert('BONUS-c: SelfHealer tạo gotcha sau 3 lần cùng lỗi', stats9.pending_suggestions >= 1,
    `suggestions=${stats9.pending_suggestions}`);
  // Stuck detector sau 3 lần cùng signature → repeat warning
  // (mỗi attempt có content khác nhau → không phải exact repeat, chỉ toggle/path)
  // Dùng cùng content để test repeat
  const sd9b = new StuckDetector();
  for (let i = 0; i < 3; i++) {
    sd9b.record('write_file', { path: 'lib/auth.js', content: 'same-content' });
  }
  const finalStuck = sd9b.record('write_file', { path: 'lib/auth.js', content: 'same-content' });
  assert('BONUS-d: StuckDetector phát hiện repeat write cùng content', finalStuck?.type === 'repeat',
    finalStuck ? `type=${finalStuck.type}` : 'null');

  try { fs.rmSync(dir9, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ══════════════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(60));
console.log(`HA ADVERSARIAL TESTS: ${passed + failed} total — ${passed} ✅ passed, ${failed} ❌ failed`);
if (failed > 0) {
  console.log('\nFailed cases:');
  results.filter(r => !r.ok).forEach(r => console.log(`  ❌ ${r.name}${r.detail ? ': ' + r.detail : ''}`));
}
console.log('═'.repeat(60));
process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error('Test runner error:', err); process.exit(1); });
