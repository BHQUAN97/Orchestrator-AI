#!/usr/bin/env node
/**
 * OrcAI CLI — Coding Agent tương tự Claude Code
 *
 * Usage:
 *   orcai "sửa bug login"                    # One-shot mode
 *   orcai -i                                  # Interactive mode
 *   orcai -p /path/to/project "thêm feature"  # Chỉ định project
 *   orcai --model smart "refactor auth"       # Chọn model
 *
 * Trong interactive mode:
 *   Gõ prompt → AI suy nghĩ + thực thi tools → trả kết quả
 *   /exit hoặc Ctrl+C để thoát
 *   /stats để xem thống kê
 *   /files để xem files đã thay đổi
 */

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const path = require('path');
const { AgentLoop } = require('../lib/agent-loop');
const { getToolsSummary } = require('../tools/definitions');
const { RepoMapper } = require('../lib/repo-mapper');
const { Config } = require('../lib/config');
const { ConversationManager } = require('../lib/conversation-manager');
const { expandMentions } = require('../lib/mention-expander');
const { discoverCommands, expandCommand, formatCommandList } = require('../lib/slash-commands');
const { askApproval, ApprovalState } = require('../tools/diff-approval');
const { getRegistry } = require('../tools/mcp-client');

// === CLI Setup ===
const program = new Command();

program
  .name('orcai')
  .description('AI Coding Agent — multi-model orchestration with tool use')
  .version('2.0.0')
  .argument('[prompt...]', 'Task prompt (one-shot mode)')
  .option('-i, --interactive', 'Interactive mode — liên tục nhận prompt')
  .option('-p, --project <path>', 'Project directory', process.cwd())
  .option('-m, --model <name>', 'Model: smart (Sonnet), default (Kimi), cheap (DeepSeek), fast (Gemini)', 'smart')
  .option('-r, --role <role>', 'Agent role: builder, fe-dev, be-dev, reviewer, debugger', 'builder')
  .option('--max-iterations <n>', 'Max tool call iterations', '30')
  .option('--url <url>', 'LiteLLM URL', process.env.LITELLM_URL || 'http://localhost:5002')
  .option('--key <key>', 'LiteLLM API key', process.env.LITELLM_KEY || 'sk-master-change-me')
  .option('--no-confirm', 'Bỏ qua confirm cho lệnh nguy hiểm (cẩn thận!)')
  .option('--direct', 'Direct mode: skip repo scan, minimal system prompt (faster for simple tasks)')
  .option('-y, --yes', 'Auto-approve all file changes (skip diff approval in interactive mode)')
  .option('--no-cache', 'Disable Anthropic prompt caching')
  .option('--no-mcp', 'Disable MCP server loading')
  .option('--mcp-config <path>', 'Path to additional MCP config JSON')
  .action(async (promptParts, opts) => {
    const prompt = promptParts.join(' ').trim();
    const projectDir = path.resolve(opts.project);

    // Load config — CLI options override config file
    const cfg = new Config();
    cfg.load();
    if (!opts.model || opts.model === 'smart') opts.model = opts.model || cfg.get('model') || 'smart';
    if (!opts.url || opts.url === 'http://localhost:5002') opts.url = cfg.get('litellm.url') || opts.url;
    if (!opts.key || opts.key === 'sk-master-change-me') opts.key = cfg.get('litellm.key') || opts.key;

    // Banner
    printBanner(projectDir, opts.model, opts.role);

    // Init MCP (async, best-effort — khong block neu server loi)
    const mcpRegistry = opts.mcp === false ? null : await initMCP(projectDir, opts);

    // Approval state share qua toan bo session
    const approvalState = new ApprovalState({ autoYes: !!opts.yes });

    opts._mcpRegistry = mcpRegistry;
    opts._approvalState = approvalState;

    if (opts.interactive || !prompt) {
      await interactiveMode(projectDir, opts);
    } else {
      await oneShotMode(prompt, projectDir, opts);
    }

    // Cleanup
    if (mcpRegistry) await mcpRegistry.shutdown();
  });

// === MCP Init ===
async function initMCP(projectDir, opts) {
  const registry = getRegistry();
  try {
    const res = await registry.init({
      projectDir,
      extraConfigPath: opts.mcpConfig || null
    });
    if (res.count > 0) {
      console.log(chalk.gray(`  MCP: ${res.count} server${res.count > 1 ? 's' : ''}, ${res.tools} tools — ${res.servers.filter(s => s.status === 'ok').map(s => s.name).join(', ')}`));
    }
    const failed = res.servers?.filter(s => s.status === 'failed') || [];
    if (failed.length > 0) {
      console.log(chalk.yellow(`  MCP warn: ${failed.length} server(s) failed: ${failed.map(s => s.name).join(', ')}`));
    }
    return registry.clients.size > 0 ? registry : null;
  } catch (e) {
    console.log(chalk.yellow(`  MCP skip: ${e.message}`));
    return null;
  }
}

