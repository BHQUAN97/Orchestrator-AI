#!/usr/bin/env node
/**
 * Fuzz Test — Tool Edge-Case & Crash Detection
 *
 * Phase 3 fuzz test: ~30 tools × 3-5 cases = 120+ test cases
 * Muc dich: phat hien CRASH, WRONG_SHAPE, NO_VALIDATION
 *
 * Chay: node --test test/fuzz-tools.test.js
 *
 * Budget: $0 — khong goi LLM/web that
 * Windows-specific: check process.platform truoc khi test
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// =====================================================
// Setup: tao ToolExecutor wrapper de dispatch tool theo ten
// =====================================================

const PROJECT_DIR = path.resolve(__dirname, '..');

// Lazy import executors truc tiep (khong qua LLM loop)
const { FileManager } = require('../tools/file-manager');
const { TerminalRunner } = require('../tools/terminal-runner');
const { glob } = require('../tools/glob-tool');
const { batchEdit } = require('../tools/batch-edit');
const { AgentTodoStore, todoWrite, todoList } = require('../tools/agent-todos');
const { memorySave, memoryRecall, memoryList } = require('../tools/memory-tools');

let AST = {};
try { AST = require('../tools/ast-parse'); } catch (_) {}

let GIT_ADV = null;
try { GIT_ADV = require('../tools/git-advanced'); } catch (_) {}

let EMBED = null;
try { EMBED = require('../tools/embedding-search'); } catch (_) {}

let { bgList, bgOutput, bgKill } = { bgList: null, bgOutput: null, bgKill: null };
try {
  const bgMod = require('../tools/background-bash');
  bgList = bgMod.bgList;
  bgOutput = bgMod.bgOutput;
  bgKill = bgMod.bgKill;
} catch (_) {}

let { webFetch, webSearch } = { webFetch: null, webSearch: null };
try {
  const webMod = require('../tools/web-tools');
  webFetch = webMod.webFetch;
  webSearch = webMod.webSearch;
} catch (_) {}

let WIN = {};
try {
  if (process.platform === 'win32') WIN = require('../tools/windows');
} catch (_) {}

// =====================================================
// Helpers
// =====================================================

const fm = new FileManager({ projectDir: PROJECT_DIR });
const tr = new TerminalRunner({ projectDir: PROJECT_DIR });
const todoStore = new AgentTodoStore();

// Temp dir cho write tests
let TMPDIR;
before(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-'));
  // Ghi 1 file tam trong project de test edit_file
  fs.writeFileSync(path.join(TMPDIR, 'fuzz-target.txt'), 'hello world\nfoo bar\n', 'utf-8');
});

after(() => {
  try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch (_) {}
});

/**
 * Helper: assert result la object co success property
 */
function assertShape(result, label) {
  assert.ok(result !== null && result !== undefined, `${label}: result is null/undefined`);
  assert.ok(typeof result === 'object', `${label}: result is not object, got ${typeof result}`);
  // Moi tool phai tra ve object co hoac success hoac error hoac ok
  const hasContract = 'success' in result || 'error' in result || 'ok' in result;
  assert.ok(hasContract, `${label}: WRONG_SHAPE — no success/error/ok field. Keys: ${Object.keys(result).join(',')}`);
}

function assertGracefulFail(result, label) {
  assertShape(result, label);
  const isGraceful = result.success === false || result.ok === false || typeof result.error === 'string';
  assert.ok(isGraceful, `${label}: NO_VALIDATION — invalid input accepted without error. Got: ${JSON.stringify(result).slice(0, 200)}`);
}

// =====================================================
// 1. FILE MANAGER — read_file
// =====================================================

test('fuzz read_file — valid file (package.json)', async () => {
  const r = await fm.readFile({ path: 'package.json' });
  assertShape(r, 'read_file:valid');
  assert.equal(r.success, true, 'should succeed on valid file');
  assert.ok(typeof r.content === 'string', 'should have content string');
});

test('fuzz read_file — empty path', async () => {
  const r = await fm.readFile({ path: '' });
  assertShape(r, 'read_file:empty-path');
  assertGracefulFail(r, 'read_file:empty-path');
});

test('fuzz read_file — null path', async () => {
  let r;
  try {
    r = await fm.readFile({ path: null });
    assertShape(r, 'read_file:null-path');
    assertGracefulFail(r, 'read_file:null-path');
  } catch (err) {
    assert.fail(`CRASH read_file null path: ${err.message}`);
  }
});

