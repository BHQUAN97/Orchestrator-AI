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

// Force màu kể cả khi output qua pipe (WebUI terminal, SSH, tmux)
process.env.FORCE_COLOR = process.env.FORCE_COLOR || '1';

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const path = require('path');
const { AgentLoop } = require('../lib/agent-loop');
const { getToolsSummary } = require('../tools/definitions');
const { RepoMapper } = require('../lib/repo-mapper');
const { RepoCache } = require('../lib/repo-cache');
const { Config } = require('../lib/config');
const { ConversationManager } = require('../lib/conversation-manager');
const { expandMentions } = require('../lib/mention-expander');
const { discoverCommands, expandCommand, formatCommandList } = require('../lib/slash-commands');
const { askApproval, ApprovalState } = require('../tools/diff-approval');
const { getRegistry } = require('../tools/mcp-client');
const { loadInheritedMCPConfig, listAvailableServers } = require('../lib/mcp-auto-config');
const mcpCmds = (() => { try { return require('../tools/mcp-commands'); } catch { return null; } })();
const { FsWatcher } = (() => { try { return require('../lib/fs-watcher'); } catch { return {}; } })();
const { suggestParallelism } = (() => { try { return require('../lib/auto-concurrency'); } catch { return {}; } })();
const { shutdownMemoryWorkers } = (() => { try { return require('../lib/memory'); } catch { return {}; } })();
const { BudgetTracker } = require('../lib/budget');
const { HookRunner } = require('../lib/hooks');
const { runPlanFlow } = require('../lib/plan-mode');
const { initProject } = require('../lib/init-project');
const { renderStatusLine } = require('../lib/status-line');
const { WorktreeSession } = require('../lib/worktree');
const { suggestSkills } = require('../lib/skill-matcher');
const { renderMarkdown } = require('../lib/markdown-render');
const { InputQueue } = require('../lib/input-queue');
const { runDoctor, formatDoctor } = require('../lib/doctor');
const { estimatePromptCost } = require('../lib/cost-estimate');
const { LocalAssistant } = require('../lib/local-assistant');
const { loadClaudeMdHierarchy } = require('../lib/claude-md-loader');
const { TranscriptLogger } = require('../lib/transcript-logger');
const { renderTodos } = require('../tools/agent-todos');
const { MemoryStore } = require('../lib/memory');
const { ContextGuard, formatIssues } = require('../lib/context-guard');
const { HermesBridge } = require('../lib/hermes-bridge');
const { delegateToOrchestrator, checkOrchestratorHealth } = require('../lib/orchestrator-client');
const { replayTranscript, listTranscripts } = require('../lib/replay');
const { AgentBus } = require('../lib/agent-bus');
const { getRateLimitState } = require('../lib/retry');
const { getCostTracker } = require('../lib/cost-tracker');
const { SessionContinuity } = require('../lib/session-continuity');
const { RequestAnalyzer, routingToModel, formatAnalysisSummary } = require('../lib/request-analyzer');

