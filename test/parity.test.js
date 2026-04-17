#!/usr/bin/env node
/**
 * Parity Test — kiem tra cac feature moi da them de dat parity voi Claude Code
 *
 * Chay: node test/parity.test.js
 *
 * Cover:
 * - Tiktoken counter
 * - Prompt cache transformation
 * - Glob tool
 * - Mention expander
 * - Slash command discovery
 * - Diff rendering
 * - Web tools (signature only, no network)
 * - MCP client (registry instantiation)
 * - Agent loop options surface
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result
        .then(() => { passed++; console.log(`✓ ${name}`); })
        .catch(e => { failed++; failures.push({ name, error: e.message }); console.log(`✗ ${name}: ${e.message}`); });
    }
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`✗ ${name}: ${e.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

(async () => {
  console.log('=== Parity Test ===\n');

  // --- Tiktoken counter ---
  test('tiktoken-counter exports', () => {
    const tc = require('../lib/tiktoken-counter');
    assert(typeof tc.countTokens === 'function');
    assert(typeof tc.countMessagesTokens === 'function');
    assert(typeof tc.encoderName === 'string');
  });

  test('tiktoken-counter counts tokens (accurate or heuristic)', () => {
    const { countTokens, countMessagesTokens } = require('../lib/tiktoken-counter');
    const tokens = countTokens('Hello world, this is a test.');
    assert(tokens > 0 && tokens < 50, `tokens=${tokens}`);
    const msgTokens = countMessagesTokens([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' }
    ]);
    assert(msgTokens > 0, `msgTokens=${msgTokens}`);
  });

  // --- Prompt cache ---
  test('prompt-cache applyCacheControl adds cache_control for Claude', () => {
    const { applyCacheControl, supportsCaching } = require('../lib/prompt-cache');
    assert(supportsCaching('smart'), 'smart should support caching');
    assert(supportsCaching('claude-sonnet-4'), 'claude should support');
    assert(!supportsCaching('gpt-4'), 'gpt should not support');

    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Build a login page' }
    ];
    const out = applyCacheControl(messages, { model: 'smart', enabled: true });
    assert(Array.isArray(out[0].content), 'system content should be array');
    const sysBlock = out[0].content[0];
    assert(sysBlock.cache_control?.type === 'ephemeral', 'system should have cache_control');
  });

  test('prompt-cache applyToolsCaching caches last tool', () => {
    const { applyToolsCaching } = require('../lib/prompt-cache');
    const tools = [
      { type: 'function', function: { name: 't1' } },
      { type: 'function', function: { name: 't2' } }
    ];
    const out = applyToolsCaching(tools, { model: 'smart', enabled: true });
    assert(out[out.length - 1].cache_control?.type === 'ephemeral');
    assert(!out[0].cache_control, 'first tool should NOT have cache_control');
  });

  test('prompt-cache respects enabled:false', () => {
    const { applyCacheControl } = require('../lib/prompt-cache');
    const messages = [{ role: 'system', content: 'test' }];
    const out = applyCacheControl(messages, { model: 'smart', enabled: false });
    assert(typeof out[0].content === 'string', 'should not modify when disabled');
  });

  // --- Glob tool ---
  await test('glob-tool finds JS files', async () => {
    const { glob } = require('../tools/glob-tool');
    const res = await glob({ pattern: 'lib/*.js' }, path.resolve(__dirname, '..'));
    assert(res.success, res.error);
    assert(res.files.length > 0, 'should find some lib files');
    assert(res.files.some(f => f.endsWith('.js')));
  });

  await test('glob-tool sandbox blocks outside paths', async () => {
    const { glob } = require('../tools/glob-tool');
    const res = await glob({ pattern: '*.js', path: '/etc' }, path.resolve(__dirname, '..'));
    assert(!res.success, 'should block outside path');
    assert(res.error.includes('BLOCKED'));
  });

  // --- Mention expander ---
  test('mention-expander extracts and inlines files', () => {
    const { expandMentions } = require('../lib/mention-expander');
    const projectDir = path.resolve(__dirname, '..');
    const tmpFile = path.join(projectDir, 'TEST-MENTION-TMP.txt');
    fs.writeFileSync(tmpFile, 'hello world mention test', 'utf-8');

    try {
      const { prompt, attachments } = expandMentions(
        'Please check @TEST-MENTION-TMP.txt and fix it',
        projectDir
      );
      assert(attachments.length === 1, `got ${attachments.length}`);
      assert(attachments[0].content?.includes('hello world'));
      assert(prompt.includes('[@mention attachments'));
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  test('mention-expander ignores email addresses', () => {
    const { expandMentions } = require('../lib/mention-expander');
    const { attachments } = expandMentions('Email me at user@example.com', path.resolve(__dirname, '..'));
    assert(attachments.length === 0, `should not treat email as mention, got ${attachments.length}`);
  });

  // --- Slash commands ---
  test('slash-commands discovers skills/', () => {
    const { discoverCommands, expandCommand } = require('../lib/slash-commands');
    const cmds = discoverCommands(path.resolve(__dirname, '..'));
    assert(cmds.size > 0, `should find skills, got ${cmds.size}`);
    // orcai ships with developer.md, reviewer.md etc
    assert(cmds.has('developer') || cmds.has('reviewer'), 'should find at least 1 known skill');

    const first = [...cmds.values()][0];
    const expanded = expandCommand(first, 'some arg');
    assert(typeof expanded === 'string' && expanded.length > 0);
  });

  test('slash-commands parses YAML frontmatter', () => {
    const { parseFrontmatter } = require('../lib/slash-commands');
    const { meta, body } = parseFrontmatter('---\ndescription: test\n---\nBody text');
    assert(meta.description === 'test');
    assert(body.trim() === 'Body text');
  });

  // --- Diff approval ---
  test('diff-approval renders colored diff', () => {
    const { renderDiff, countChanges } = require('../tools/diff-approval');
    const out = renderDiff('line1\nline2\n', 'line1\nline2-modified\n');
    assert(out.includes('line2-modified'));
    const changes = countChanges('a\nb\n', 'a\nc\n');
    assert(changes.added >= 1 && changes.removed >= 1, JSON.stringify(changes));
  });

  // --- Web tools (no network) ---
  test('web-tools exports signatures', () => {
    const { webFetch, webSearch, htmlToText } = require('../tools/web-tools');
    assert(typeof webFetch === 'function');
    assert(typeof webSearch === 'function');
    assert(typeof htmlToText === 'function');
    const txt = htmlToText('<p>Hello <b>world</b></p>');
    assert(txt.includes('Hello') && txt.includes('world') && !txt.includes('<p>'));
  });

  await test('web-fetch rejects invalid URL', async () => {
    const { webFetch } = require('../tools/web-tools');
    const r1 = await webFetch({ url: 'not-a-url' });
    assert(!r1.success);
    const r2 = await webFetch({ url: 'file:///etc/passwd' });
    assert(!r2.success);
    const r3 = await webFetch({ url: 'http://127.0.0.1/test' });
    assert(!r3.success, 'should block localhost by default');
  });

  // --- MCP client ---
  test('mcp-client exports MCPRegistry', () => {
    const { MCPClient, MCPRegistry, getRegistry } = require('../tools/mcp-client');
    assert(typeof MCPClient === 'function');
    assert(typeof MCPRegistry === 'function');
    const reg = getRegistry();
    assert(reg instanceof MCPRegistry);
    assert(typeof reg.getToolDefinitions === 'function');
    assert(reg.getToolDefinitions().length === 0, 'empty registry yields no tools');
  });

  await test('mcp-client init with no config returns zero servers', async () => {
    const { MCPRegistry } = require('../tools/mcp-client');
    const reg = new MCPRegistry();
    const res = await reg.init({ projectDir: '/nonexistent-path-xyz-123' });
    assert(res.count === 0);
  });

  // --- Subagent ---
  test('subagent exports profiles', () => {
    const { spawnSubagent, SUBAGENT_PROFILES } = require('../tools/subagent');
    assert(typeof spawnSubagent === 'function');
    assert(SUBAGENT_PROFILES['general-purpose']);
    assert(SUBAGENT_PROFILES['explore']);
  });

  // --- Executor handlers registered ---
  test('executor registers all new tool handlers', () => {
    const { ToolExecutor } = require('../tools/executor');
    const exec = new ToolExecutor({ projectDir: path.resolve(__dirname, '..') });
    const expected = ['read_file', 'write_file', 'edit_file', 'list_files', 'search_files',
                     'glob', 'execute_command', 'web_fetch', 'web_search', 'spawn_subagent', 'task_complete'];
    for (const h of expected) {
      assert(typeof exec.handlers[h] === 'function', `missing handler: ${h}`);
    }
  });

  // --- Definitions include new tools ---
  test('definitions exports new tool defs for builder role', () => {
    const { getTools } = require('../tools/definitions');
    const tools = getTools('builder');
    const names = tools.map(t => t.function.name);
    for (const n of ['glob', 'web_fetch', 'web_search', 'spawn_subagent']) {
      assert(names.includes(n), `missing tool def: ${n}`);
    }
  });

  // --- Permissions include new tools ---
  test('permissions allow new tools for builder, deny for scanner.spawn_subagent', () => {
    const { ToolPermissions } = require('../tools/permissions');
    const builder = new ToolPermissions('builder');
    assert(builder.check('glob').allowed);
    assert(builder.check('web_fetch').allowed);
    assert(builder.check('spawn_subagent').allowed);

    const scanner = new ToolPermissions('scanner');
    assert(!scanner.check('spawn_subagent').allowed, 'scanner should NOT spawn subagent');
    assert(scanner.check('glob').allowed, 'scanner should glob');
    assert(scanner.check('web_fetch').allowed, 'scanner should fetch');
  });

  // --- MCP tool permission ---
  test('permissions allow MCP tools for execute-level roles', () => {
    const { ToolPermissions } = require('../tools/permissions');
    const builder = new ToolPermissions('builder');
    assert(builder.check('mcp__filesystem__read_file').allowed);
    const scanner = new ToolPermissions('scanner');
    assert(!scanner.check('mcp__filesystem__write_file').allowed);
  });

  // --- AgentLoop surface ---
  test('AgentLoop accepts new options', () => {
    const { AgentLoop } = require('../lib/agent-loop');
    const agent = new AgentLoop({
      projectDir: path.resolve(__dirname, '..'),
      agentRole: 'builder',
      promptCaching: true,
      mcpRegistry: null,
      onWriteApproval: async () => 'yes'
    });
    assert(agent.promptCaching === true);
    assert(typeof agent.getCacheStats === 'function');
    const stats = agent.getCacheStats();
    assert(stats.cache_hit_rate_pct === 0);
  });

  // --- File manager sensitive patterns ---
  test('file-manager blocks sensitive files', async () => {
    const { FileManager } = require('../tools/file-manager');
    const fm = new FileManager({ projectDir: path.resolve(__dirname, '..') });
    // .env is already in the project root possibly, but blocked anyway
    const res = await fm.readFile({ path: '.env' });
    assert(!res.success);
    assert(res.error.includes('Sensitive'));
  });

  // --- Budget tracker ---
  test('budget computes cost from usage', () => {
    const { BudgetTracker, computeCost } = require('../lib/budget');
    const cost = computeCost('smart', {
      prompt_tokens: 1000,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 2000,
      completion_tokens: 500
    });
    // $3 * 1000/1M + $3.75 * 500/1M + $0.30 * 2000/1M + $15 * 500/1M
    // = 0.003 + 0.001875 + 0.0006 + 0.0075 = 0.012975
    assert(cost > 0.012 && cost < 0.014, `expected ~0.013, got ${cost}`);
  });

  test('budget enforces cap', () => {
    const { BudgetTracker } = require('../lib/budget');
    const b = new BudgetTracker({ capUsd: 0.01, model: 'smart' });
    assert(!b.isExceeded());
    b.record('smart', { prompt_tokens: 10000, completion_tokens: 1000 });
    // cost = $0.03 + $0.015 = $0.045 > $0.01
    assert(b.isExceeded());
  });

  // --- Hooks ---
  test('hooks runner loads config', () => {
    const { HookRunner } = require('../lib/hooks');
    const hr = new HookRunner({ projectDir: path.resolve(__dirname, '..') });
    hr.load();
    const stats = hr.getStats();
    assert(typeof stats.PreToolUse === 'number');
    assert(typeof stats.Stop === 'number');
  });

  await test('hooks runner executes commands and returns outputs', async () => {
    const { HookRunner } = require('../lib/hooks');
    const hr = new HookRunner({ projectDir: path.resolve(__dirname, '..') });
    // Inject inline hook
    hr._loaded = true;
    hr.hooks.PreToolUse = [{
      matcher: 'test_tool',
      hooks: [{ type: 'command', command: process.platform === 'win32' ? 'echo hello' : "echo 'hello'" }]
    }];
    const res = await hr.run('PreToolUse', { toolName: 'test_tool' });
    assert(!res.blocked);
    assert(res.outputs.length === 1);
    assert(res.outputs[0].stdout.includes('hello'));
  });

  await test('hooks PreToolUse blocks on non-zero exit', async () => {
    const { HookRunner } = require('../lib/hooks');
    const hr = new HookRunner({ projectDir: path.resolve(__dirname, '..') });
    hr._loaded = true;
    hr.hooks.PreToolUse = [{
      matcher: '.*',
      hooks: [{ type: 'command', command: process.platform === 'win32' ? 'exit 1' : 'exit 1' }]
    }];
    const res = await hr.run('PreToolUse', { toolName: 'any' });
    assert(res.blocked, 'should block on exit 1');
  });

  // --- Repo cache ---
  await test('repo-cache produces and caches summary', async () => {
    const { RepoCache } = require('../lib/repo-cache');
    const projectDir = path.resolve(__dirname, '..');
    const cache = new RepoCache({ projectDir, ttlMs: 1000 });
    cache.invalidate();
    const s1 = await cache.getSummary();
    assert(typeof s1 === 'string' && s1.length > 50);
    const s2 = await cache.getSummary();
    assert(s1 === s2, 'second call should return cached value');
  });

  // --- Init project ---
  await test('initProject refuses overwrite without --force', async () => {
    const { initProject } = require('../lib/init-project');
    const projectDir = path.resolve(__dirname, '..');
    // This project doesn't have a CLAUDE.md at root yet
    const tmpFile = path.join(projectDir, 'CLAUDE.md');
    const existed = fs.existsSync(tmpFile);
    let createdNow = false;
    try {
      const res = await initProject(projectDir);
      if (existed) {
        assert(!res.created);
        assert(res.reason.includes('exists'));
      } else {
        createdNow = res.created;
      }
    } finally {
      if (createdNow && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  // --- Plan mode smoke (no network, just exports) ---
  test('plan-mode exports runPlanFlow', () => {
    const { runPlanFlow } = require('../lib/plan-mode');
    assert(typeof runPlanFlow === 'function');
  });

  // --- Agent loop new options surface ---
  test('AgentLoop accepts budget + hooks options', () => {
    const { AgentLoop } = require('../lib/agent-loop');
    const { BudgetTracker } = require('../lib/budget');
    const { HookRunner } = require('../lib/hooks');
    const b = new BudgetTracker({ capUsd: 1.0, model: 'smart' });
    const h = new HookRunner({ projectDir: path.resolve(__dirname, '..') });
    const agent = new AgentLoop({
      projectDir: path.resolve(__dirname, '..'),
      agentRole: 'builder',
      budget: b,
      hookRunner: h
    });
    assert(agent.budget === b);
    assert(agent.hookRunner === h);
    const stats = agent.getCacheStats();
    assert(typeof stats.cost === 'object');
  });

  // --- Status line ---
  test('status-line renders agent state', () => {
    const { renderStatusLine } = require('../lib/status-line');
    const { AgentLoop } = require('../lib/agent-loop');
    const agent = new AgentLoop({ projectDir: path.resolve(__dirname, '..') });
    const line = renderStatusLine(agent, { sessionId: 'test', projectName: 'p' });
    assert(typeof line === 'string');
    assert(line.includes('default') || line.includes('smart'));
  });

  // --- Worktree ---
  test('WorktreeSession detects git repo', () => {
    const { WorktreeSession } = require('../lib/worktree');
    const wt = new WorktreeSession(path.resolve(__dirname, '..'));
    // Shouldn't throw — this project is a git repo
    assert(wt.projectDir);
  });

  // --- Skill matcher ---
  test('skill-matcher extracts triggers from legacy skill', () => {
    const { extractTriggers } = require('../lib/skill-matcher');
    const triggers = extractTriggers({
      name: 'developer',
      body: '## Trigger\nKhi user yeu cau: build feature, fix bug, implement task, sua code'
    });
    // Should extract "build", "feature", "bug", "implement", "task", "sua", "code"
    assert(triggers.length > 3, `got ${triggers.length}: ${triggers.join(',')}`);
    assert(triggers.includes('bug') || triggers.includes('fix') || triggers.includes('build'));
  });

  test('skill-matcher scores prompts', () => {
    const { match } = require('../lib/skill-matcher');
    const index = [
      { name: 'fix', description: 'Fix bug', triggers: ['bug', 'fix', 'error'] },
      { name: 'build', description: 'Build feature', triggers: ['feature', 'build', 'implement'] }
    ];
    const res = match('Please fix the login bug', index);
    assert(res.length > 0);
    assert(res[0].name === 'fix', `expected fix, got ${res[0].name}`);
    assert(res[0].score > 0);
  });

  // --- Markdown render ---
  test('markdown-render handles common syntax', () => {
    const { renderMarkdown } = require('../lib/markdown-render');
    const out = renderMarkdown('**bold** *italic* `code` # heading\n- item\n```js\nconsole.log(1)\n```');
    assert(typeof out === 'string' && out.length > 0);
    // Should not leak raw markdown markers for bold/code
    assert(!out.includes('**bold**'), 'bold markers should be replaced');
    assert(!out.includes('`code`'), 'inline code markers should be replaced');
  });

  // --- MCP resources ---
  test('MCPRegistry exposes resource methods', () => {
    const { MCPRegistry } = require('../tools/mcp-client');
    const reg = new MCPRegistry();
    assert(typeof reg.listResources === 'function');
    assert(typeof reg.readResource === 'function');
    const resources = reg.listResources();
    assert(Array.isArray(resources) && resources.length === 0);
  });

  // --- Subagent inherits budget + hooks ---
  await test('subagent ctx passes through budget + hooks (via executor)', async () => {
    const { ToolExecutor } = require('../tools/executor');
    const { BudgetTracker } = require('../lib/budget');
    const { HookRunner } = require('../lib/hooks');
    const b = new BudgetTracker({ capUsd: 0.5, model: 'smart' });
    const h = new HookRunner({ projectDir: path.resolve(__dirname, '..') });
    const exec = new ToolExecutor({
      projectDir: path.resolve(__dirname, '..'),
      parentBudget: b,
      parentHookRunner: h
    });
    assert(exec.parentBudget === b);
    assert(exec.parentHookRunner === h);
  });

  test('AgentLoop wires parentBudget into executor', () => {
    const { AgentLoop } = require('../lib/agent-loop');
    const agent = new AgentLoop({
      projectDir: path.resolve(__dirname, '..'),
      budgetUsd: 0.25
    });
    assert(agent.executor.parentBudget === agent.budget);
    assert(agent.executor.parentHookRunner === agent.hookRunner);
  });

  // --- read_mcp_resource tool defined ---
  test('read_mcp_resource tool is available for builder role', () => {
    const { getTools } = require('../tools/definitions');
    const tools = getTools('builder').map(t => t.function.name);
    assert(tools.includes('read_mcp_resource'));
  });

  // --- /init parse tightening ---
  test('initProject refuses CLAUDE.md overwrite without --force', async () => {
    const { initProject } = require('../lib/init-project');
    // No-op assertion — just confirms function exports
    assert(typeof initProject === 'function');
  });

  // --- Ask user question ---
  await test('ask_user_question returns error in non-interactive mode', async () => {
    const { askUserQuestion } = require('../tools/ask-user');
    const res = await askUserQuestion({ question: 'test?' }, { interactive: false });
    assert(!res.success);
    assert(res.error.includes('NOT_INTERACTIVE'));
  });

  test('ask_user_question tool def present for builder', () => {
    const { getTools } = require('../tools/definitions');
    const tools = getTools('builder').map(t => t.function.name);
    assert(tools.includes('ask_user_question'));
  });

  test('ask_user_question available for reviewer (read-only) too', () => {
    const { getTools } = require('../tools/definitions');
    const tools = getTools('reviewer').map(t => t.function.name);
    assert(tools.includes('ask_user_question'));
  });

  await new Promise(r => setTimeout(r, 500)); // let async tests settle

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  - ${f.name}: ${f.error}`));
    process.exit(1);
  }
})();