test('fuzz read_file — path traversal ../../../etc/passwd', async () => {
  const r = await fm.readFile({ path: '../../../etc/passwd' });
  assertShape(r, 'read_file:traversal');
  assertGracefulFail(r, 'read_file:traversal');
});

test('fuzz read_file — unicode path (日本語.txt)', async () => {
  let r;
  try {
    r = await fm.readFile({ path: '日本語.txt' });
    assertShape(r, 'read_file:unicode');
    // Either succeeds (file exists) or gracefully fails (not found)
    assert.ok('success' in r, 'should have success field');
  } catch (err) {
    assert.fail(`CRASH read_file unicode path: ${err.message}`);
  }
});

test('fuzz read_file — negative offset', async () => {
  let r;
  try {
    r = await fm.readFile({ path: 'package.json', offset: -999 });
    assertShape(r, 'read_file:negative-offset');
    // Should not crash
  } catch (err) {
    assert.fail(`CRASH read_file negative offset: ${err.message}`);
  }
});

test('fuzz read_file — enormous limit', async () => {
  let r;
  try {
    r = await fm.readFile({ path: 'package.json', limit: 999999999 });
    assertShape(r, 'read_file:huge-limit');
  } catch (err) {
    assert.fail(`CRASH read_file huge limit: ${err.message}`);
  }
});

test('fuzz read_file — sensitive file (.env)', async () => {
  const r = await fm.readFile({ path: '.env' });
  assertShape(r, 'read_file:sensitive');
  assertGracefulFail(r, 'read_file:sensitive');
});

// =====================================================
// 2. FILE MANAGER — write_file
// =====================================================

test('fuzz write_file — valid write (temp file in project)', async () => {
  // write_file checks projectDir, so we need to create an fm with TMPDIR as projectDir
  // But TMPDIR is outside project. Use a file inside project tmp
  const tmpInProject = path.join(PROJECT_DIR, '.orcai', 'fuzz-tmp-write-test.txt');
  const fmLocal = new FileManager({ projectDir: PROJECT_DIR });
  try {
    const r = await fmLocal.writeFile({ path: '.orcai/fuzz-tmp-write-test.txt', content: 'fuzz test content' });
    assertShape(r, 'write_file:valid');
    assert.equal(r.success, true, 'should succeed');
  } catch (err) {
    assert.fail(`CRASH write_file valid: ${err.message}`);
  } finally {
    try { fs.unlinkSync(tmpInProject); } catch (_) {}
  }
});

test('fuzz write_file — path traversal', async () => {
  const r = await fm.writeFile({ path: '../../../tmp/evil.txt', content: 'evil' });
  assertShape(r, 'write_file:traversal');
  assertGracefulFail(r, 'write_file:traversal');
});

test('fuzz write_file — empty path', async () => {
  let r;
  try {
    r = await fm.writeFile({ path: '', content: 'test' });
    assertShape(r, 'write_file:empty-path');
    assertGracefulFail(r, 'write_file:empty-path');
  } catch (err) {
    assert.fail(`CRASH write_file empty path: ${err.message}`);
  }
});

test('fuzz write_file — null content', async () => {
  let r;
  try {
    r = await fm.writeFile({ path: '.orcai/fuzz-null-content.txt', content: null });
    assertShape(r, 'write_file:null-content');
    // If it doesn't fail, check success
  } catch (err) {
    assert.fail(`CRASH write_file null content: ${err.message}`);
  }
});

test('fuzz write_file — sensitive file (.env)', async () => {
  const r = await fm.writeFile({ path: '.env', content: 'SECRET=evil' });
  assertShape(r, 'write_file:sensitive');
  assertGracefulFail(r, 'write_file:sensitive');
});

// =====================================================
// 3. FILE MANAGER — edit_file
// =====================================================

test('fuzz edit_file — old_string not found', async () => {
  const r = await fm.editFile({ path: 'package.json', old_string: 'NONEXISTENT_STRING_ZXQWERTY', new_string: 'replacement' });
  assertShape(r, 'edit_file:not-found');
  assertGracefulFail(r, 'edit_file:not-found');
});

test('fuzz edit_file — file not found', async () => {
  const r = await fm.editFile({ path: 'nonexistent-fuzz-file.txt', old_string: 'x', new_string: 'y' });
  assertShape(r, 'edit_file:file-not-found');
  assertGracefulFail(r, 'edit_file:file-not-found');
});