const BUILTIN_CMDS = [
  'stats', 'files', 'undo', 'sessions', 'resume',
  'tokens', 'cost', 'budget', 'compact',
  'init', 'plan', 'mcp', 'cache',
  'doctor', 'todos', 'transcript', 'claudemd',
  'memory', 'team', 'guard', 'route', 'locks',
  'orchestrator', 'orch', 'delegate', 'bg',
  'replay', 'transcripts', 'redo', 'ratelimit', 'rl',
  'heal', 'healer',
  'exit', 'quit', 'help'
];

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
  .option('--plan', 'Plan mode: analyze + show plan before executing')
  .option('--resume [id]', 'Resume previous session (latest if no id given)')
  .option('--budget <usd>', 'Cap session cost in USD (e.g. 0.50). Aborts agent when exceeded.')
  .option('-y, --yes', 'Auto-approve all file changes (skip diff approval in interactive mode)')
  .option('--no-cache', 'Disable Anthropic prompt caching')
  .option('--no-mcp', 'Disable MCP server loading')
  .option('--no-hooks', 'Disable hooks (PreToolUse/PostToolUse/Stop)')
  .option('--no-repo-cache', 'Force re-scan repo (skip repo-cache.json)')
  .option('--no-warm-context', 'Disable auto warm-context từ session trước (fresh start)')
  .option('--mcp-config <path>', 'Path to additional MCP config JSON')
  .option('--worktree', 'Run agent in isolated git worktree (safer for destructive ops)')
  .option('--no-markdown', 'Disable markdown rendering in output')
  .option('--no-status-line', 'Hide status line in interactive mode')
  .option('--doctor', 'Run environment health check and exit')
  .option('--estimate-threshold <usd>', 'Confirm before run when estimated cost exceeds this (default 0.50)', '0.50')
  .option('--thinking', 'Enable extended thinking for Claude models')
  .option('--thinking-budget <tokens>', 'Extended thinking budget (default 8000)', '8000')
  .option('--no-thinking-auto', 'Disable auto-thinking for complex prompt keywords')
  .option('--no-transcript', 'Disable transcript logging to .orcai/transcripts/')
  .option('--no-memory', 'Disable memory store (kinh nghiem tich luy giua session)')
  .option('--no-context-guard', 'Disable anti-hallucination context guard')
  .option('--auto-route', 'Auto-select model per task using Hermes SmartRouter')
  .option('--use-classifier', 'Use LLM classifier for routing (more accurate, costs ~$0.0001/call)')
  .option('--no-hermes', 'Disable Hermes bridge (SmartRouter + DecisionLock)')
  .option('--via-orchestrator', 'Delegate task to full Orchestrator pipeline (scan→plan→review→execute)')
  .option('--orchestrator-url <url>', 'Orchestrator URL', process.env.ORCHESTRATOR_URL || 'http://localhost:5003')
  .option('--no-parallel', 'Disable parallel execution of read-safe tools')
  .option('--watch', 'Enable fs watcher to auto-invalidate cache on file changes')
  .option('--retries <n>', 'Number of LLM retries on network/429/503 errors (default 3)', '3')
  .option('--replay <sessionId>', 'Replay transcript from previous session (use "latest" for most recent)')
  .option('--replay-speed <ms>', 'Delay between events when replaying (default 0)', '0')
  .option('--replay-filter <type>', 'Only show events of type: message|tool_call|tool_result|meta|error')
  .option('--replay-verbose', 'Show full args in replay')
  .action(async (promptParts, opts) => {
    const prompt = promptParts.join(' ').trim();
    const projectDir = path.resolve(opts.project);

    // Load config — CLI options override config file
    const cfg = new Config();
    cfg.load();
    if (!opts.model || opts.model === 'smart') opts.model = opts.model || cfg.get('model') || 'smart';
    if (!opts.url || opts.url === 'http://localhost:5002') opts.url = cfg.get('litellm.url') || opts.url;
    if (!opts.key || opts.key === 'sk-master-change-me') opts.key = cfg.get('litellm.key') || opts.key;

    // --replay: phat lai transcript roi exit (khong can LLM)
    if (opts.replay) {
      const res = await replayTranscript(projectDir, opts.replay, {
        speed: parseInt(opts.replaySpeed, 10) || 0,
        filter: opts.replayFilter || null,
        verbose: !!opts.replayVerbose
      });
      if (!res.success) {
        console.log(chalk.red(`  ✗ ${res.error}`));
        const available = listTranscripts(projectDir).slice(0, 5);
        if (available.length) {
          console.log(chalk.gray('  Available sessions:'));
          for (const t of available) {
            console.log(chalk.gray(`    ${t.sessionId} (${new Date(t.mtime).toISOString().slice(0, 19)})`));
          }
        }
        process.exit(1);
      }
      return;
    }

    // Banner
    printBanner(projectDir, opts.model, opts.role);

    // Worktree isolation: relocate projectDir to worktree path
    let worktreeSession = null;
    if (opts.worktree) {
      try {
        worktreeSession = new WorktreeSession(projectDir);
        const wt = worktreeSession.create();
        console.log(chalk.cyan(`  🌿 Worktree: ${wt.path} (branch: ${wt.branch})`));
        projectDir = wt.path;
      } catch (e) {
        console.log(chalk.red(`  ✗ Worktree failed: ${e.message}`));
        process.exit(1);
      }
    }

    // Init MCP (async, best-effort — khong block neu server loi)
    const mcpRegistry = opts.mcp === false ? null : await initMCP(projectDir, opts);

    // Approval state share qua toan bo session
    const approvalState = new ApprovalState({ autoYes: !!opts.yes });

    // Budget tracker (shared across all agents in this run)
    const capUsd = opts.budget ? parseFloat(opts.budget) : Infinity;
    const budget = new BudgetTracker({ capUsd, model: opts.model });
    if (capUsd !== Infinity && capUsd > 0) {
      console.log(chalk.gray(`  Budget cap: $${capUsd.toFixed(4)}`));
    }

    // Hook runner (shared)
    const hookRunner = new HookRunner({ projectDir, enabled: opts.hooks !== false });
    hookRunner.load();
    const hookStats = hookRunner.getStats();
    const totalHooks = Object.values(hookStats).reduce((a, b) => a + b, 0);
    if (totalHooks > 0) {
      console.log(chalk.gray(`  Hooks: ${totalHooks} loaded (${Object.entries(hookStats).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(', ')})`));
    }

    opts._mcpRegistry = mcpRegistry;
    opts._approvalState = approvalState;
    opts._budget = budget;
    opts._hookRunner = hookRunner;

    // Wire daily cost tracker → real-time budget warnings
    const costTracker = getCostTracker(projectDir);
    costTracker.on('cap-warning', (e) => {
      const pct = e.percent.toFixed(0);
      const rem = (e.capUSD - e.currentUSD).toFixed(4);
      const label = e.capType === 'daily' ? 'Daily budget' : 'Task budget';
      console.log(chalk.yellow(`\n  ⚠ ${label} ${pct}%: $${e.currentUSD.toFixed(4)} / $${e.capUSD} — còn $${rem}`));
    });
    costTracker.on('cap-exceeded', (e) => {
      const label = e.capType === 'daily' ? 'Daily budget' : 'Task budget';
      const resetStr = _formatDuration(_msToMidnight());
      console.log(chalk.red(`\n  ✗ ${label} hết: $${e.currentUSD.toFixed(4)} / $${e.capUSD}`));
      console.log(chalk.gray(`    Reset lúc 00:00 — còn ${resetStr}`));
    });
    opts._costTracker = costTracker;

    // Agent bus (inter-agent messaging) — shared across CLI session
    opts._agentBus = new AgentBus();
    opts._agentBus.on('spawn', (e) => {
      console.log(chalk.gray(`  🤖 spawn ${e.subagent_type} (${e.agentId}) depth=${e.depth}: ${e.description.slice(0, 60)}`));
    });
    opts._agentBus.on('progress', (e) => {
      if (e.iteration % 5 === 0) {
        console.log(chalk.gray(`     [${e.agentId}] iter ${e.iteration}/${e.maxIterations}`));
      }
    });
    opts._agentBus.on('task_complete', (e) => {
      const icon = e.success ? chalk.green('✓') : chalk.red('✗');
      console.log(`  ${icon} [${e.agentId}] done in ${e.iterations} iter, ${Math.round(e.elapsed_ms/100)/10}s`);
    });

    // Memory store (shared across subagents + runs)
    if (opts.memory !== false) {
      opts._memoryStore = new MemoryStore(projectDir);
      const memStats = opts._memoryStore.getStats();
      if (memStats.total > 0) {
        console.log(chalk.gray(`  Memory: ${memStats.total} entries (${Object.entries(memStats.byType).map(([k, v]) => `${k}:${v}`).join(', ')})`));
      }
    }

    // Context guard (anti-hallucination)
    if (opts.contextGuard !== false) {
      opts._contextGuard = new ContextGuard();
    }

    // Phase 3: Auto-concurrency hint + optional fs watcher
    if (typeof suggestParallelism === 'function') {
      try {
        const p = suggestParallelism();
        opts._parallelism = p;
        if (process.env.ORCAI_DEBUG) {
          console.log(chalk.gray(`  Concurrency: subagent=${p.subagent} llm=${p.llm} io=${p.file_read}`));
        }
      } catch { /* fallback to defaults */ }
    }

    // Fs watcher — invalidate cache khi file thay doi (opt-in, bat qua --watch)
    if (opts.watch && typeof FsWatcher === 'function') {
      try {
        opts._fsWatcher = new FsWatcher({ paths: [projectDir] });
        opts._fsWatcher.on('change', () => { /* hook cho cache invalidation — reserved */ });
        opts._fsWatcher.on('error', () => {});
        console.log(chalk.gray(`  Fs watcher: on (${projectDir})`));
      } catch { /* optional */ }
    }

    // Hermes bridge (SmartRouter + DecisionLock + classifier)
    if (opts.hermes !== false) {
      opts._hermesBridge = new HermesBridge({
        projectDir,
        litellmUrl: opts.url,
        litellmKey: opts.key,
        useClassifier: !!opts.useClassifier
      });
      const activeLocks = opts._hermesBridge.getActiveLocks();
      if (activeLocks.length > 0) {
        console.log(chalk.yellow(`  🔒 Decision locks: ${activeLocks.length} active — /locks to list`));
      }
      if (opts.autoRoute) {
        console.log(chalk.gray('  Auto-route: on (per-task model selection via SmartRouter)'));
      }
    }

    // --via-orchestrator: delegate to full pipeline
    if (opts.viaOrchestrator && prompt) {
      await orchestratorMode(prompt, projectDir, opts);
      if (mcpRegistry) await mcpRegistry.shutdown();
      if (opts._fsWatcher?.close) opts._fsWatcher.close();
      if (typeof shutdownMemoryWorkers === 'function') await shutdownMemoryWorkers();
      return;
    }

    // --doctor: run health check and exit
    if (opts.doctor) {
      const results = await runDoctor({
        projectDir,
        litellmUrl: opts.url,
        litellmKey: opts.key,
        mcpRegistry,
        hookRunner
      });
      console.log(formatDoctor(results));
      if (mcpRegistry) await mcpRegistry.shutdown();
      if (opts._fsWatcher?.close) opts._fsWatcher.close();
      if (typeof shutdownMemoryWorkers === 'function') await shutdownMemoryWorkers();
      return;
    }

    // Luon dung interactive mode — neu co prompt thi chay prompt do truoc, roi o lai session
    await interactiveMode(projectDir, { ...opts, initialPrompt: prompt || null });

    // Cleanup
    if (mcpRegistry) await mcpRegistry.shutdown();

    // Worktree cleanup
    if (worktreeSession && worktreeSession.created) {
      const hasChanges = worktreeSession.hasChanges();
      if (hasChanges) {
        console.log(chalk.yellow(`\n  🌿 Worktree has changes at: ${worktreeSession.worktreePath}`));
        console.log(chalk.gray(`     Branch: ${worktreeSession.branch}`));
        console.log(chalk.gray(`     Review then merge: cd ${projectDir} && git log ${worktreeSession.branch}`));
        console.log(chalk.gray(`     Cleanup when done: git worktree remove "${worktreeSession.worktreePath}" && git branch -D ${worktreeSession.branch}`));
      } else {
        worktreeSession.cleanup({ deleteBranch: true });
        console.log(chalk.gray('  🌿 Worktree clean, auto-removed.'));
      }
    }
  });

// === Budget helpers ===
function _msToMidnight() {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return midnight - now;
}
function _formatDuration(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

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
  const W = 50;
  const line = chalk.gray('  ' + '─'.repeat(W));
  console.log('');
  console.log(line);
  console.log(chalk.cyan.bold('  ◆ OrcAI') + chalk.gray(' v2  ') + chalk.gray('·') + chalk.gray('  ' + projectName));
  console.log(chalk.gray('  ') + chalk.yellow('⬡ ' + model) + chalk.gray('  ·  ') + chalk.green('◈ ' + role));
  console.log(line);
}

// Build context block tu session truoc (warm) hoac local assistant (embed)
// Uu tien: local assistant > warm context > nothing
function buildWarmBlock(opts) {
  // Local assistant block (tu embedding search + Qwen 7B summary)
  if (opts._localContextBlock) return opts._localContextBlock;
  // Warm context tu session truoc
  const files = opts._warmFiles;
  if (!files || files.length === 0) return '';
  const lines = files.map(f => {
    const preview = (f.content || '').slice(0, 2000);
    return `--- ${f.path} ---\n${preview}${f.content.length > 2000 ? '\n[... truncated]' : ''}`;
  }).join('\n\n');
  return `\n\n=== PRE-LOADED FILES (session trước — KHÔNG cần read_file lại) ===\n${lines}\n=== END PRE-LOADED ===`;
}