// === Banner ===
function printBanner(projectDir, model, role) {
  const projectName = path.basename(projectDir);
  console.log(chalk.cyan.bold('\n  OrcAI') + chalk.gray(' — Coding Agent v2'));
  console.log(chalk.gray(`  Project: ${chalk.white(projectName)}`));
  console.log(chalk.gray(`  Model: ${chalk.yellow(model)} | Role: ${chalk.green(role)}`));
  console.log(chalk.gray('  ─'.repeat(25)));
}

// === Build System Prompt (với repo context) ===
async function buildSystemPrompt(projectDir, role, opts = {}) {
  const projectName = path.basename(projectDir);

  // Direct mode: skip repo scan cho prompt nho gon + nhanh
  if (opts.direct) {
    return `Ban la AI Coding Agent trong project "${projectName}" (${projectDir}).

TOOLS: ${getToolsSummary()}

Nguyen tac:
- Doc file truoc khi sua (read_file, list_files, glob, search_files)
- Dung edit_file cho sua nho, write_file cho file moi/ghi de
- Verify bang execute_command (test, build, lint)
- Goi task_complete voi summary ngan khi xong
- Comment business logic tieng Viet, technical tieng Anh`;
  }

  // Quét project structure bằng RepoMapper
  let repoContext = '';
  try {
    const mapper = new RepoMapper({ projectDir });
    repoContext = await mapper.getCompactSummary(projectDir);
  } catch {
    repoContext = `Project: ${projectName}`;
  }

  return `Bạn là AI Coding Agent đang làm việc trong project "${projectName}".
Thư mục project: ${projectDir}

=== PROJECT STRUCTURE ===
${repoContext}
=== END STRUCTURE ===

BẠN CÓ CÁC TOOLS SAU:
${getToolsSummary()}

NGUYÊN TẮC:
1. LUÔN đọc file trước khi sửa — hiểu code hiện tại
2. Sửa file bằng edit_file (search & replace) thay vì write_file — tiết kiệm token
3. Sau khi sửa code, chạy test/build để verify
4. Nếu gặp lỗi → đọc log → sửa → chạy lại (tự correction)
5. Khi xong → gọi task_complete với summary ngắn gọn
6. KHÔNG sửa file ngoài scope task
7. Comment business logic bằng tiếng Việt, technical bằng tiếng Anh
8. Task doc lap, research sau → dung spawn_subagent de giu context parent sach

QUY TRÌNH:
1. Đọc files liên quan (read_file, list_files, glob, search_files)
2. Lập kế hoạch ngắn (trong đầu, không cần output)
3. Thực hiện thay đổi (edit_file hoặc write_file)
4. Verify (execute_command: chạy test, build, lint)
5. Sửa nếu cần (self-correction loop)
6. Gọi task_complete khi xong`;
}