test('fuzz edit_file — empty old_string', async () => {
  let r;
  try {
    r = await fm.editFile({ path: 'package.json', old_string: '', new_string: 'replacement' });
    assertShape(r, 'edit_file:empty-old-string');
    // Empty string matches everywhere — should fail with occurrences error or succeed with replace_all logic
  } catch (err) {
    assert.fail(`CRASH edit_file empty old_string: ${err.message}`);
  }
});

test('fuzz edit_file — null old_string', async () => {
  let r;
  try {
    r = await fm.editFile({ path: 'package.json', old_string: null, new_string: 'y' });
    assertShape(r, 'edit_file:null-old-string');
  } catch (err) {
    assert.fail(`CRASH edit_file null old_string: ${err.message}`);
  }
});

test('fuzz edit_file — path traversal', async () => {
  const r = await fm.editFile({ path: '../../etc/passwd', old_string: 'root', new_string: 'hacked' });
  assertShape(r, 'edit_file:traversal');
  assertGracefulFail(r, 'edit_file:traversal');
});

// =====================================================
// 4. FILE MANAGER — list_files
// =====================================================

test('fuzz list_files — valid dir', async () => {
  const r = await fm.listFiles({ path: '.' });
  assertShape(r, 'list_files:valid');
  assert.equal(r.success, true);
  assert.ok(Array.isArray(r.files));
});

test('fuzz list_files — nonexistent dir', async () => {
  const r = await fm.listFiles({ path: 'nonexistent-fuzz-dir-zxqwerty' });
  assertShape(r, 'list_files:nonexistent');
  assertGracefulFail(r, 'list_files:nonexistent');
});

test('fuzz list_files — traversal', async () => {
  const r = await fm.listFiles({ path: '../../../' });
  assertShape(r, 'list_files:traversal');
  assertGracefulFail(r, 'list_files:traversal');
});

test('fuzz list_files — invalid pattern', async () => {
  let r;
  try {
    r = await fm.listFiles({ path: '.', pattern: '[invalid-regex' });
    assertShape(r, 'list_files:invalid-pattern');
    // Should fail gracefully or succeed (fast-glob handles invalid patterns)
  } catch (err) {
    assert.fail(`CRASH list_files invalid pattern: ${err.message}`);
  }
});

// =====================================================
// 5. FILE MANAGER — search_files
// =====================================================

test('fuzz search_files — valid search', async () => {
  const r = await fm.searchFiles({ pattern: 'executor', path: '.' });
  assertShape(r, 'search_files:valid');
  assert.equal(r.success, true);
  assert.ok(Array.isArray(r.results));
});

test('fuzz search_files — invalid regex', async () => {
  let r;
  try {
    r = await fm.searchFiles({ pattern: '[invalid-regex-zxq((' });
    assertShape(r, 'search_files:invalid-regex');
    // May succeed (regex might fail but method should catch)
  } catch (err) {
    assert.fail(`CRASH search_files invalid regex: ${err.message}`);
  }
});

test('fuzz search_files — empty pattern', async () => {
  let r;
  try {
    r = await fm.searchFiles({ pattern: '' });
    assertShape(r, 'search_files:empty-pattern');
  } catch (err) {
    assert.fail(`CRASH search_files empty pattern: ${err.message}`);
  }
});

test('fuzz search_files — traversal path', async () => {
  const r = await fm.searchFiles({ pattern: 'password', path: '../../../' });
  assertShape(r, 'search_files:traversal');
  assertGracefulFail(r, 'search_files:traversal');
});

// =====================================================
// 6. GLOB TOOL
// =====================================================

test('fuzz glob — valid pattern', async () => {
  const r = await glob({ pattern: '**/*.js' }, PROJECT_DIR);
  assertShape(r, 'glob:valid');
  assert.equal(r.success, true);
  assert.ok(Array.isArray(r.files));
});

test('fuzz glob — missing pattern', async () => {
  const r = await glob({}, PROJECT_DIR);
  assertShape(r, 'glob:missing-pattern');
  assertGracefulFail(r, 'glob:missing-pattern');
});

test('fuzz glob — traversal path', async () => {
  const r = await glob({ pattern: '**/*.js', path: '../../../' }, PROJECT_DIR);
  assertShape(r, 'glob:traversal');
  assertGracefulFail(r, 'glob:traversal');
});

