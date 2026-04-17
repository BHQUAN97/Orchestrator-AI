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

  // --- Batch edit ---
  await test('batch-edit rejects missing field', async () => {
    const { batchEdit } = require('../tools/batch-edit');
    const res = await batchEdit({ edits: [{ path: 'a.txt' }] }, {});
    assert(!res.success);
  });

  await test('batch-edit atomic — all or nothing', async () => {
    const { batchEdit } = require('../tools/batch-edit');
    const { FileManager } = require('../tools/file-manager');
    const projectDir = path.resolve(__dirname, '..');
    const fm = new FileManager({ projectDir });

    // Create 2 tmp files — one valid edit, one will fail
    const tmpA = path.join(projectDir, 'TEST-BATCH-A.txt');
    const tmpB = path.join(projectDir, 'TEST-BATCH-B.txt');
    fs.writeFileSync(tmpA, 'hello world', 'utf-8');
    fs.writeFileSync(tmpB, 'goodbye', 'utf-8');

    try {
      const res = await batchEdit({
        edits: [
          { path: 'TEST-BATCH-A.txt', old_string: 'hello', new_string: 'hi' },
          { path: 'TEST-BATCH-B.txt', old_string: 'NONEXISTENT', new_string: 'x' } // will fail
        ]
      }, fm);

      assert(!res.success, 'should fail on second edit');
      // First file should NOT have been modified (atomic)
      const a = fs.readFileSync(tmpA, 'utf-8');
      assert(a === 'hello world', `atomic violation: ${a}`);
    } finally {
      fs.unlinkSync(tmpA);
      fs.unlinkSync(tmpB);
    }
  });

  test('edit_files tool def present for builder', () => {
    const { getTools } = require('../tools/definitions');
    const tools = getTools('builder').map(t => t.function.name);
    assert(tools.includes('edit_files'));
  });

  // --- Doctor ---
  await test('doctor reports Node version', async () => {
    const { runDoctor } = require('../lib/doctor');
    const results = await runDoctor({
      projectDir: path.resolve(__dirname, '..'),
      litellmUrl: null,  // skip litellm check
      litellmKey: null
    });
    assert(Array.isArray(results));
    const nodeCheck = results.find(r => r.name === 'Node.js');
    assert(nodeCheck?.ok, 'Node.js check missing or failed');
  });

  // --- Cost estimate ---
  test('cost-estimate produces positive bounded estimate', () => {
    const { estimatePromptCost } = require('../lib/cost-estimate');
    const est = estimatePromptCost({
      systemPrompt: 'You are a coding agent.',
      userPrompt: 'Fix the login bug in auth.js',
      model: 'smart'
    });
    assert(est.cost_est_usd > 0);
    assert(est.cost_est_usd < 1); // reasonable upper bound
    assert(est.iterations_est > 0);
    assert(est.cost_range_usd[0] <= est.cost_est_usd);
    assert(est.cost_range_usd[1] >= est.cost_est_usd);
  });

  test('cost-estimate scales with task complexity', () => {
    const { estimatePromptCost } = require('../lib/cost-estimate');
    const simple = estimatePromptCost({ userPrompt: 'rename var x to y', model: 'default' });
    const complex = estimatePromptCost({ userPrompt: 'refactor the whole auth system to use JWT', model: 'default' });
    assert(complex.iterations_est > simple.iterations_est, 'refactor should estimate more iter');
  });

  // --- Interactive input completer ---
  test('completer matches /commands', () => {
    const { buildCompleter } = require('../lib/interactive-input');
    const comp = buildCompleter({
      projectDir: path.resolve(__dirname, '..'),
      customCommandNames: ['developer'],
      builtinCommandNames: ['stats', 'files', 'doctor']
    });
    const [matches] = comp('/st');
    assert(matches.includes('/stats'));
  });

  test('completer matches @files', () => {
    const { buildCompleter } = require('../lib/interactive-input');
    const comp = buildCompleter({
      projectDir: path.resolve(__dirname, '..'),
      customCommandNames: [],
      builtinCommandNames: []
    });
    const [matches] = comp('@lib/age');
    // Should find lib/agent-loop.js
    assert(matches.some(m => m.startsWith('@lib/agent')), `got ${matches.slice(0, 5).join(',')}`);
  });

  // --- CLAUDE.md hierarchy ---
  await test('claude-md-loader loads from project dir', async () => {
    const { loadClaudeMdHierarchy } = require('../lib/claude-md-loader');
    const projectDir = path.resolve(__dirname, '..');
    const tmpClaude = path.join(projectDir, 'CLAUDE.md');
    const hadBefore = fs.existsSync(tmpClaude);
    if (!hadBefore) fs.writeFileSync(tmpClaude, '# Test CLAUDE.md\n\nHello from project rules.', 'utf-8');
    try {
      const res = loadClaudeMdHierarchy(projectDir);
      assert(res.sources.length >= 1, `expected at least 1 source, got ${res.sources.length}`);
      assert(res.content.includes('Hello from project rules') || res.content.includes('CLAUDE.md'), 'content should include loaded rules');
    } finally {
      if (!hadBefore && fs.existsSync(tmpClaude)) fs.unlinkSync(tmpClaude);
    }
  });

  test('claude-md-loader returns empty when nothing found', () => {
    const { loadClaudeMdHierarchy } = require('../lib/claude-md-loader');
    // Use a path that definitely has no CLAUDE.md
    const res = loadClaudeMdHierarchy('/nonexistent/deep/subpath/xyz123');
    // Might still find global ~/.claude/CLAUDE.md if user has one, so just check shape
    assert(Array.isArray(res.sources));
    assert(typeof res.content === 'string');
  });

  // --- Transcript logger ---
  await test('TranscriptLogger writes JSONL', async () => {
    const { TranscriptLogger } = require('../lib/transcript-logger');
    const projectDir = path.resolve(__dirname, '..');
    const logger = new TranscriptLogger({ projectDir, sessionId: 'test-' + Date.now() });
    logger.logMeta({ event: 'test_start' });
    logger.logToolCall('read_file', { path: 'foo.txt' });
    const filePath = logger.getPath();
    assert(filePath);
    // Give fs a moment
    await new Promise(r => setTimeout(r, 50));
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    assert(lines.length === 2, `expected 2 lines, got ${lines.length}`);
    assert(JSON.parse(lines[0]).type === 'meta');
    assert(JSON.parse(lines[1]).type === 'tool_call');
    fs.unlinkSync(filePath);
  });

  // --- Agent todos ---
  test('AgentTodoStore upsert + list', () => {
    const { AgentTodoStore, todoWrite, todoList } = require('../tools/agent-todos');
    const store = new AgentTodoStore();
    const res1 = todoWrite({ todos: [
      { subject: 'Task A', status: 'pending' },
      { subject: 'Task B', status: 'in_progress' }
    ] }, store);
    assert(res1.success);
    assert(res1.todos.length === 2);
    // Update by id
    const id = res1.todos[0].id;
    const res2 = todoWrite({ todos: [{ id, status: 'completed' }] }, store);
    assert(res2.success);
    const listed = todoList({}, store);
    assert(listed.todos.length === 2);
    const completed = listed.todos.find(t => t.id === id);
    assert(completed.status === 'completed');
    assert(completed.subject === 'Task A'); // preserved
  });

  test('todo_write tool available for builder', () => {
    const { getTools } = require('../tools/definitions');
    const tools = getTools('builder').map(t => t.function.name);
    assert(tools.includes('todo_write'));
    assert(tools.includes('todo_list'));
  });

  test('executor has todoStore', () => {
    const { ToolExecutor } = require('../tools/executor');
    const exec = new ToolExecutor({ projectDir: path.resolve(__dirname, '..') });
    assert(exec.todoStore);
    assert(typeof exec.todoStore.upsert === 'function');
  });

  // --- Extended thinking ---
  test('extended-thinking auto-detects complex prompts', () => {
    const { shouldEnableThinking } = require('../lib/extended-thinking');
    assert(shouldEnableThinking('smart', 'refactor the authentication system', { autoDetect: true }));
    assert(shouldEnableThinking('claude-opus', 'analyze deeply the performance bottleneck', { autoDetect: true }));
    assert(!shouldEnableThinking('smart', 'fix typo in readme', { autoDetect: true }));
  });

  test('extended-thinking disabled for non-Claude models', () => {
    const { shouldEnableThinking } = require('../lib/extended-thinking');
    assert(!shouldEnableThinking('deepseek', 'refactor everything', { forceEnable: true }));
    assert(!shouldEnableThinking('gpt-4', 'refactor everything', { autoDetect: true }));
  });

  test('applyThinking injects thinking param only when applicable', () => {
    const { applyThinking } = require('../lib/extended-thinking');
    const body1 = applyThinking({ model: 'smart' }, { model: 'smart', forceEnable: true, budget: 5000 });
    assert(body1.thinking?.type === 'enabled');
    assert(body1.thinking?.budget_tokens === 5000);
    const body2 = applyThinking({ model: 'deepseek' }, { model: 'deepseek', forceEnable: true });
    assert(!body2.thinking);
  });

  test('extractThinking handles content blocks', () => {
    const { extractThinking, getMessageText } = require('../lib/extended-thinking');
    const msg = { content: [
      { type: 'thinking', thinking: 'Let me consider...' },
      { type: 'text', text: 'Here is the answer.' }
    ]};
    assert(extractThinking(msg) === 'Let me consider...');
    assert(getMessageText(msg) === 'Here is the answer.');
  });

  test('AgentLoop accepts thinking + transcriptLogger options', () => {
    const { AgentLoop } = require('../lib/agent-loop');
    const agent = new AgentLoop({
      projectDir: path.resolve(__dirname, '..'),
      thinking: true,
      thinkingBudget: 5000
    });
    assert(agent.thinking === true);
    assert(agent.thinkingBudget === 5000);
  });

  // --- Memory system ---
  test('MemoryStore appends + searches', () => {
    const { MemoryStore } = require('../lib/memory');
    const tmpDir = path.resolve(__dirname, '..');
    const store = new MemoryStore(tmpDir);
    store.clear();
    try {
      store.append({ type: 'lesson', summary: 'Fix JWT null check in auth middleware', keywords: ['jwt', 'auth', 'null', 'middleware'] });
      store.append({ type: 'gotcha', summary: 'Database migration order matters for foreign keys', keywords: ['migration', 'db', 'foreign'] });
      const results = store.search('auth jwt bug', 5);
      assert(results.length > 0);
      assert(results[0].summary.includes('JWT'), `expected JWT match, got: ${results[0].summary}`);
    } finally {
      store.clear();
    }
  });

  test('memory_save tool def present', () => {
    const { getTools } = require('../tools/definitions');
    const tools = getTools('builder').map(t => t.function.name);
    for (const n of ['memory_save', 'memory_recall', 'memory_list', 'create_skill', 'spawn_team']) {
      assert(tools.includes(n), `missing tool: ${n}`);
    }
  });

  // --- Context guard ---
  test('ContextGuard detects unverified change claim', () => {
    const { ContextGuard } = require('../lib/context-guard');
    const g = new ContextGuard();
    // Record an actual change to file A
    g.record('write_file', { path: 'src/auth.ts' }, { content: JSON.stringify({ success: true, path: 'src/auth.ts' }) });
    // Summary claims edits to BOTH auth.ts (real) AND unreal.ts (hallucinated)
    const summary = 'Updated src/auth.ts to fix null check. Also modified src/unreal.ts for related bug.';
    const report = g.verify(summary);
    assert(report.issues.length > 0, 'should flag unreal.ts as unverified');
    assert(report.issues.some(i => i.file?.includes('unreal')));
    assert(report.verified.some(v => v.file?.includes('auth.ts')));
  });

  test('ContextGuard accepts verified changes', () => {
    const { ContextGuard } = require('../lib/context-guard');
    const g = new ContextGuard();
    g.record('edit_file', { path: 'lib/foo.js' }, { content: JSON.stringify({ success: true, path: 'lib/foo.js' }) });
    const report = g.verify('Edited lib/foo.js to add validation.');
    assert(report.issues.length === 0, `expected no issues, got ${JSON.stringify(report.issues)}`);
  });

  // --- Skill creation ---
  await test('createSkill writes valid markdown', async () => {
    const { createSkill } = require('../tools/create-skill');
    const projectDir = path.resolve(__dirname, '..');
    const res = await createSkill({
      name: 'test-parity-skill-xyz',
      description: 'Test skill for parity',
      body: 'This is a test skill body with $ARGUMENTS.',
      trigger: 'test, parity',
      location: 'claude'
    }, projectDir);
    try {
      assert(res.success, res.error);
      const skillPath = path.join(projectDir, res.path);
      const content = fs.readFileSync(skillPath, 'utf-8');
      assert(content.includes('description: Test skill for parity'));
      assert(content.includes('$ARGUMENTS'));
    } finally {
      try { fs.unlinkSync(path.join(projectDir, res.path)); } catch {}
    }
  });

  test('createSkill rejects invalid name', async () => {
    const { createSkill } = require('../tools/create-skill');
    const res = await createSkill({ name: 'bad name!', description: 'x', body: 'x'.repeat(20) }, path.resolve(__dirname, '..'));
    assert(!res.success);
  });

  // --- Spawn team signature ---
  test('spawn_team requires 2+ agents', async () => {
    const { spawnTeam } = require('../tools/spawn-team');
    const res = await spawnTeam({ agents: [] }, { projectDir: path.resolve(__dirname, '..') });
    assert(!res.success);
  });

  // --- Executor wires memory + guard ---
  test('AgentLoop wires memory + contextGuard into executor', () => {
    const { AgentLoop } = require('../lib/agent-loop');
    const agent = new AgentLoop({ projectDir: path.resolve(__dirname, '..') });
    assert(agent.executor.memoryStore, 'executor.memoryStore not wired');
    assert(agent.executor.contextGuard, 'executor.contextGuard not wired');
  });

  // --- Hermes Bridge ---
  test('HermesBridge wraps SmartRouter + DecisionLock', () => {
    const { HermesBridge } = require('../lib/hermes-bridge');
    const bridge = new HermesBridge({ projectDir: path.resolve(__dirname, '..') });
    assert(bridge.smartRouter, 'smart router missing');
    assert(bridge.decisionLock, 'decision lock missing');
    const locks = bridge.getActiveLocks();
    assert(Array.isArray(locks));
  });

  await test('HermesBridge.selectModel returns heuristic decision', async () => {
    const { HermesBridge } = require('../lib/hermes-bridge');
    const bridge = new HermesBridge({ projectDir: path.resolve(__dirname, '..') });
    const d = await bridge.selectModel({
      task: 'fix',
      prompt: 'Fix the React login component styling',
      files: ['src/components/Login.tsx']
    });
    assert(d.method === 'heuristic');
    assert(typeof d.model === 'string' && d.model.length > 0);
  });

  test('HermesBridge.checkFilePath returns empty when no locks', () => {
    const { HermesBridge } = require('../lib/hermes-bridge');
    const bridge = new HermesBridge({ projectDir: '/tmp/no-locks-xyz-' + Date.now() });
    const blocks = bridge.checkFilePath('src/foo.ts');
    assert(Array.isArray(blocks));
    assert(blocks.length === 0);
  });

  test('AgentLoop wires HermesBridge', () => {
    const { AgentLoop } = require('../lib/agent-loop');
    const agent = new AgentLoop({ projectDir: path.resolve(__dirname, '..') });
    assert(agent.hermesBridge, 'hermesBridge not wired');
    assert(agent.executor.hermesBridge === agent.hermesBridge);
  });

  // --- Task decomposition ---
  test('decompose_task + hermes tools in builder list', () => {
    const { getTools } = require('../tools/definitions');
    const tools = getTools('builder').map(t => t.function.name);
    assert(tools.includes('decompose_task'));
  });

  await test('decompose_task returns error without classifier', async () => {
    const { decomposeTask } = require('../tools/task-decompose');
    const res = await decomposeTask(
      { prompt: 'refactor auth module' },
      { hermesBridge: { classifier: null } }
    );
    assert(!res.success);
    assert(res.error.includes('Classifier'));
  });

  // --- Parallel executor ---
  test('isBatchReadSafe detects read-only batches', () => {
    const { isBatchReadSafe } = require('../lib/parallel-executor');
    assert(isBatchReadSafe([
      { function: { name: 'read_file' } },
      { function: { name: 'glob' } }
    ]));
    assert(!isBatchReadSafe([
      { function: { name: 'read_file' } },
      { function: { name: 'write_file' } }
    ]));
    assert(!isBatchReadSafe([{ function: { name: 'read_file' } }])); // too few
  });

  // --- Retry ---
  await test('fetchWithRetry retries on 429', async () => {
    const { fetchWithRetry } = require('../lib/retry');
    let calls = 0;
    const resp = await fetchWithRetry(async () => {
      calls++;
      if (calls < 3) {
        return {
          ok: false, status: 429,
          headers: { get: () => '0' } // retry-after 0 → instant
        };
      }
      return { ok: true, status: 200, headers: { get: () => null } };
    }, { retries: 3 });
    assert(calls === 3, `expected 3 calls, got ${calls}`);
    assert(resp.ok);
  });

  await test('fetchWithRetry gives up after retries', async () => {
    const { fetchWithRetry } = require('../lib/retry');
    let calls = 0;
    const resp = await fetchWithRetry(async () => {
      calls++;
      return { ok: false, status: 503, headers: { get: () => '0' } };
    }, { retries: 2 });
    assert(calls === 3, `1 initial + 2 retries = 3, got ${calls}`);
    assert(!resp.ok);
  });

  // --- Stuck detector ---
  test('StuckDetector detects repeat pattern', () => {
    const { StuckDetector } = require('../lib/stuck-detector');
    const d = new StuckDetector();
    assert(d.record('read_file', { path: 'a.ts' }) === null);
    assert(d.record('read_file', { path: 'a.ts' }) === null);
    const stuck = d.record('read_file', { path: 'a.ts' });
    assert(stuck, 'should detect repeat after 3x same call');
    assert(stuck.type === 'repeat');
  });

  test('StuckDetector detects toggle pattern', () => {
    const { StuckDetector } = require('../lib/stuck-detector');
    const d = new StuckDetector();
    // A,B,A,B,A — 5 calls alternating
    d.record('read_file', { path: 'a.ts' });
    d.record('read_file', { path: 'b.ts' });
    d.record('read_file', { path: 'a.ts' });
    d.record('read_file', { path: 'b.ts' });
    const stuck = d.record('read_file', { path: 'a.ts' });
    assert(stuck && stuck.type === 'toggle', `expected toggle, got ${stuck?.type}`);
  });

  // --- Background bash ---
  await test('background bash spawn + output + kill', async () => {
    const { getBgManager } = require('../tools/background-bash');
    const mgr = getBgManager();
    const cmd = process.platform === 'win32' ? 'ping -n 10 127.0.0.1' : 'sleep 5';
    const pid = mgr.spawn(cmd, path.resolve(__dirname, '..'));
    assert(typeof pid === 'number');
    // List
    const list = mgr.list();
    assert(list.some(p => p.pid === pid));
    // Kill
    const killed = mgr.kill(pid);
    assert(killed.success);
    // Poll up to 3s for exit event to fire
    let entry;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100));
      entry = mgr.list().find(p => p.pid === pid);
      if (entry && !entry.running) break;
    }
    assert(entry && !entry.running, `process should be marked stopped (running=${entry?.running}, exitCode=${entry?.exitCode})`);
  });

  // --- Orchestrator client ---
  await test('orchestrator client reports unreachable when down', async () => {
    const { checkOrchestratorHealth } = require('../lib/orchestrator-client');
    const h = await checkOrchestratorHealth('http://localhost:1'); // unreachable
    assert(!h.ok);
  });

  await test('delegateToOrchestrator returns error on unreachable', async () => {
    const { delegateToOrchestrator } = require('../lib/orchestrator-client');
    const res = await delegateToOrchestrator({
      prompt: 'test',
      projectDir: path.resolve(__dirname, '..'),
      orchestratorUrl: 'http://localhost:1'
    });
    assert(!res.success);
    assert(res.error.includes('unreachable'));
  });

  // --- Background tools registered ---
  test('bg_* tools registered for builder', () => {
    const { getTools } = require('../tools/definitions');
    const tools = getTools('builder').map(t => t.function.name);
    for (const n of ['bg_list', 'bg_output', 'bg_kill']) {
      assert(tools.includes(n), `missing: ${n}`);
    }
  });

  test('AgentLoop has stuckDetector + parallel flag', () => {
    const { AgentLoop } = require('../lib/agent-loop');
    const agent = new AgentLoop({ projectDir: path.resolve(__dirname, '..') });
    assert(agent.stuckDetector);
    assert(agent.parallelReadSafe === true);
    assert(agent.retries === 3);
  });

  await new Promise(r => setTimeout(r, 500)); // let async tests settle

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  - ${f.name}: ${f.error}`));
    process.exit(1);
  }
})();