// === Create Agent Loop với callbacks ===
function createAgent(projectDir, opts) {
  let spinner = null;
  let currentTool = '';

  const approvalState = opts._approvalState || new ApprovalState({ autoYes: !!opts.yes });

  const agent = new AgentLoop({
    litellmUrl: opts.url,
    litellmKey: opts.key,
    model: opts.model,
    projectDir,
    agentRole: opts.role,
    maxIterations: parseInt(opts.maxIterations),
    promptCaching: opts.cache !== false,
    mcpRegistry: opts._mcpRegistry || null,

    // Diff approval — chi hoi trong interactive mode + co TTY
    onWriteApproval: (opts.interactive && !approvalState.autoYes)
      ? async (filePath, before, after) => {
          if (spinner) spinner.stop();
          return await askApproval(filePath, before, after, approvalState);
        }
      : null,

    // Human-in-the-loop confirm
    onConfirm: opts.confirm !== false ? async (command, reason) => {
      if (spinner) spinner.stop();
      const { confirmed } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirmed',
        message: chalk.yellow(`⚠️  ${reason}\n   Command: ${chalk.white(command)}\n   Cho phép?`),
        default: false
      }]);
      return confirmed;
    } : null,

    // Callbacks cho UI
    onThinking: (iter, max) => {
      if (spinner) spinner.stop();
      spinner = ora({
        text: chalk.gray(`Thinking... (${iter}/${max})`),
        spinner: 'dots'
      }).start();
    },

    onToolCall: (name, args) => {
      currentTool = name;
      let detail = '';
      if (name === 'read_file') detail = args.path;
      else if (name === 'write_file') detail = args.path;
      else if (name === 'edit_file') detail = args.path;
      else if (name === 'execute_command') detail = args.command?.slice(0, 60);
      else if (name === 'search_files') detail = args.pattern;
      else if (name === 'list_files') detail = args.path || '.';
      else if (name === 'task_complete') detail = '✓';

      if (spinner) spinner.text = chalk.cyan(`▶ ${name}`) + chalk.gray(` ${detail}`);
    },

    onToolResult: (name, result) => {
      const parsed = JSON.parse(result.content);
      const icon = parsed.success ? chalk.green('✓') : chalk.red('✗');

      if (spinner) spinner.stop();

      // Hiển thị kết quả ngắn gọn
      if (name === 'read_file' && parsed.success) {
        console.log(`  ${icon} ${chalk.cyan('read')} ${parsed.showing} of ${parsed.total_lines} lines`);
      } else if (name === 'write_file' && parsed.success) {
        console.log(`  ${icon} ${chalk.green(parsed.action)} ${parsed.path} (${parsed.lines} lines)`);
      } else if (name === 'edit_file' && parsed.success) {
        console.log(`  ${icon} ${chalk.yellow('edit')} ${parsed.path} (${parsed.replacements} replacements)`);
      } else if (name === 'execute_command') {
        const exitIcon = parsed.exit_code === 0 ? chalk.green('✓') : chalk.red(`exit ${parsed.exit_code}`);
        console.log(`  ${exitIcon} ${chalk.blue('$')} ${chalk.gray(result.tool_call_id ? '' : '')}`);
        // Hiển thị stdout/stderr ngắn gọn
        if (parsed.stdout) {
          const lines = parsed.stdout.split('\n');
          const preview = lines.slice(0, 5).join('\n');
          console.log(chalk.gray('    ' + preview.replace(/\n/g, '\n    ')));
          if (lines.length > 5) console.log(chalk.gray(`    ... +${lines.length - 5} lines`));
        }
        if (parsed.stderr && !parsed.success) {
          console.log(chalk.red('    ' + parsed.stderr.split('\n').slice(0, 3).join('\n    ')));
        }
      } else if (name === 'search_files' && parsed.success) {
        console.log(`  ${icon} ${chalk.magenta('search')} "${parsed.pattern}" → ${parsed.total} matches`);
      } else if (name === 'list_files' && parsed.success) {
        console.log(`  ${icon} ${chalk.cyan('list')} ${parsed.files.length} files`);
      } else if (name === 'task_complete') {
        // Handled after loop
      } else if (!parsed.success) {
        console.log(`  ${icon} ${chalk.red(name)}: ${parsed.error?.slice(0, 100)}`);
      }
    },

    onText: (text) => {
      if (spinner) spinner.stop();
      console.log('\n' + chalk.white(text));
    },

    onError: (err) => {
      if (spinner) spinner.stop();
      console.log(chalk.red(`\n  ✗ ${err}`));
    }
  });

  return { agent, getSpinner: () => spinner };
}

// === One-shot Mode ===
async function oneShotMode(prompt, projectDir, opts) {
  // Expand @mention file references
  const { prompt: expanded, attachments } = expandMentions(prompt, projectDir);
  if (attachments.length > 0) {
    const ok = attachments.filter(a => a.content).length;
    if (ok > 0) console.log(chalk.gray(`  @${ok} file(s) attached`));
  }

  console.log(chalk.gray(`\n  > ${prompt}\n`));

  const systemPrompt = await buildSystemPrompt(projectDir, opts.role, opts);
  const { agent } = createAgent(projectDir, opts);

  const result = await agent.run(systemPrompt, expanded);
  printResult(result);
  printCacheStats(agent);
}

// === Print cache stats ===
function printCacheStats(agent) {
  const stats = agent.getCacheStats();
  if (stats.total_input_tokens === 0) return;
  const savings = stats.total_cache_read_tokens > 0
    ? ` — saved ~${Math.round(stats.total_cache_read_tokens * 0.9)} tokens via cache`
    : '';
  console.log(chalk.gray(`  Tokens: ${stats.total_input_tokens} in, ${stats.total_completion_tokens} out | cache hit: ${stats.cache_hit_rate_pct}%${savings}`));
}