test('fuzz glob — nonexistent path', async () => {
  const r = await glob({ pattern: '*.txt', path: 'nonexistent-fuzz-dir' }, PROJECT_DIR);
  assertShape(r, 'glob:nonexistent-dir');
  assertGracefulFail(r, 'glob:nonexistent-dir');
});

test('fuzz glob — null pattern', async () => {
  let r;
  try {
    r = await glob({ pattern: null }, PROJECT_DIR);
    assertShape(r, 'glob:null-pattern');
    assertGracefulFail(r, 'glob:null-pattern');
  } catch (err) {
    assert.fail(`CRASH glob null pattern: ${err.message}`);
  }
});

// =====================================================
// 7. EXECUTE_COMMAND (terminal-runner)
// =====================================================

test('fuzz execute_command — valid safe command', async () => {
  const r = await tr.executeCommand({ command: 'echo hello' });
  assertShape(r, 'exec:valid');
  assert.equal(r.success, true);
  assert.ok(typeof r.stdout === 'string');
});

test('fuzz execute_command — empty command', async () => {
  let r;
  try {
    r = await tr.executeCommand({ command: '' });
    assertShape(r, 'exec:empty-cmd');
    // Should fail or succeed with empty output
  } catch (err) {
    assert.fail(`CRASH execute_command empty: ${err.message}`);
  }
});

test('fuzz execute_command — null command', async () => {
  let r;
  try {
    r = await tr.executeCommand({ command: null });
    assertShape(r, 'exec:null-cmd');
  } catch (err) {
    assert.fail(`CRASH execute_command null: ${err.message}`);
  }
});

test('fuzz execute_command — blocked (rm -rf /)', async () => {
  const r = await tr.executeCommand({ command: 'rm -rf /' });
  assertShape(r, 'exec:blocked-rmrf');
  assertGracefulFail(r, 'exec:blocked-rmrf');
});

test('fuzz execute_command — fork bomb pattern', async () => {
  const r = await tr.executeCommand({ command: ':(){ :|:& };:' });
  assertShape(r, 'exec:fork-bomb');
  assertGracefulFail(r, 'exec:fork-bomb');
});

test('fuzz execute_command — timeout exceeded (very short)', async () => {
  let r;
  try {
    r = await tr.executeCommand({ command: 'node -e "setTimeout(()=>{},60000)"', timeout: 500 });
    assertShape(r, 'exec:timeout');
    // Should complete eventually with timeout error or exit_code
  } catch (err) {
    assert.fail(`CRASH execute_command timeout: ${err.message}`);
  }
});

test('fuzz execute_command — negative timeout', async () => {
  let r;
  try {
    r = await tr.executeCommand({ command: 'echo hi', timeout: -1 });
    assertShape(r, 'exec:negative-timeout');
  } catch (err) {
    assert.fail(`CRASH execute_command negative timeout: ${err.message}`);
  }
});

// =====================================================
// 8. BATCH EDIT (edit_files)
// =====================================================

test('fuzz edit_files — empty edits array', async () => {
  const r = await batchEdit({ edits: [] }, fm);
  assertShape(r, 'edit_files:empty-array');
  assertGracefulFail(r, 'edit_files:empty-array');
});

test('fuzz edit_files — not array', async () => {
  let r;
  try {
    r = await batchEdit({ edits: 'not-an-array' }, fm);
    assertShape(r, 'edit_files:not-array');
    assertGracefulFail(r, 'edit_files:not-array');
  } catch (err) {
    assert.fail(`CRASH edit_files not-array: ${err.message}`);
  }
});

test('fuzz edit_files — too many edits (>50)', async () => {
  const edits = Array.from({ length: 60 }, (_, i) => ({
    path: `file${i}.txt`,
    old_string: 'x',
    new_string: 'y'
  }));
  const r = await batchEdit({ edits }, fm);
  assertShape(r, 'edit_files:too-many');
  assertGracefulFail(r, 'edit_files:too-many');
});

test('fuzz edit_files — missing path in edit item', async () => {
  const r = await batchEdit({ edits: [{ old_string: 'x', new_string: 'y' }] }, fm);
  assertShape(r, 'edit_files:missing-path');
  assertGracefulFail(r, 'edit_files:missing-path');
});

test('fuzz edit_files — null args', async () => {
  let r;
  try {
    r = await batchEdit(null, fm);
    assertShape(r, 'edit_files:null-args');
    assertGracefulFail(r, 'edit_files:null-args');
  } catch (err) {
    assert.fail(`CRASH edit_files null args: ${err.message}`);
  }
});