// === Build System Prompt (với repo context) ===
async function buildSystemPrompt(projectDir, role, opts = {}) {
  const projectName = path.basename(projectDir);

  // Load CLAUDE.md hierarchy (global + walk up parents)
  const { content: claudeMd, sources: claudeMdSources } = loadClaudeMdHierarchy(projectDir);
  const claudeMdBlock = claudeMd
    ? `\n\n=== CLAUDE.md (${claudeMdSources.length} file${claudeMdSources.length > 1 ? 's' : ''}) ===\n${claudeMd}\n=== END CLAUDE.md ===`
    : '';

  // MCP routing hint — agent biet server nao co tools nao
  let mcpHint = '';
  if (opts._mcpRegistry) {
    const mcpStats = opts._mcpRegistry.getStats();
    if (mcpStats.servers > 0) {
      const serverSummary = mcpStats.serverList.map(name => {
        const client = opts._mcpRegistry.clients.get(name);
        const sampleTools = (client?.tools || []).slice(0, 5).map(t => t.name).join(', ');
        return `  - ${name}: ${sampleTools}${client?.tools?.length > 5 ? ` (+${client.tools.length - 5} more)` : ''}`;
      }).join('\n');
      mcpHint = `\n\n=== MCP Servers Available ===\n${serverSummary}\n\nKhi goi MCP tool dung ten day du: mcp__<server>__<tool>. Uu tien MCP neu task lien quan external service (github, playwright, docker, filesystem ngoai project, memory graph...)\n=== END MCP ===`;
    }
  }

  // Direct mode: skip repo scan cho prompt nho gon + nhanh (nhung VAN bao gom CLAUDE.md)
  if (opts.direct) {
    return `Ban la AI Coding Agent trong project "${projectName}" (${projectDir}).

TOOLS: ${getToolsSummary()}

Nguyen tac hieu qua (QUAN TRONG — tiet kiem token):
- TRUST TOOL OUTPUT: neu search_files / glob / grep tra ve so ket qua, TIN ket qua do. KHONG read_file de "double-check" — moi read_file ton 2-10K token.
- Uu tien search_files hoac glob truoc read_file cho task dem/tim. read_file chi khi thuc su can hieu code.
- KHONG goi cung tool voi cung args 2 lan. Neu ket qua chua ro, chuyen cach tiep can khac.
- Sua file: edit_file cho patch nho, write_file cho file moi/ghi de.
- Verify bang execute_command (test, build, lint).
- Goi task_complete voi summary ngan khi xong.
- Comment business logic tieng Viet, technical tieng Anh.${claudeMdBlock}${mcpHint}`;
  }

  // Quét project structure — uu tien RepoCache (1hr TTL, invalidate theo git HEAD + package.json)
  let repoContext = '';
  try {
    if (opts.repoCache !== false) {
      const cache = new RepoCache({ projectDir });
      repoContext = await cache.getSummary();
    } else {
      const mapper = new RepoMapper({ projectDir });
      repoContext = await mapper.getCompactSummary(projectDir);
    }
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
9. Task > 3 step → dung todo_write de track progress (user thay list)
10. Truoc task moi → memory_recall(query) de xem kinh nghiem cu co lien quan
11. Phat hien bug/bay quan trong → memory_save(type: "gotcha", ...) de nho cho lan sau
12. Task doc lap CO THE lam song song → spawn_team (max 5 agent parallel) thay vi tung spawn_subagent

HIEU QUA TOKEN (QUAN TRONG — VI PHAM SE LANG PHI TIEN):
- PROJECT STRUCTURE da co o tren (=== PROJECT STRUCTURE ===). KHONG goi list_files("/") hay glob("**") de "quet lai" — da co roi.
- TRUST TOOL OUTPUT: neu search_files / glob tra ve so ket qua, TIN ket qua. KHONG read_file de "double-check".
- Task dem/tim file: DUNG search_files/glob voi pattern cu the. KHONG list toan bo roi dem tay.
- KHONG goi cung read_file voi cung path 2 lan trong cung session — reuse tu history.
- Neu PRE-LOADED FILES co o duoi, KHONG doc lai — content da co san.
- Neu task co the tra loi bang 1 tool call hoac suy luan tu context, tra loi luon.

QUY TRÌNH:
1. memory_recall(prompt) — xem kinh nghiem cu neu co
2. Đọc files liên quan (read_file, list_files, glob, search_files)
3. Lập kế hoạch ngắn (trong đầu, không cần output). Neu > 3 step → todo_write
4. Thực hiện thay đổi (edit_file hoặc write_file hoac edit_files cho batch)
5. Verify (execute_command: chạy test, build, lint)
6. Sửa nếu cần (self-correction loop)
7. Gọi task_complete khi xong (summary se duoc context-guard verify)${claudeMdBlock}${mcpHint}${buildWarmBlock(opts)}`;
}

// === Create Agent Loop với callbacks ===
function createAgent(projectDir, opts) {
  let spinner = null;
  let currentTool = '';
  let currentArgs = null;
  let _llmStart = null;
  // Buffer text streaming — flush + render markdown khi tool call bat dau hoac response done
  let _textBuf = '';
  const flushText = () => {
    if (!_textBuf) return;
    const rendered = opts.markdown !== false ? renderMarkdown(_textBuf) : _textBuf;
    process.stdout.write('\n' + rendered + '\n');
    _textBuf = '';
  };

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
    budget: opts._budget || null,
    hookRunner: opts._hookRunner || null,
    hooks: opts.hooks !== false,
    interactive: !!opts.interactive,
    thinking: !!opts.thinking,
    thinkingAuto: opts.thinkingAuto !== false,
    thinkingBudget: parseInt(opts.thinkingBudget || '8000'),
    transcriptLogger: opts._transcriptLogger || null,
    memoryStore: opts._memoryStore || null,
    memory: opts.memory !== false,
    contextGuard: opts._contextGuard || null,
    contextGuardEnabled: opts.contextGuard !== false,
    hermesBridge: opts._hermesBridge || null,
    hermes: opts.hermes !== false,
    autoRoute: !!opts.autoRoute,
    useClassifier: !!opts.useClassifier,
    parallelReadSafe: opts.parallel !== false,
    retries: parseInt(opts.retries || '3'),
    agentBus: opts._agentBus || null,

    // Diff approval — chi hoi trong interactive mode + co TTY
    onWriteApproval: (opts.interactive && !approvalState.autoYes)
      ? async (filePath, before, after) => {
          if (spinner) spinner.stop();
          opts._iqRef?.q?.mute();
          try {
            return await askApproval(filePath, before, after, approvalState);
          } finally {
            opts._iqRef?.q?.unmute();
          }
        }
      : null,

    // Human-in-the-loop confirm — mute InputQueue trước để tránh conflict readline trên cùng stdin
    onConfirm: opts.confirm !== false ? async (command, reason) => {
      if (spinner) spinner.stop();
      opts._iqRef?.q?.mute();
      try {
        return await new Promise(resolve => {
          const readline = require('readline');
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const msg = chalk.yellow(`\n  ⚠️  ${reason}\n  Command: ${chalk.white(command)}\n  Cho phép? [y/N] `);
          rl.question(msg, (ans) => {
            rl.close();
            resolve(ans.trim().toLowerCase() === 'y');
          });
        });
      } finally {
        opts._iqRef?.q?.unmute();
      }
    } : null,

    // Agent self-todos: re-render moi khi thay doi
    onTodosUpdate: (todos) => {
      if (spinner) spinner.stop();
      if (todos.length > 0) {
        console.log(chalk.gray('  ── Todos ──'));
        console.log(renderTodos(todos));
        console.log(chalk.gray('  ───────────'));
      }
    },

    // Callbacks cho UI
    onThinking: (iter, max) => {
      flushText();
      if (spinner) spinner.stop();
      _llmStart = Date.now();
      spinner = ora({
        text: chalk.gray(`Thinking... (${iter}/${max})`),
        spinner: 'dots'
      }).start();
    },

    onToolCall: (name, args) => {
      flushText();
      currentTool = name;
      currentArgs = args;
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
      const args = currentArgs || {};

      if (spinner) spinner.stop();

      if (name === 'read_file' && parsed.success) {
        const p = chalk.cyan(args.path || parsed.path || '?');
        console.log(`  ${icon} ${chalk.cyan('read')} ${p} ${chalk.gray(`(${parsed.showing} / ${parsed.total_lines} lines)`)}`);
      } else if (name === 'write_file' && parsed.success) {
        const action = parsed.action === 'created' ? chalk.green('new') : chalk.yellow('write');
        console.log(`  ${icon} ${action} ${chalk.white(parsed.path)} ${chalk.gray(`(${parsed.lines} lines)`)}`);
      } else if (name === 'edit_file' && parsed.success) {
        console.log(`  ${icon} ${chalk.yellow('edit')} ${chalk.white(parsed.path)} ${chalk.gray(`(${parsed.replacements} replacements)`)}`);
      } else if (name === 'execute_command') {
        const cmd = args.command?.slice(0, 80) || '?';
        const exitCode = parsed.exit_code ?? parsed.exit;
        const exitIcon = exitCode === 0 ? chalk.green('✓') : chalk.red(`✗ exit ${exitCode}`);
        console.log(`  ${exitIcon} ${chalk.blue('$')} ${chalk.white(cmd)}`);
        if (parsed.stdout) {
          const lines = parsed.stdout.trimEnd().split('\n');
          const preview = lines.slice(0, 5).map(l => '    ' + l).join('\n');
          console.log(chalk.gray(preview));
          if (lines.length > 5) console.log(chalk.gray(`    … +${lines.length - 5} lines`));
        }
        if (parsed.stderr && exitCode !== 0) {
          console.log(chalk.red('    ' + parsed.stderr.split('\n').slice(0, 3).join('\n    ')));
        }
      } else if (name === 'search_files' && parsed.success) {
        console.log(`  ${icon} ${chalk.magenta('search')} ${chalk.gray('"')}${parsed.pattern}${chalk.gray('"')} ${chalk.gray('→')} ${chalk.white(parsed.total)} matches`);
      } else if (name === 'list_files' && parsed.success) {
        const p = args.path || '.';
        console.log(`  ${icon} ${chalk.cyan('list')} ${chalk.gray(p)} ${chalk.gray(`(${parsed.files.length} entries)`)}`);
      } else if (name === 'grep_files' && parsed.success) {
        console.log(`  ${icon} ${chalk.magenta('grep')} ${chalk.gray('"')}${args.pattern || '?'}${chalk.gray('"')} ${chalk.gray('→')} ${chalk.white(parsed.total ?? parsed.matches?.length ?? '?')} matches`);
      } else if (name === 'task_complete') {
        // Handled in printResult
      } else if (!parsed.success) {
        console.log(`  ${icon} ${chalk.red(name)}: ${chalk.gray((parsed.error || '').slice(0, 120))}`);
      }
    },

    onText: (text) => {
      if (spinner) { spinner.stop(); spinner = null; }
      // Buffer streaming chunks — flush + render markdown khi tool call hoac response done
      _textBuf += text;
    },

    onComplete: () => {
      flushText();
      if (_llmStart) {
        const ms = Date.now() - _llmStart;
        const label = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
        process.stdout.write(chalk.gray(`  ⏱ ${label}\n`));
        _llmStart = null;
      }
    },

    onError: (err) => {
      if (spinner) spinner.stop();
      console.log(chalk.red(`\n  ✗ ${err}`));
    }
  });

  return { agent, getSpinner: () => spinner };
}

// === Orchestrator delegation ===
async function orchestratorMode(prompt, projectDir, opts) {
  const orchestratorUrl = opts.orchestratorUrl;
  console.log(chalk.cyan(`  🤖 Delegating to Orchestrator at ${orchestratorUrl}...`));

  const res = await delegateToOrchestrator({
    prompt,
    projectDir,
    projectName: path.basename(projectDir),
    orchestratorUrl,
    onProgress: (evt) => {
      if (evt.step) console.log(chalk.gray(`  [${evt.step}] ${evt.message || evt.status || ''}`));
      else if (evt.message) console.log(chalk.gray(`  ${evt.message}`));
    }
  });

  if (!res.success) {
    console.log(chalk.red(`\n  ✗ Orchestrator delegation failed:`));
    console.log(chalk.red(`    ${res.error}`));
    console.log(chalk.gray('\n  Fallback: dung truc tiep orcai (bo --via-orchestrator flag)'));
    return;
  }

  console.log(chalk.green('\n  ✓ Orchestrator completed'));
  if (res.trace_id) console.log(chalk.gray(`    Trace: ${res.trace_id}`));
  if (res.cost_usd) console.log(chalk.gray(`    Cost: $${res.cost_usd.toFixed(4)}`));
  if (res.result?.summary) {
    console.log('');
    console.log(chalk.white(res.result.summary));
  }
  if (res.result?.files_changed?.length) {
    console.log(chalk.gray(`    ${res.result.files_changed.length} files changed:`));
    res.result.files_changed.forEach(f => console.log(chalk.green(`      + ${f}`)));
  }
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

  // Pre-run cost estimate — skip khi auto-approve (--yes), --no-confirm, hoac benchmark mode
  const threshold = parseFloat(opts.estimateThreshold || '0.50');
  const skipCostPrompt = opts.yes || opts.confirm === false || process.env.ORCAI_BENCHMARK === '1';
  if (!skipCostPrompt && threshold > 0) {
    const est = estimatePromptCost({ systemPrompt, userPrompt: expanded, model: opts.model });
    if (est.cost_est_usd >= threshold) {
      console.log(chalk.yellow(`  💰 Estimated cost: $${est.cost_est_usd.toFixed(4)} (range $${est.cost_range_usd[0].toFixed(4)} - $${est.cost_range_usd[1].toFixed(4)}), ~${est.iterations_est} iterations`));
      try {
        const { proceed } = await inquirer.prompt([{
          type: 'confirm', name: 'proceed',
          message: 'Proceed?', default: true
        }]);
        if (!proceed) {
          console.log(chalk.gray('  Cancelled.'));
          return;
        }
      } catch { return; /* Ctrl+C */ }
    }
  }

  // Plan mode: analyze first, then execute
  if (opts.plan) {
    const systemPlanner = await buildSystemPrompt(projectDir, 'planner', opts);
    const result = await runPlanFlow(expanded, {
      systemPromptPlanner: systemPlanner,
      systemPromptBuilder: systemPrompt,
      createPlannerAgent: () => createAgent(projectDir, { ...opts, role: 'planner' }).agent,
      createBuilderAgent: () => createAgent(projectDir, opts).agent
    });
    if (!result.approved) {
      console.log(chalk.gray('\n  Plan rejected. Nothing executed.'));
      return;
    }
    printResult(result.result);
    return;
  }

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
  const costStr = stats.cost?.spent_usd > 0 ? ` | cost: $${stats.cost.spent_usd.toFixed(4)}` : '';
  console.log(chalk.gray(`  Tokens: ${stats.total_input_tokens} in, ${stats.total_completion_tokens} out | cache hit: ${stats.cache_hit_rate_pct}%${savings}${costStr}`));
}

// === Interactive Mode ===
async function interactiveMode(projectDir, opts) {
  const systemPrompt = await buildSystemPrompt(projectDir, opts.role, opts);
  // Ref lazy — được điền vào sau khi inputQueue được tạo (dưới).
  // Dùng để onConfirm / onWriteApproval có thể mute InputQueue tránh conflict stdin.
  const _iqRef = { q: null };
  const { agent } = createAgent(projectDir, { ...opts, _iqRef });
  let hasRun = false;
  const _sessionStart = Date.now();
  let _exchangeCount = 0;

  // Discover custom slash commands (skills/*.md + .claude/commands/*.md + global)
  const customCommands = discoverCommands(projectDir);

  // Transcript logger
  if (opts.transcript !== false) {
    // Session created below; use tmp id until real session id exists
    // (actual init happens after session creation)
  }

  // Session management — support --resume
  const cm = new ConversationManager({ projectDir });
  let session;
  if (opts.resume) {
    const target = opts.resume === true
      ? cm.getLastSession()
      : cm.loadSession(opts.resume);
    if (target && target.id) {
      session = { id: target.id, createdAt: target.createdAt, projectDir };
      // Restore messages into agent
      if (Array.isArray(target.messages) && target.messages.length > 0) {
        agent.messages = target.messages;
        hasRun = true;
        console.log(chalk.green(`  Resumed session ${session.id} — ${target.messages.length} messages, ${(target.filesChanged || []).length} file(s) changed previously.`));
      } else {
        console.log(chalk.yellow(`  Session ${session.id} is empty — starting fresh.`));
      }
    } else {
      console.log(chalk.yellow('  No prior session found, starting new.'));
      session = cm.createSession();
    }
  } else {
    session = cm.createSession();

    // Auto warm-context: lay file content tu session gan nhat inject vao systemPrompt
    // KHONG inject vao messages (tranh malformed history / context lan)
    // Chi dung khi: cung project, < 30 phut, git HEAD chua thay doi
    if (opts.warmContext !== false) {
      try {
        const { execSync } = require('child_process');
        const currentHead = (() => {
          try { return execSync('git rev-parse HEAD', { cwd: projectDir, stdio: ['pipe','pipe','pipe'] }).toString().trim(); } catch { return null; }
        })();
        const warmFiles = cm.getWarmContext({ maxAgeMs: 30 * 60 * 1000, currentGitHead: currentHead, maxFiles: 10 });
        if (warmFiles.length > 0) {
          // Luu vao opts de buildSystemPrompt inject
          opts._warmFiles = warmFiles;
          console.log(chalk.gray(`  ♻ Warm: ${warmFiles.length} file(s) từ session trước đã pre-loaded vào context`));
        }
      } catch { /* ignore */ }
    }

    // Init LocalAssistant (Qwen 7B + nomic embed)
    // Bootstrap: auto-start LM Studio nếu cần, retry 3 lần, fallback cloud-only
    if (opts.localAssist !== false) {
      try {
        const { EmbeddingStore } = require('../lib/embeddings');
        const lmUrl = process.env.LMSTUDIO_URL || 'http://localhost:1234';
        const embeddings = new EmbeddingStore({ projectDir, endpoint: lmUrl });
        opts._localAssistant = new LocalAssistant({ projectDir, embeddings, lmUrl });

        // Bootstrap non-blocking — không delay startup, log khi xong
        opts._localAssistant.isAvailable().then(avail => {
          if (avail) {
            console.log(chalk.gray('  🤖 Local assist ready (Qwen 7B + nomic embed)'));
          } else {
            console.log(chalk.gray('  ℹ Local assist offline — cloud-only mode'));
          }
        }).catch(() => {
          console.log(chalk.gray('  ℹ Local assist unavailable — cloud-only mode'));
        });
      } catch { opts._localAssistant = null; }
    }
  }

  // Initialize transcript logger with actual session id
  if (opts.transcript !== false) {
    const logger = new TranscriptLogger({ projectDir, sessionId: session.id });
    opts._transcriptLogger = logger;
    agent.transcriptLogger = logger;
    logger.logMeta({ event: 'session_start', sessionId: session.id, model: opts.model, role: opts.role });
  }

  // Session continuity — snapshot in-flight state, cho phép resume sau khi budget hết / crash
  const _sc = new SessionContinuity({ projectDir });
  const _scId = _sc.startSession({ prompt: opts.initialPrompt || '' });
  const _scHandle = _sc.attachToConversation(null, { sessionId: _scId, snapshotEveryTurns: 5 });

  // Request analyzer — phân tích intent + routing trước mỗi prompt
  const requestAnalyzer = new RequestAnalyzer({
    litellmUrl: opts.url,
    litellmKey: opts.key,
    projectStack: opts._stackProfile || ''
  });

  console.log(chalk.gray(`  Session: ${session.id}`));
  if (opts._transcriptLogger) {
    console.log(chalk.gray(`  Transcript: ${path.relative(projectDir, opts._transcriptLogger.getPath())}`));
  }
  if (customCommands.size > 0) {
    console.log(chalk.gray(`  ${customCommands.size} custom command(s) loaded. /help to list.`));
  }
  console.log(chalk.gray('  Gõ prompt. @path để attach file. /help để xem commands.\n'));

  // InputQueue — always-on listener, buffer input khi agent chạy
  const inputQueue = new InputQueue();
  _iqRef.q = inputQueue; // wire lazy ref để onConfirm / onWriteApproval có thể mute
  inputQueue.start();
  inputQueue.updateCompleter({
    projectDir,
    customCommandNames: [...customCommands.keys()],
    builtinCommandNames: BUILTIN_CMDS
  });

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

  // Neu co initialPrompt (tu one-shot), dung luon khong hoi
  let _pendingInitial = opts.initialPrompt || null;

  while (true) {
    // Status line — hien thi state truoc prompt
    if (opts.statusLine !== false && hasRun) {
      const line = renderStatusLine(agent, {
        sessionId: session.id,
        projectName: path.basename(projectDir)
      });
      if (line) console.log(line);
    }

    let input;
    if (_pendingInitial) {
      input = _pendingInitial;
      _pendingInitial = null;
    } else {
      try {
        // Cập nhật completer mỗi vòng (custom commands có thể thay đổi)
        inputQueue.updateCompleter({
          projectDir,
          customCommandNames: [...customCommands.keys()],
          builtinCommandNames: BUILTIN_CMDS
        });
        input = await inputQueue.next(chalk.cyan('❯ '));
      } catch {
        break; // Ctrl+C / SIGINT
      }
    }

    if (!input) continue;

    // Suggest matching skills (non-intrusive) — chi khi prompt la text thuong, khong slash
    if (!input.startsWith('/')) {
      try {
        const matches = suggestSkills(input, projectDir, 2);
        if (matches.length > 0 && matches[0].score >= 0.3) {
          const m = matches[0];
          console.log(chalk.gray(`  💡 matching skill: /${m.name} (score ${m.score}, keywords: ${m.matched.slice(0, 3).join(', ')})`));
        }
      } catch { /* ignore matcher errors */ }
    }

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

    if (input === '/mcp' || input.startsWith('/mcp ')) {
      const registry = opts._mcpRegistry;
      const sub = input.slice(4).trim(); // empty | "list" | "tools <srv>" | "enable <srv>" | "disable <srv>" | "call <mcp__s__t> {json}"

      // Legacy behavior: /mcp (no args) → status
      if (!sub) {
        if (!registry) {
          console.log(chalk.gray('  MCP: no servers connected'));
        } else {
          const stats = registry.getStats();
          console.log(chalk.gray(`  MCP: ${stats.servers} server(s), ${stats.tools} tool(s)`));
          stats.serverList.forEach(s => console.log(chalk.gray(`    - ${s}`)));
          if (stats.errors.length > 0) {
            stats.errors.forEach(e => console.log(chalk.yellow(`    ⚠ ${e.server || e.path}: ${e.error}`)));
          }
          console.log(chalk.gray('  Subcmds: /mcp list | /mcp tools <srv> | /mcp enable <srv> | /mcp disable <srv> | /mcp call <mcp__s__t> <json>'));
        }
        continue;
      }

      if (!mcpCmds) { console.log(chalk.yellow('  mcp-commands module missing')); continue; }

      const [action, ...rest] = sub.split(/\s+/);
      try {
        if (action === 'list') {
          const out = listAvailableServers(projectDir);
          const servers = Array.isArray(out) ? out : (out.servers || []);
          console.log(chalk.gray(`  Available servers (${servers.length}):`));
          servers.forEach(s => {
            const flag = s.disabled ? chalk.red('✗') : chalk.green('✓');
            const transport = s.transport || (s.command ? 'stdio' : 'sse');
            console.log(chalk.gray(`    ${flag} ${s.name.padEnd(20)} ${chalk.dim(s.source)} ${chalk.dim('['+transport+']')}`));
          });
        } else if (action === 'tools') {
          const r = await mcpCmds.mcpTools(registry, rest[0]);
          console.log(r.output);
        } else if (action === 'enable') {
          const r = await mcpCmds.mcpEnable(projectDir, rest[0]);
          console.log(r.ok ? chalk.green(r.output) : chalk.yellow(r.output));
        } else if (action === 'disable') {
          const r = await mcpCmds.mcpDisable(projectDir, rest[0]);
          console.log(r.ok ? chalk.green(r.output) : chalk.yellow(r.output));
        } else if (action === 'call') {
          const toolName = rest[0];
          const argsJson = rest.slice(1).join(' ') || '{}';
          const r = await mcpCmds.mcpCall(registry, toolName, argsJson);
          console.log(r.output);
        } else {
          console.log(chalk.yellow(`  Unknown subcmd: ${action}`));
        }
      } catch (e) {
        console.log(chalk.red(`  MCP error: ${e.message}`));
      }
      continue;
    }

    if (input === '/cache on') { agent.promptCaching = true; console.log(chalk.gray('  cache: on')); continue; }
    if (input === '/cache off') { agent.promptCaching = false; console.log(chalk.gray('  cache: off')); continue; }

    if (input === '/todos') {
      const todos = agent.executor.todoStore.list();
      if (todos.length === 0) {
        console.log(chalk.gray('  (no todos)'));
      } else {
        console.log(renderTodos(todos));
        const stats = agent.executor.todoStore.getStats();
        console.log(chalk.gray(`  total ${stats.total} | pending ${stats.pending} | in_progress ${stats.in_progress} | completed ${stats.completed}`));
      }
      continue;
    }

    if (input === '/transcript') {
      const tp = opts._transcriptLogger?.getPath();
      if (tp) console.log(chalk.gray(`  Transcript: ${tp}`));
      else console.log(chalk.yellow('  Transcript logging disabled. Restart without --no-transcript.'));
      continue;
    }

    if (input === '/transcripts') {
      const list = listTranscripts(projectDir);
      if (!list.length) { console.log(chalk.gray('  No transcripts saved.')); continue; }
      console.log(chalk.gray(`  ${list.length} session(s):`));
      for (const t of list.slice(0, 10)) {
        const ts = new Date(t.mtime).toISOString().slice(0, 19);
        const kb = (t.size / 1024).toFixed(1);
        console.log(chalk.gray(`    ${t.sessionId} — ${ts} — ${kb}KB`));
      }
      console.log(chalk.gray('  Replay: /replay <id>  or  orcai --replay <id>'));
      continue;
    }

    if (input.startsWith('/replay')) {
      const id = input.slice('/replay'.length).trim() || 'latest';
      await replayTranscript(projectDir, id, { verbose: false });
      continue;
    }

    if (input === '/heal' || input === '/healer') {
      const h = agent.selfHealer;
      if (!h) { console.log(chalk.yellow('  Self-healer disabled.')); continue; }
      const stats = h.getStats();
      console.log(chalk.gray(`  Self-healer: ${stats.observed} observed | ${stats.gotchas_saved} gotchas | ${stats.recoveries_saved} recoveries | ${stats.active_streaks} active streaks | ${stats.pending_suggestions} pending`));
      if (h.lastErrors.length > 0) {
        console.log(chalk.gray(`  Recent errors:`));
        for (const e of h.lastErrors.slice(-5)) {
          console.log(chalk.gray(`    ${e.toolName}: ${e.errorText.slice(0, 80)}`));
        }
      }
      continue;
    }

    if (input === '/ratelimit' || input === '/rl') {
      const rl = getRateLimitState();
      if (rl.remaining == null && rl.lastError == null) {
        console.log(chalk.gray('  No rate limit data yet (make some requests first).'));
      } else {
        if (rl.limit != null) console.log(chalk.gray(`  Requests: ${rl.remaining}/${rl.limit}`));
        if (rl.resetAt) console.log(chalk.gray(`  Reset: ${new Date(rl.resetAt).toISOString()}`));
        if (rl.retryCount > 0) console.log(chalk.yellow(`  Retries this session: ${rl.retryCount}`));
        if (rl.lastError) {
          const ago = Math.round((Date.now() - rl.lastError.ts) / 1000);
          console.log(chalk.red(`  Last 429/5xx: ${ago}s ago (HTTP ${rl.lastError.status})`));
        }
      }
      continue;
    }

    if (input === '/redo') {
      // Tim user message cuoi cung (khong phai slash cmd) va re-run
      const userMsgs = agent.messages.filter(m => m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('/'));
      if (!userMsgs.length) { console.log(chalk.yellow('  No previous prompt to redo.')); continue; }
      const last = userMsgs[userMsgs.length - 1].content;
      console.log(chalk.gray(`  Redo: ${last.slice(0, 100)}${last.length > 100 ? '...' : ''}`));
      // Reset agent state cho clean re-run
      agent.completed = false;
      agent.aborted = false;
      agent.iteration = 0;
      input = last; // Fall through to normal prompt handling
    }

    if (input === '/claudemd') {
      const { sources } = loadClaudeMdHierarchy(projectDir);
      if (sources.length === 0) {
        console.log(chalk.yellow('  No CLAUDE.md found in hierarchy. Try /init to generate one.'));
      } else {
        console.log(chalk.gray(`  CLAUDE.md hierarchy (${sources.length} file${sources.length > 1 ? 's' : ''}):`));
        sources.forEach(s => console.log(chalk.gray(`    [${s.source}] ${s.path} (${s.bytes}B)`)));
      }
      continue;
    }

    if (input === '/memory' || input.startsWith('/memory ')) {
      const store = opts._memoryStore;
      if (!store) { console.log(chalk.yellow('  Memory disabled.')); continue; }
      const rest = input.slice('/memory'.length).trim();
      if (rest === '' || rest === 'list') {
        const stats = store.getStats();
        console.log(chalk.gray(`  Memory: ${stats.total} entries | ${stats.path}`));
        const recent = store.list({ limit: 10 });
        for (const e of recent) {
          const icon = e.type === 'gotcha' ? '⚠' : e.type === 'fact' ? 'ℹ' : '✓';
          console.log(chalk.gray(`  ${icon} [${e.type}] ${(e.summary || '').slice(0, 80)}`));
        }
      } else if (rest.startsWith('search ')) {
        const query = rest.slice(7);
        const results = store.search(query, 10);
        if (results.length === 0) console.log(chalk.gray('  No matches.'));
        results.forEach(r => console.log(chalk.gray(`  [${r._score}] ${r.summary?.slice(0, 80)}`)));
      } else if (rest === 'clear') {
        store.clear();
        console.log(chalk.yellow('  Memory cleared.'));
      } else {
        console.log(chalk.gray('  /memory [list|search <q>|clear]'));
      }
      continue;
    }

    if (input === '/guard') {
      const g = opts._contextGuard;
      if (!g) { console.log(chalk.yellow('  Context guard disabled.')); continue; }
      const gt = g.getGroundTruth();
      console.log(chalk.gray(`  Context guard — ground truth:`));
      console.log(chalk.gray(`    files changed: ${gt.files_changed.length}`));
      console.log(chalk.gray(`    files read:    ${gt.files_read.length}`));
      console.log(chalk.gray(`    commands run:  ${gt.commands_count} (${gt.failed_commands} failed)`));
      continue;
    }

    if (input === '/route') {
      if (!opts._hermesBridge) { console.log(chalk.yellow('  Hermes disabled.')); continue; }
      const history = opts._hermesBridge.getRoutingHistory(5);
      if (history.length === 0) {
        console.log(chalk.gray('  No routing decisions yet. Enable --auto-route to see decisions.'));
      } else {
        console.log(chalk.gray('  Last routing decisions:'));
        for (const h of history) {
          console.log(chalk.gray(`    → ${h.decision.model} (${h.decision.method}) — ${(h.decision.reasons || []).slice(0, 3).join(', ').slice(0, 80)}`));
        }
      }
      continue;
    }

    if (input === '/orchestrator' || input === '/orch') {
      const h = await checkOrchestratorHealth(opts.orchestratorUrl);
      if (h.ok) console.log(chalk.gray(`  Orchestrator OK at ${h.url} (HTTP ${h.status})`));
      else console.log(chalk.yellow(`  Orchestrator unreachable at ${h.url} — ${h.error || 'status ' + h.status}`));
      continue;
    }

    if (input.startsWith('/delegate ')) {
      const task = input.slice('/delegate '.length).trim();
      if (!task) { console.log(chalk.yellow('  Usage: /delegate <task>')); continue; }
      await orchestratorMode(task, projectDir, opts);
      continue;
    }

    if (input === '/bg') {
      const { bgList } = require('../tools/background-bash');
      const res = await bgList();
      if (res.processes.length === 0) { console.log(chalk.gray('  No background processes.')); continue; }
      for (const p of res.processes) {
        const status = p.running ? chalk.green('running') : chalk.gray(`exit ${p.exitCode}`);
        console.log(chalk.gray(`  ${p.pid.toString().padStart(6)} [${status}] ${p.cmd}`));
      }
      continue;
    }

    if (input === '/locks') {
      if (!opts._hermesBridge) { console.log(chalk.yellow('  Hermes disabled.')); continue; }
      const locks = opts._hermesBridge.getActiveLocks();
      if (locks.length === 0) {
        console.log(chalk.gray('  No active decision locks.'));
      } else {
        console.log(chalk.gray(`  ${locks.length} active lock(s):`));
        for (const d of locks) {
          console.log(chalk.yellow(`    🔒 [${d.scope}] ${d.decision}`));
          if (d.approvedBy) console.log(chalk.gray(`       by ${d.approvedBy} at ${d.lockedAt}`));
          if (d.relatedFiles?.length) console.log(chalk.gray(`       files: ${d.relatedFiles.slice(0, 3).join(', ')}`));
        }
      }
      continue;
    }

    if (input === '/doctor') {
      const results = await runDoctor({
        projectDir, litellmUrl: opts.url, litellmKey: opts.key,
        mcpRegistry: opts._mcpRegistry, hookRunner: opts._hookRunner
      });
      console.log(formatDoctor(results));
      continue;
    }

    if (input === '/budget') {
      const s = agent.budget.getStats();
      const cap = s.cap_usd === null ? 'unlimited' : `$${s.cap_usd.toFixed(4)}`;
      console.log(chalk.gray(`  Session: $${s.spent_usd.toFixed(4)} / ${cap} — ${s.calls} calls${s.exceeded ? chalk.red(' [EXCEEDED]') : ''}`));
      if (opts._costTracker) {
        const pool = opts._costTracker.getPoolStatus();
        const dailyCap = pool.dailyCapUSD ? `$${pool.dailyCapUSD}` : '∞';
        const dailyPct = pool.dailyCapUSD ? ` (${((pool.dailySpentUSD / pool.dailyCapUSD) * 100).toFixed(0)}%)` : '';
        console.log(chalk.gray(`  Daily:   $${pool.dailySpentUSD.toFixed(4)} / ${dailyCap}${dailyPct}`));
        const isOver = pool.dailyCapUSD && pool.dailySpentUSD >= pool.dailyCapUSD;
        const resetStr = _formatDuration(_msToMidnight());
        if (isOver) {
          console.log(chalk.red(`  Daily cap đã hết — reset lúc 00:00 (còn ${resetStr})`));
        } else {
          console.log(chalk.gray(`  Reset lúc 00:00 — còn ${resetStr}`));
        }
      }
      continue;
    }

    if (input === '/compact') {
      const before = agent.tokenManager.estimateTokens(agent.messages);
      const budget = Math.floor(agent.tokenManager.maxTokens * 0.4);
      agent.messages = agent.tokenManager.trimMessages(agent.messages, budget);
      const after = agent.tokenManager.estimateTokens(agent.messages);
      console.log(chalk.gray(`  Compacted: ${before} → ${after} tokens (${Math.round((1 - after / Math.max(before, 1)) * 100)}% reduction)`));
      continue;
    }

    if (input === '/init' || input.startsWith('/init ')) {
      const force = input.includes('--force');
      const res = await initProject(projectDir, { force });
      if (res.created) {
        console.log(chalk.green(`  ✓ Generated ${res.path} — ${res.stats.lines} lines`));
      } else {
        console.log(chalk.yellow(`  ${res.reason}`));
      }
      continue;
    }

    if (input.startsWith('/plan ')) {
      const task = input.slice('/plan '.length).trim();
      if (!task) { console.log(chalk.yellow('  Usage: /plan <task>')); continue; }
      const systemPlanner = await buildSystemPrompt(projectDir, 'planner', opts);
      inputQueue.mute(); // inquirer + agent runs inside runPlanFlow không dùng inputQueue
      let result;
      try {
        result = await runPlanFlow(task, {
          systemPromptPlanner: systemPlanner,
          systemPromptBuilder: systemPrompt,
          createPlannerAgent: () => createAgent(projectDir, { ...opts, role: 'planner', _iqRef }).agent,
          createBuilderAgent: () => createAgent(projectDir, { ...opts, _iqRef }).agent
        });
      } finally {
        inputQueue.unmute();
      }
      if (!result.approved) {
        console.log(chalk.gray('  Plan rejected.'));
      } else {
        printResult(result.result);
      }
      continue;
    }

    if (input === '/resume') {
      const sessions = cm.listSessions(10);
      if (sessions.length === 0) { console.log(chalk.gray('  No prior sessions.')); continue; }
      try {
        inputQueue.mute();
        const { pick } = await inquirer.prompt([{
          type: 'list', name: 'pick',
          message: 'Resume which session?',
          choices: sessions.map(s => ({ name: `${s.id}  ${s.summary}  (${new Date(s.createdAt).toLocaleString()})`, value: s.id }))
        }]).finally(() => inputQueue.unmute());
        const data = cm.loadSession(pick);
        if (data?.messages?.length) {
          agent.messages = data.messages;
          hasRun = true;
          session = { id: data.id, createdAt: data.createdAt, projectDir };
          console.log(chalk.green(`  Loaded ${data.messages.length} messages from ${pick}`));
        }
      } catch { inputQueue.unmute(); /* cancelled */ }
      continue;
    }

    if (input === '/help') {
      console.log(chalk.gray(`
  Built-in slash commands:
    /stats            — Thong ke tool calls
    /files            — Files da thay doi
    /undo             — Hoan tac thay doi file cuoi
    /sessions         — Danh sach sessions gan day
    /resume           — Chon session cu de load lai
    /tokens, /cost    — Token usage + cache hit + cost
    /budget           — Ngan sach da dung
    /compact          — Nen messages ve 40% budget
    /init [--force]   — Tao CLAUDE.md tu repo scan
    /plan <task>      — Analyze + approval truoc khi execute
    /mcp              — MCP server status
    /cache on|off     — Bat/tat prompt caching
    /doctor           — Health check moi truong
    /todos            — Hien danh sach todos cua agent
    /transcript       — Path den file transcript
    /claudemd         — Liet ke CLAUDE.md da load
    /memory [q]       — Memory store (list | search | clear)
    /guard            — Ground truth cua context guard
    /route            — Last routing decisions (SmartRouter/classifier)
    /locks            — Active decision locks
    /orchestrator     — Check Orchestrator health
    /delegate <task>  — Delegate task to Orchestrator pipeline
    /bg               — List background processes
    /transcripts      — List saved session transcripts
    /replay [id]      — Replay transcript (default: latest)
    /redo             — Re-run last user prompt
    /ratelimit, /rl   — API rate limit state
    /heal, /healer    — Self-healer stats (auto-save gotcha + suggest workaround)
    /exit             — Thoat
    /help             — Hien help

  Tip:
    @path/to/file      — attach file content vao prompt
    @"file with spaces" — quoted path
    Shortcut flags:   orcai --resume, --plan, --budget 0.50, --direct, -y, --no-hooks

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

    // === Stage 1: Request analysis (local-classifier 1.5B → fallback cheap) ===
    // Chạy trước mọi thứ, phân tích intent + routing decision
    let analysis = null;
    try {
      const recentFiles = agent.executor?.filesChanged
        ? [...agent.executor.filesChanged].slice(-5)
        : [];
      analysis = await requestAnalyzer.analyze(expandedInput, { recentFiles });
      if (analysis && analysis.goal) {
        console.log(chalk.gray(`  ${formatAnalysisSummary(analysis)}`));
      }
    } catch {
      // analyzer fail → tiếp tục với behavior cũ
    }

    // === Stage 2: Apply routing decision từ analysis ===
    if (analysis?.routing) {
      const targetModel = routingToModel(analysis.routing, opts.model);
      if (targetModel !== agent.model) {
        agent.model = targetModel;
        console.log(chalk.gray(`  → model: ${targetModel} (${analysis.reasoning?.slice(0, 60) || analysis.routing})`));
      }
    }

    // === Stage 3: Context retrieval — dùng searchTerms nếu có để tìm kiếm chính xác hơn ===
    let ctxBlockPromise = null;
    if (opts.localAssist !== false && opts._localAssistant) {
      const searchTerms = analysis?.searchTerms || [];
      ctxBlockPromise = opts._localAssistant
        .buildContextBlock(expandedInput, undefined, searchTerms)
        .catch(() => null);
    }

    // Build system prompt song song voi context search
    const baseSystemPrompt = await buildSystemPrompt(projectDir, opts.role,
      { ...opts, _localContextBlock: null }); // base prompt khong co context block cu

    // Await context block (neu da xong thi resolve ngay, neu chua thi doi)
    if (ctxBlockPromise) {
      const ctxResult = await ctxBlockPromise;
      if (ctxResult?.block && ctxResult.files?.length > 0) {
        opts._localContextBlock = ctxResult.block;
        console.log(chalk.gray(`  🔍 Local assist (${ctxResult.source}): ${ctxResult.files.length} file(s) pre-loaded`));
      } else {
        opts._localContextBlock = null;
      }
    }

    // Final system prompt: base + context block (neu co)
    const currentSystemPrompt = opts._localContextBlock
      ? baseSystemPrompt + opts._localContextBlock
      : (hasRun ? baseSystemPrompt : systemPrompt);

    // Run agent — InputQueue handle Ctrl+C → interrupt
    console.log('');
    inputQueue.agentStart(agent);

    let result;
    try {
      if (!hasRun) {
        result = await agent.run(currentSystemPrompt, expandedInput);
        hasRun = true;
      } else {
        result = await agent.continueWith(expandedInput);
      }
    } finally {
      inputQueue.agentDone();
    }

    // Interrupt-and-amend flow:
    // - Nếu user đã queue tin nhắn trong lúc agent chạy → dùng luôn làm amendment
    // - Nếu chưa → hỏi (Enter để bỏ qua)
    if (result.aborted && result.reason === 'interrupted') {
      let amendment;
      if (inputQueue.hasQueued()) {
        amendment = inputQueue.dequeue();
        console.log(chalk.yellow(`  ⚡ Dừng sau ${result.iterations} iter. Dùng context đã queue: "${amendment.slice(0, 60)}${amendment.length > 60 ? '…' : ''}"`));
      } else {
        console.log(chalk.yellow(`  ⚡ Dừng sau ${result.iterations} iter. Bổ sung context? (Enter để bỏ qua)`));
        try {
          amendment = await inputQueue.next(chalk.yellow('  + '));
        } catch { amendment = ''; }
      }

      if (amendment && amendment.trim()) {
        // Inject context bổ sung, agent tái dùng context đã có (file reads, plan)
        console.log('');
        inputQueue.agentStart(agent);
        try {
          const amendMsg = `[Bổ sung context từ user]: ${amendment}\nHãy điều chỉnh hoặc tiếp tục task theo context mới này.`;
          result = await agent.continueWith(amendMsg);
        } finally {
          inputQueue.agentDone();
        }
      }
    }

    _exchangeCount++;
    printResult(result);
    printCacheStats(agent);

    // Context guard warnings
    if (agent.contextGuard) {
      const issues = agent.contextGuard.verify(result.summary || result.final_message || '').issues;
      if (issues.length > 0) console.log(chalk.yellow(formatIssues(issues)));
    }

    // Lưu session sau mỗi prompt
    cm.saveSession(session.id, {
      messages: agent.messages,
      filesChanged: [...agent.executor.filesChanged],
      commandsRun: agent.executor.commandsRun,
      toolStats: agent.executor.getStats()
    });

    // Snapshot in-flight state cho session continuity
    _scHandle.onTurn({
      openTasks: agent.executor.filesChanged ? [...agent.executor.filesChanged].map(f => `edit:${f}`) : [],
      inFlightFiles: [...agent.executor.filesChanged],
      modelsUsed: [opts.model],
      nextStep: result.success ? null : (result.summary || result.reason || null),
      errorsSeen: result.success ? [] : [result.reason || 'unknown']
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

  // Đóng session continuity với summary cuối
  _scHandle.onEnd({
    status: 'completed',
    summary: `${_exchangeCount} exchanges, ${[...agent.executor.filesChanged].length} files changed`
  });

  inputQueue.close(); // giải phóng persistent readline trước khi thoát

  const _sessionMs = Date.now() - _sessionStart;
  const _sessionLabel = _sessionMs < 60000
    ? `${(_sessionMs / 1000).toFixed(0)}s`
    : `${Math.floor(_sessionMs / 60000)}m ${Math.floor((_sessionMs % 60000) / 1000)}s`;
  console.log(chalk.gray(`\n  Session saved: ${session.id}`));
  console.log(chalk.gray(`  Session time: ${_sessionLabel}  ·  ${_exchangeCount} exchange${_exchangeCount !== 1 ? 's' : ''}`));
  console.log(chalk.gray('  Bye!\n'));
}

// === Print Result ===
function printResult(result) {
  const W = 56;
  const SEP = chalk.gray('  ' + '─'.repeat(W));
  console.log('');
  console.log(SEP);

  // Header — status + wall-clock timing
  const wallMs = result.wall_elapsed_ms || result.elapsed_ms || 0;
  const elapsed = wallMs > 0
    ? chalk.gray(`  ⏱ ${wallMs < 1000 ? wallMs + 'ms' : (wallMs / 1000).toFixed(1) + 's'}`)
    : '';
  if (result.success) {
    console.log(chalk.green.bold('  ✓ Hoàn thành') + elapsed);
  } else {
    const label = result.reason === 'too_many_errors' ? 'Quá nhiều lỗi'
      : result.reason === 'max_iterations' ? 'Hết iterations'
      : 'Chưa xong';
    console.log(chalk.red.bold(`  ✗ ${label}`) + elapsed);
  }

  // Summary — task_complete.summary (uu tien) hoac final_message (fallback khi model tra text thuan)
  const displayText = result.summary || (!result.summary && !result.tool_calls ? result.final_message : null);
  if (displayText) {
    console.log('');
    const rendered = renderMarkdown(displayText);
    rendered.split('\n').forEach(l => console.log('  ' + l));
  }

  // Files changed
  if (result.files_changed && result.files_changed.length > 0) {
    console.log('');
    console.log(chalk.gray('  ') + chalk.bold.white(`Files changed (${result.files_changed.length}):`));
    result.files_changed.forEach(f => {
      console.log(`    ${chalk.yellow('✎')} ${chalk.white(f)}`);
    });
  }

  // Commands run
  if (result.commands_run_detail && result.commands_run_detail.length > 0) {
    console.log('');
    console.log(chalk.gray('  ') + chalk.bold.white(`Commands (${result.commands_run_detail.length}):`));
    result.commands_run_detail.forEach(({ command, exit_code }) => {
      const ok = exit_code === 0;
      const icon = ok ? chalk.green('✓') : chalk.red('✗');
      const cmd = (command || '').slice(0, 70);
      console.log(`    ${icon} ${chalk.gray('$')} ${ok ? chalk.white(cmd) : chalk.red(cmd)}`);
    });
  }

  // Tool breakdown
  const byTool = result.by_tool || {};
  const toolParts = Object.entries(byTool)
    .filter(([k]) => k !== 'task_complete')
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => chalk.gray(`${k}×${v}`));

  console.log('');
  const statParts = [
    chalk.gray(`${result.iterations} iter`),
    chalk.gray(`${result.tool_calls || 0} tools`),
    result.errors ? chalk.red(`${result.errors} err`) : chalk.gray('0 err'),
  ];
  console.log('  ' + statParts.join(chalk.gray('  ·  ')));
  if (toolParts.length > 0) {
    console.log('  ' + toolParts.join(chalk.gray('  ·  ')));
  }
  console.log(SEP);
}

// === Run ===
program.parse();