// === Interactive Mode ===
async function interactiveMode(projectDir, opts) {
  const systemPrompt = await buildSystemPrompt(projectDir, opts.role, opts);
  const { agent } = createAgent(projectDir, opts);
  let hasRun = false;

  // Discover custom slash commands (skills/*.md + .claude/commands/*.md + global)
  const customCommands = discoverCommands(projectDir);

  // Session management
  const cm = new ConversationManager({ projectDir });
  const session = cm.createSession();
  console.log(chalk.gray(`  Session: ${session.id}`));
  if (customCommands.size > 0) {
    console.log(chalk.gray(`  ${customCommands.size} custom command(s) loaded. /help to list.`));
  }
  console.log(chalk.gray('  Gõ prompt. @path để attach file. /help để xem commands.\n'));

  // Hook vào executor để track file changes cho undo
  const origWriteFile = agent.executor.handlers['write_file'];
  const origEditFile = agent.executor.handlers['edit_file'];
  const fs = require('fs');

  agent.executor.handlers['write_file'] = async (args) => {
    // Lưu before state cho undo
    const fullPath = path.resolve(projectDir, args.path);
    const before = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : null;
    const result = await origWriteFile(args);
    if (result.success) {
      cm.recordChange(session.id, {
        type: 'write', path: fullPath, before,
        after: args.content, timestamp: new Date().toISOString()
      });
    }
    return result;
  };

  agent.executor.handlers['edit_file'] = async (args) => {
    const fullPath = path.resolve(projectDir, args.path);
    const before = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : null;
    const result = await origEditFile(args);
    if (result.success) {
      const after = fs.readFileSync(fullPath, 'utf-8');
      cm.recordChange(session.id, {
        type: 'edit', path: fullPath, before,
        after, timestamp: new Date().toISOString()
      });
    }
    return result;
  };

  while (true) {
    let input;
    try {
      const answer = await inquirer.prompt([{
        type: 'input',
        name: 'prompt',
        message: chalk.cyan('❯'),
        prefix: ''
      }]);
      input = answer.prompt.trim();
    } catch {
      break; // Ctrl+C
    }

    if (!input) continue;

    // Slash commands
    if (input === '/exit' || input === '/quit') break;

    if (input === '/stats') {
      const stats = agent.executor.getStats();
      console.log(chalk.gray(JSON.stringify(stats, null, 2)));
      continue;
    }

    if (input === '/files') {
      const files = [...agent.executor.filesChanged];
      if (files.length === 0) {
        console.log(chalk.gray('  Chưa có file nào thay đổi'));
      } else {
        files.forEach(f => console.log(chalk.green(`  + ${f}`)));
      }
      continue;
    }

    if (input === '/undo') {
      const undone = cm.undo(session.id);
      if (undone) {
        console.log(chalk.yellow(`  ↩ Reverted ${undone.type}: ${path.relative(projectDir, undone.path)}`));
      } else {
        console.log(chalk.gray('  Không có gì để undo'));
      }
      continue;
    }

    if (input === '/sessions') {
      const sessions = cm.listSessions(5);
      if (sessions.length === 0) {
        console.log(chalk.gray('  Chưa có session nào'));
      } else {
        sessions.forEach(s => {
          const isCurrent = s.id === session.id ? chalk.cyan(' ←') : '';
          console.log(chalk.gray(`  ${s.id} — ${s.summary || 'empty'}${isCurrent}`));
        });
      }
      continue;
    }

    if (input === '/tokens' || input === '/cost') {
      const stats = agent.getCacheStats();
      console.log(chalk.gray(`  Input tokens:   ${stats.total_input_tokens.toLocaleString()}`));
      console.log(chalk.gray(`    - fresh:      ${(stats.total_prompt_tokens).toLocaleString()}`));
      console.log(chalk.gray(`    - cached:     ${stats.total_cache_read_tokens.toLocaleString()} (${stats.cache_hit_rate_pct}% hit rate)`));
      console.log(chalk.gray(`    - new cache:  ${stats.total_cache_creation_tokens.toLocaleString()}`));
      console.log(chalk.gray(`  Output tokens:  ${stats.total_completion_tokens.toLocaleString()}`));
      continue;
    }

    if (input === '/mcp') {
      const registry = opts._mcpRegistry;
      if (!registry) {
        console.log(chalk.gray('  MCP: no servers connected'));
      } else {
        const stats = registry.getStats();
        console.log(chalk.gray(`  MCP: ${stats.servers} server(s), ${stats.tools} tool(s)`));
        stats.serverList.forEach(s => console.log(chalk.gray(`    - ${s}`)));
        if (stats.errors.length > 0) {
          stats.errors.forEach(e => console.log(chalk.yellow(`    ⚠ ${e.server || e.path}: ${e.error}`)));
        }
      }
      continue;
    }

    if (input === '/cache on') { agent.promptCaching = true; console.log(chalk.gray('  cache: on')); continue; }
    if (input === '/cache off') { agent.promptCaching = false; console.log(chalk.gray('  cache: off')); continue; }

    if (input === '/help') {
      console.log(chalk.gray(`
  Built-in slash commands:
    /stats        — Thong ke tool calls
    /files        — Files da thay doi
    /undo         — Hoan tac thay doi file cuoi
    /sessions     — Danh sach sessions gan day
    /tokens       — Token usage + cache hit rate
    /mcp          — MCP server status
    /cache on|off — Bat/tat prompt caching
    /exit         — Thoat
    /help         — Hien help

  Tip:
    @path/to/file — attach file content vao prompt
    @"file with spaces.txt" — quoted path

  Custom commands (tu skills/ va .claude/commands/):
${formatCommandList(customCommands)}
      `));
      continue;
    }

    // Custom slash commands
    if (input.startsWith('/')) {
      const [cmdName, ...rest] = input.slice(1).split(/\s+/);
      const args = rest.join(' ');
      const cmd = customCommands.get(cmdName);
      if (cmd) {
        const expanded = expandCommand(cmd, args);
        if (expanded) {
          console.log(chalk.gray(`  [${cmdName}] executing...\n`));
          // Fall through: treat expanded as input
          input = expanded;
        } else {
          console.log(chalk.red(`  Cannot expand /${cmdName}`));
          continue;
        }
      } else {
        console.log(chalk.red(`  Unknown command: /${cmdName}. Go /help de xem danh sach.`));
        continue;
      }
    }

    // @mention expansion
    const { prompt: expandedInput, attachments } = expandMentions(input, projectDir);
    const okAttach = attachments.filter(a => a.content).length;
    if (okAttach > 0) console.log(chalk.gray(`  @${okAttach} file(s) attached`));
    const errAttach = attachments.filter(a => a.error).length;
    if (errAttach > 0) {
      attachments.filter(a => a.error).forEach(a =>
        console.log(chalk.yellow(`  ⚠ @${a.path}: ${a.error}`))
      );
    }

    // Run prompt
    console.log('');
    let result;
    if (!hasRun) {
      result = await agent.run(systemPrompt, expandedInput);
      hasRun = true;
    } else {
      result = await agent.continueWith(expandedInput);
    }

    printResult(result);
    printCacheStats(agent);

    // Lưu session sau mỗi prompt
    cm.saveSession(session.id, {
      messages: agent.messages,
      filesChanged: [...agent.executor.filesChanged],
      commandsRun: agent.executor.commandsRun,
      toolStats: agent.executor.getStats()
    });

    console.log('');
  }

  // Lưu session lần cuối trước khi thoát
  cm.saveSession(session.id, {
    messages: agent.messages,
    filesChanged: [...agent.executor.filesChanged],
    commandsRun: agent.executor.commandsRun,
    toolStats: agent.executor.getStats()
  });

  console.log(chalk.gray(`\n  Session saved: ${session.id}`));
  console.log(chalk.gray('  Bye!\n'));
}

// === Print Result ===
function printResult(result) {
  console.log('');
  console.log(chalk.gray('  ─'.repeat(25)));

  if (result.success) {
    console.log(chalk.green.bold('  ✓ XONG'));
    if (result.summary) {
      console.log(chalk.white(`  ${result.summary}`));
    }
  } else {
    console.log(chalk.red.bold(`  ✗ ${result.aborted ? 'DỪNG' : 'CHƯA XONG'}`));
    if (result.reason === 'too_many_errors') {
      console.log(chalk.red('  Quá nhiều lỗi liên tiếp'));
    } else if (result.reason === 'max_iterations') {
      console.log(chalk.yellow('  Đạt giới hạn iterations'));
    }
  }

  if (result.files_changed && result.files_changed.length > 0) {
    console.log(chalk.gray(`  ${result.files_changed.length} files thay đổi:`));
    result.files_changed.forEach(f => console.log(chalk.green(`    + ${f}`)));
  }

  console.log(chalk.gray(`  ${result.iterations} iterations | ${result.tool_calls || 0} tool calls | ${result.errors || 0} errors`));
  console.log(chalk.gray('  ─'.repeat(25)));
}

// === Run ===
program.parse();