// =====================================================
// 9. TODO TOOLS
// =====================================================

test('fuzz todo_write — valid', () => {
  const r = todoWrite({ todos: [{ subject: 'Fix bug', status: 'pending' }] }, todoStore, null);
  assertShape(r, 'todo_write:valid');
  assert.equal(r.success, true);
});

test('fuzz todo_write — empty todos array', () => {
  const r = todoWrite({ todos: [] }, todoStore, null);
  assertShape(r, 'todo_write:empty');
  // Empty array: alguns tools return success:true com lista vazia, outros error
  assert.ok('success' in r, 'must have success field');
});

test('fuzz todo_write — not array', () => {
  const r = todoWrite({ todos: 'not-array' }, todoStore, null);
  assertShape(r, 'todo_write:not-array');
  assertGracefulFail(r, 'todo_write:not-array');
});

test('fuzz todo_write — null todos', () => {
  let r;
  try {
    r = todoWrite({ todos: null }, todoStore, null);
    assertShape(r, 'todo_write:null-todos');
    assertGracefulFail(r, 'todo_write:null-todos');
  } catch (err) {
    assert.fail(`CRASH todo_write null todos: ${err.message}`);
  }
});

test('fuzz todo_write — too many todos (>100)', () => {
  const todos = Array.from({ length: 110 }, (_, i) => ({ subject: `task ${i}` }));
  const r = todoWrite({ todos }, todoStore, null);
  assertShape(r, 'todo_write:too-many');
  assertGracefulFail(r, 'todo_write:too-many');
});

test('fuzz todo_list — basic call', () => {
  const r = todoList({}, todoStore);
  assertShape(r, 'todo_list:basic');
  assert.equal(r.success, true);
  assert.ok(Array.isArray(r.todos));
});

// =====================================================
// 10. MEMORY TOOLS (no store — simulate missing store)
// =====================================================

test('fuzz memory_save — no store', async () => {
  const r = await memorySave({ summary: 'test lesson' }, null);
  assertShape(r, 'memory_save:no-store');
  assertGracefulFail(r, 'memory_save:no-store');
});

test('fuzz memory_save — missing summary', async () => {
  const r = await memorySave({}, null);
  assertShape(r, 'memory_save:no-summary');
  assertGracefulFail(r, 'memory_save:no-summary');
});

test('fuzz memory_recall — no store', async () => {
  const r = await memoryRecall({ query: 'test' }, null);
  assertShape(r, 'memory_recall:no-store');
  assertGracefulFail(r, 'memory_recall:no-store');
});

test('fuzz memory_recall — missing query', async () => {
  const r = await memoryRecall({}, null);
  assertShape(r, 'memory_recall:no-query');
  assertGracefulFail(r, 'memory_recall:no-query');
});

test('fuzz memory_list — no store', async () => {
  const r = await memoryList({}, null);
  assertShape(r, 'memory_list:no-store');
  assertGracefulFail(r, 'memory_list:no-store');
});

// =====================================================
// 11. AST TOOLS
// =====================================================

test('fuzz ast_parse — valid JS file', async () => {
  if (!AST.astParse) {
    // Babel not loaded — skip gracefully
    return;
  }
  const r = await AST.astParse({ path: path.join(PROJECT_DIR, 'tools/file-manager.js') });
  assertShape(r, 'ast_parse:valid');
  assert.equal(r.success, true);
});

test('fuzz ast_parse — nonexistent file', async () => {
  if (!AST.astParse) return;
  const r = await AST.astParse({ path: 'nonexistent-fuzz-file-zxqwerty.js' });
  assertShape(r, 'ast_parse:nonexistent');
  assertGracefulFail(r, 'ast_parse:nonexistent');
});

test('fuzz ast_parse — unsupported extension (.txt)', async () => {
  if (!AST.astParse) return;
  const r = await AST.astParse({ path: 'README.md' });
  assertShape(r, 'ast_parse:unsupported-ext');
  assertGracefulFail(r, 'ast_parse:unsupported-ext');
});

test('fuzz ast_parse — missing path', async () => {
  if (!AST.astParse) return;
  let r;
  try {
    r = await AST.astParse({});
    assertShape(r, 'ast_parse:missing-path');
    assertGracefulFail(r, 'ast_parse:missing-path');
  } catch (err) {
    assert.fail(`CRASH ast_parse missing path: ${err.message}`);
  }
});

test('fuzz ast_find_symbol — valid', async () => {
  if (!AST.astFindSymbol) return;
  const r = await AST.astFindSymbol({
    path: path.join(PROJECT_DIR, 'tools/file-manager.js'),
    symbol_name: 'FileManager'
  });
  assertShape(r, 'ast_find_symbol:valid');
});

test('fuzz ast_find_symbol — nonexistent symbol', async () => {
  if (!AST.astFindSymbol) return;
  const r = await AST.astFindSymbol({
    path: path.join(PROJECT_DIR, 'tools/file-manager.js'),
    symbol_name: 'NonExistentSymbolZXQWERTY99999'
  });
  assertShape(r, 'ast_find_symbol:not-found');
  // Should succeed with empty results or gracefully fail
});

test('fuzz ast_find_symbol — missing symbol_name', async () => {
  if (!AST.astFindSymbol) return;
  let r;
  try {
    r = await AST.astFindSymbol({ path: path.join(PROJECT_DIR, 'tools/file-manager.js') });
    assertShape(r, 'ast_find_symbol:missing-symbol');
    assertGracefulFail(r, 'ast_find_symbol:missing-symbol');
  } catch (err) {
    assert.fail(`CRASH ast_find_symbol missing symbol_name: ${err.message}`);
  }
});

test('fuzz ast_find_usages — empty files array', async () => {
  if (!AST.astFindUsages) return;
  let r;
  try {
    r = await AST.astFindUsages({ symbol_name: 'FileManager', files: [] });
    assertShape(r, 'ast_find_usages:empty-files');
  } catch (err) {
    assert.fail(`CRASH ast_find_usages empty files: ${err.message}`);
  }
});

test('fuzz ast_find_usages — missing symbol_name', async () => {
  if (!AST.astFindUsages) return;
  let r;
  try {
    r = await AST.astFindUsages({ files: ['tools/file-manager.js'] });
    assertShape(r, 'ast_find_usages:missing-symbol');
    assertGracefulFail(r, 'ast_find_usages:missing-symbol');
  } catch (err) {
    assert.fail(`CRASH ast_find_usages missing symbol_name: ${err.message}`);
  }
});

test('fuzz ast_rename_symbol — dry_run (safe)', async () => {
  if (!AST.astRenameSymbol) return;
  const r = await AST.astRenameSymbol({
    path: path.join(PROJECT_DIR, 'tools/glob-tool.js'),
    old_name: 'glob',
    new_name: 'globTool',
    dry_run: true
  });
  assertShape(r, 'ast_rename_symbol:dry-run');
});

// =====================================================
// 12. GIT ADVANCED
// =====================================================

test('fuzz git_advanced — status action', async () => {
  if (!GIT_ADV) return;
  const r = await GIT_ADV.gitAdvanced({ action: 'status', cwd: PROJECT_DIR });
  assertShape(r, 'git_advanced:status');
  assert.equal(r.success, true);
});

test('fuzz git_advanced — log action', async () => {
  if (!GIT_ADV) return;
  const r = await GIT_ADV.gitAdvanced({ action: 'log', cwd: PROJECT_DIR, limit: 3 });
  assertShape(r, 'git_advanced:log');
  assert.equal(r.success, true);
});

test('fuzz git_advanced — missing action', async () => {
  if (!GIT_ADV) return;
  let r;
  try {
    r = await GIT_ADV.gitAdvanced({ cwd: PROJECT_DIR });
    assertShape(r, 'git_advanced:missing-action');
    assertGracefulFail(r, 'git_advanced:missing-action');
  } catch (err) {
    assert.fail(`CRASH git_advanced missing action: ${err.message}`);
  }
});

test('fuzz git_advanced — invalid cwd (not git repo)', async () => {
  if (!GIT_ADV) return;
  let r;
  try {
    r = await GIT_ADV.gitAdvanced({ action: 'status', cwd: os.tmpdir() });
    assertShape(r, 'git_advanced:non-git-cwd');
    assertGracefulFail(r, 'git_advanced:non-git-cwd');
  } catch (err) {
    assert.fail(`CRASH git_advanced non-git cwd: ${err.message}`);
  }
});

test('fuzz git_advanced — unknown action', async () => {
  if (!GIT_ADV) return;
  let r;
  try {
    r = await GIT_ADV.gitAdvanced({ action: 'nonexistent_action_zxqwerty', cwd: PROJECT_DIR });
    assertShape(r, 'git_advanced:unknown-action');
    assertGracefulFail(r, 'git_advanced:unknown-action');
  } catch (err) {
    assert.fail(`CRASH git_advanced unknown action: ${err.message}`);
  }
});

// =====================================================
// 13. EMBED TOOLS (no real LLM call — test with empty/missing store)
// =====================================================

test('fuzz embed_search — missing query', async () => {
  if (!EMBED) return;
  const store = EMBED.createEmbeddingStore({ projectDir: PROJECT_DIR, endpoint: 'http://localhost:9999', apiKey: 'test' });
  let r;
  try {
    r = await EMBED.embedSearch({ embeddingStore: store });
    assertShape(r, 'embed_search:missing-query');
    assertGracefulFail(r, 'embed_search:missing-query');
  } catch (err) {
    assert.fail(`CRASH embed_search missing query: ${err.message}`);
  }
});

test('fuzz embed_search — empty query', async () => {
  if (!EMBED) return;
  const store = EMBED.createEmbeddingStore({ projectDir: PROJECT_DIR, endpoint: 'http://localhost:9999', apiKey: 'test' });
  let r;
  try {
    r = await EMBED.embedSearch({ query: '', embeddingStore: store });
    assertShape(r, 'embed_search:empty-query');
    assertGracefulFail(r, 'embed_search:empty-query');
  } catch (err) {
    assert.fail(`CRASH embed_search empty query: ${err.message}`);
  }
});

test('fuzz embed_stats — fresh store (no index)', async () => {
  if (!EMBED) return;
  const store = EMBED.createEmbeddingStore({ projectDir: PROJECT_DIR, endpoint: 'http://localhost:9999', apiKey: 'test' });
  let r;
  try {
    // Signature dung: (args, ctx) — store trong ctx, KHONG trong args
    r = await EMBED.embedStats({}, { embeddingStore: store });
    assertShape(r, 'embed_stats:fresh');
    assert.equal(r.success, true, 'stats on fresh store should succeed');
  } catch (err) {
    assert.fail(`CRASH embed_stats fresh store: ${err.message}`);
  }
});

test('fuzz embed_clear — fresh store', async () => {
  if (!EMBED) return;
  const store = EMBED.createEmbeddingStore({ projectDir: PROJECT_DIR, endpoint: 'http://localhost:9999', apiKey: 'test' });
  let r;
  try {
    // Signature dung: (args, ctx) + can confirm:true vi embedClear co safety guard
    r = await EMBED.embedClear({ confirm: true }, { embeddingStore: store });
    assertShape(r, 'embed_clear:fresh');
    assert.equal(r.success, true, 'clear on fresh store should succeed');
  } catch (err) {
    assert.fail(`CRASH embed_clear fresh store: ${err.message}`);
  }
});

// =====================================================
// 14. BACKGROUND BASH
// =====================================================

test('fuzz bg_list — basic call', async () => {
  if (!bgList) return;
  let r;
  try {
    r = await bgList();
    assertShape(r, 'bg_list:basic');
    assert.equal(r.success, true);
    assert.ok(Array.isArray(r.processes));
  } catch (err) {
    assert.fail(`CRASH bg_list: ${err.message}`);
  }
});

test('fuzz bg_output — invalid pid', async () => {
  if (!bgOutput) return;
  let r;
  try {
    r = await bgOutput({ pid: 999999999 });
    assertShape(r, 'bg_output:invalid-pid');
    assertGracefulFail(r, 'bg_output:invalid-pid');
  } catch (err) {
    assert.fail(`CRASH bg_output invalid pid: ${err.message}`);
  }
});

test('fuzz bg_output — missing pid', async () => {
  if (!bgOutput) return;
  let r;
  try {
    r = await bgOutput({});
    assertShape(r, 'bg_output:missing-pid');
    assertGracefulFail(r, 'bg_output:missing-pid');
  } catch (err) {
    assert.fail(`CRASH bg_output missing pid: ${err.message}`);
  }
});

test('fuzz bg_kill — invalid pid', async () => {
  if (!bgKill) return;
  let r;
  try {
    r = await bgKill({ pid: 999999999 });
    assertShape(r, 'bg_kill:invalid-pid');
    assertGracefulFail(r, 'bg_kill:invalid-pid');
  } catch (err) {
    assert.fail(`CRASH bg_kill invalid pid: ${err.message}`);
  }
});

// =====================================================
// 15. WEB TOOLS — validation only (SKIP real fetch)
// =====================================================

test('fuzz web_fetch — missing url', async () => {
  if (!webFetch) return;
  const r = await webFetch({});
  assertShape(r, 'web_fetch:missing-url');
  assertGracefulFail(r, 'web_fetch:missing-url');
});

test('fuzz web_fetch — invalid url', async () => {
  if (!webFetch) return;
  const r = await webFetch({ url: 'not-a-valid-url-zxq' });
  assertShape(r, 'web_fetch:invalid-url');
  assertGracefulFail(r, 'web_fetch:invalid-url');
});

test('fuzz web_fetch — javascript: protocol (blocked)', async () => {
  if (!webFetch) return;
  const r = await webFetch({ url: 'javascript:alert(1)' });
  assertShape(r, 'web_fetch:js-protocol');
  assertGracefulFail(r, 'web_fetch:js-protocol');
});

test('fuzz web_fetch — file: protocol (blocked)', async () => {
  if (!webFetch) return;
  const r = await webFetch({ url: 'file:///etc/passwd' });
  assertShape(r, 'web_fetch:file-protocol');
  assertGracefulFail(r, 'web_fetch:file-protocol');
});

test('fuzz web_fetch — localhost SSRF (blocked by default)', async () => {
  if (!webFetch) return;
  const r = await webFetch({ url: 'http://localhost:3000/secret' });
  assertShape(r, 'web_fetch:ssrf-localhost');
  assertGracefulFail(r, 'web_fetch:ssrf-localhost');
});

test('fuzz web_fetch — private IP SSRF (192.168.x.x)', async () => {
  if (!webFetch) return;
  const r = await webFetch({ url: 'http://192.168.1.1/admin' });
  assertShape(r, 'web_fetch:ssrf-private-ip');
  assertGracefulFail(r, 'web_fetch:ssrf-private-ip');
});

test('fuzz web_search — missing query', async () => {
  if (!webSearch) return;
  const r = await webSearch({});
  assertShape(r, 'web_search:missing-query');
  assertGracefulFail(r, 'web_search:missing-query');
});

test('fuzz web_search — empty query', async () => {
  if (!webSearch) return;
  let r;
  try {
    r = await webSearch({ query: '' });
    assertShape(r, 'web_search:empty-query');
    // May or may not fail gracefully — DuckDuckGo may return results for empty
  } catch (err) {
    assert.fail(`CRASH web_search empty query: ${err.message}`);
  }
});

// =====================================================
// 16. WINDOWS TOOLS (skip on non-Windows)
// =====================================================

test('fuzz ps_command — missing script', async () => {
  if (process.platform !== 'win32' || !WIN.runPowerShell) return;
  let r;
  try {
    r = await WIN.runPowerShell({});
    assertShape(r, 'ps_command:missing-script');
    assertGracefulFail(r, 'ps_command:missing-script');
  } catch (err) {
    assert.fail(`CRASH ps_command missing script: ${err.message}`);
  }
});

test('fuzz clipboard_read — basic call', async () => {
  if (process.platform !== 'win32' || !WIN.readClipboard) return;
  let r;
  try {
    r = await WIN.readClipboard({});
    assertShape(r, 'clipboard_read:basic');
  } catch (err) {
    assert.fail(`CRASH clipboard_read: ${err.message}`);
  }
});

test('fuzz sys_info — basic call', async () => {
  if (process.platform !== 'win32' || !WIN.sysInfo) return;
  let r;
  try {
    r = await WIN.sysInfo({});
    assertShape(r, 'sys_info:basic');
    assert.equal(r.success, true);
  } catch (err) {
    assert.fail(`CRASH sys_info: ${err.message}`);
  }
});

test('fuzz registry_read — valid key', async () => {
  if (process.platform !== 'win32' || !WIN.registryGet) return;
  let r;
  try {
    r = await WIN.registryGet({ path: 'HKCU:\\Environment', valueName: 'Path' });
    assertShape(r, 'registry_read:valid');
  } catch (err) {
    assert.fail(`CRASH registry_read valid: ${err.message}`);
  }
});

test('fuzz registry_read — missing path', async () => {
  if (process.platform !== 'win32' || !WIN.registryGet) return;
  let r;
  try {
    r = await WIN.registryGet({});
    assertShape(r, 'registry_read:missing-path');
    assertGracefulFail(r, 'registry_read:missing-path');
  } catch (err) {
    assert.fail(`CRASH registry_read missing path: ${err.message}`);
  }
});
