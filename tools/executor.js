#!/usr/bin/env node
/**
 * Tool Executor — Dispatch tool_calls từ LLM → handler → kết quả
 *
 * Nhận tool_call từ LLM response → tìm handler → chạy → trả kết quả
 * Kết quả được format để feed lại cho LLM ở lượt tiếp theo
 *
 * Flow:
 *   LLM response có tool_calls → executor.run(tool_calls)
 *   → dispatch tới FileManager / TerminalRunner
 *   → trả Array<{tool_call_id, role: 'tool', content: JSON}>
 */

const fs = require('fs');
const path = require('path');
const { FileManager } = require('./file-manager');
const { TerminalRunner } = require('./terminal-runner');
const { ToolPermissions } = require('./permissions');
const { webFetch, webSearch } = require('./web-tools');
const { glob } = require('./glob-tool');
const { spawnSubagent } = require('./subagent');

class ToolExecutor {
  constructor(options = {}) {
    this.projectDir = options.projectDir || process.cwd();
    this.agentRole = options.agentRole || 'builder';

    // Context can cho subagent goi lai AgentLoop
    this.litellmUrl = options.litellmUrl || process.env.LITELLM_URL || 'http://localhost:4001';
    this.litellmKey = options.litellmKey || process.env.LITELLM_KEY || 'sk-master-change-me';
    this.subagentDepth = options.subagentDepth || 0;

    // MCP registry (optional)
    this.mcpRegistry = options.mcpRegistry || null;

    // Parent budget + hook runner — share voi subagent neu co
    this.parentBudget = options.parentBudget || null;
    this.parentHookRunner = options.parentHookRunner || null;

    // Diff approval callback — goi truoc write/edit trong interactive mode
    // Signature: (filePath, before, after) => 'yes' | 'no' | 'abort'
    this.onWriteApproval = options.onWriteApproval || null;

    this.fileManager = new FileManager({
      projectDir: this.projectDir,
      readableRoots: options.readableRoots || []
    });
    this.terminalRunner = new TerminalRunner({
      projectDir: this.projectDir,
      onConfirm: options.onConfirm || null,
      onOutput: options.onOutput || null
    });

    // Phan quyen theo agent role
    this.permissions = new ToolPermissions(this.agentRole);

    // Registry: tool name → handler function
    this.handlers = {
      'read_file':       (args) => this.fileManager.readFile(args),
      'write_file':      (args) => this.fileManager.writeFile(args),
      'edit_file':       (args) => this.fileManager.editFile(args),
      'list_files':      (args) => this.fileManager.listFiles(args),
      'search_files':    (args) => this.fileManager.searchFiles(args),
      'glob':            (args) => glob(args, this.projectDir),
      'execute_command': (args) => this.terminalRunner.executeCommand(args),
      'web_fetch':       (args) => webFetch(args),
      'web_search':      (args) => webSearch(args),
      'spawn_subagent':  (args) => spawnSubagent(args, {
        projectDir: this.projectDir,
        litellmUrl: this.litellmUrl,
        litellmKey: this.litellmKey,
        parentDepth: this.subagentDepth,
        budget: this.parentBudget,         // share parent budget cap
        hookRunner: this.parentHookRunner, // share parent hook runner
        mcpRegistry: this.mcpRegistry      // share MCP
      }),
      'read_mcp_resource': async (args) => {
        if (!this.mcpRegistry) return { success: false, error: 'No MCP registry configured' };
        return await this.mcpRegistry.readResource(args.server, args.uri);
      },
      'task_complete':   (args) => this._handleTaskComplete(args)
    };

    // Tracking: files đã thay đổi, commands đã chạy
    this.history = [];
    this.filesChanged = new Set();
    this.commandsRun = [];
    this.userAborted = false;
  }

  /**
   * Execute 1 tool call
   * @param {Object} toolCall - { id, function: { name, arguments } }
   * @returns {Object} - { tool_call_id, role: 'tool', content: string }
   */
  async execute(toolCall) {
    const { id, function: fn } = toolCall;
    const name = fn.name;
    const startTime = Date.now();

    // Parse arguments
    let args;
    try {
      args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments;
    } catch (e) {
      return this._formatResult(id, name, {
        success: false,
        error: `JSON parse error: ${e.message}`
      });
    }

    // Dispatch MCP tools qua registry
    if (name.startsWith('mcp__') && this.mcpRegistry) {
      // Permissions: chi cho role level execute/write (da check trong permissions.check)
      const permCheck = this.permissions.check(name, args);
      if (!permCheck.allowed) {
        return this._formatResult(id, name, { success: false, error: `PERMISSION DENIED: ${permCheck.reason}` });
      }
      this.permissions.recordCall(name);
      try {
        const result = await this.mcpRegistry.callTool(name, args);
        const elapsed = Date.now() - startTime;
        this.history.push({ id, name, args, success: result.success, elapsed_ms: elapsed, timestamp: new Date().toISOString() });
        return this._formatResult(id, name, result);
      } catch (e) {
        return this._formatResult(id, name, { success: false, error: `MCP error: ${e.message}` });
      }
    }

    // Tìm handler
    const handler = this.handlers[name];
    if (!handler) {
      return this._formatResult(id, name, {
        success: false,
        error: `Tool không tồn tại: ${name}. Có: ${Object.keys(this.handlers).join(', ')}`
      });
    }

    // Kiem tra quyen truoc khi chay — Layer 2 defense
    const permCheck = this.permissions.check(name, args);
    if (!permCheck.allowed) {
      return this._formatResult(id, name, {
        success: false,
        error: `PERMISSION DENIED: ${permCheck.reason}`
      });
    }

    // Diff approval — goi truoc khi write/edit (chi trong interactive mode)
    if (this.onWriteApproval && ['write_file', 'edit_file'].includes(name)) {
      const approval = await this._askWriteApproval(name, args);
      if (approval === 'abort') {
        this.userAborted = true;
        return this._formatResult(id, name, {
          success: false,
          error: 'USER_ABORTED: Agent aborted by user via diff approval'
        });
      }
      if (approval === 'no') {
        return this._formatResult(id, name, {
          success: false,
          error: 'User declined this change. Try a different approach or ask user for clarification.'
        });
      }
    }

    // Ghi nhan vao permission counter TRUOC khi execute — dem ca success va fail de rate limit
    this.permissions.recordCall(name);

    // Execute
    try {
      const result = await handler(args);
      const elapsed = Date.now() - startTime;

      // Track changes
      if (['write_file', 'edit_file'].includes(name) && result.success) {
        this.filesChanged.add(result.path || args.path);
      }
      if (name === 'execute_command') {
        this.commandsRun.push({ command: args.command, exit_code: result.exit_code });
      }

      // Log
      this.history.push({
        id, name, args,
        success: result.success,
        elapsed_ms: elapsed,
        timestamp: new Date().toISOString()
      });

      return this._formatResult(id, name, result);
    } catch (e) {
      return this._formatResult(id, name, {
        success: false,
        error: `Runtime error: ${e.message}`
      });
    }
  }

  /**
   * Tinh toan before/after cho diff, goi onWriteApproval callback
   */
  async _askWriteApproval(toolName, args) {
    try {
      const fullPath = path.isAbsolute(args.path)
        ? args.path
        : path.resolve(this.projectDir, args.path);
      const before = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : null;

      let after;
      if (toolName === 'write_file') {
        after = args.content;
      } else {
        // edit_file — simulate replacement to compute after-content
        if (!before) return 'yes'; // file missing, let handler error naturally
        if (!before.includes(args.old_string)) return 'yes'; // old_string not found, handler errors
        after = args.replace_all
          ? before.split(args.old_string).join(args.new_string)
          : before.replace(args.old_string, args.new_string);
      }

      // No change? No need to ask
      if (before === after) return 'yes';

      return await this.onWriteApproval(args.path, before, after);
    } catch {
      // On any error computing diff, default to allow (safer than blocking)
      return 'yes';
    }
  }

  /**
   * Execute nhiều tool calls (song song hoặc tuần tự)
   */
  async executeAll(toolCalls, parallel = false) {
    if (parallel) {
      return Promise.all(toolCalls.map(tc => this.execute(tc)));
    }

    // Tuần tự — an toàn hơn cho file operations
    const results = [];
    for (const tc of toolCalls) {
      results.push(await this.execute(tc));
    }
    return results;
  }

  /**
   * Format kết quả cho LLM — chuẩn OpenAI tool message format
   */
  _formatResult(toolCallId, toolName, result) {
    // Giới hạn content size — tránh tốn token
    let content = JSON.stringify(result);
    if (content.length > 10000) {
      // Truncate nhưng giữ structure
      result = {
        ...result,
        content: result.content
          ? result.content.slice(0, 8000) + '\n... [truncated, dùng offset/limit để đọc tiếp]'
          : undefined,
        stdout: result.stdout
          ? result.stdout.slice(0, 4000) + '\n... [truncated]'
          : undefined
      };
      content = JSON.stringify(result);
    }

    return {
      tool_call_id: toolCallId,
      role: 'tool',
      content
    };
  }

  /**
   * Handler đặc biệt: task_complete — đánh dấu agent xong việc
   */
  _handleTaskComplete(args) {
    return {
      success: true,
      completed: true,
      summary: args.summary,
      files_changed: [...this.filesChanged],
      commands_run: this.commandsRun.length,
      total_tool_calls: this.history.length
    };
  }

  /**
   * Reset tracking cho task mới
   */
  reset() {
    this.history = [];
    this.filesChanged.clear();
    this.commandsRun = [];
    this.permissions.reset();
  }

  /**
   * Lấy thống kê execution
   */
  getStats() {
    return {
      total_calls: this.history.length,
      by_tool: this.history.reduce((acc, h) => {
        acc[h.name] = (acc[h.name] || 0) + 1;
        return acc;
      }, {}),
      files_changed: [...this.filesChanged],
      commands_run: this.commandsRun.length,
      errors: this.history.filter(h => !h.success).length,
      total_elapsed_ms: this.history.reduce((sum, h) => sum + (h.elapsed_ms || 0), 0)
    };
  }

  /**
   * Lay thong ke phan quyen — tools da dung, con lai bao nhieu
   */
  getPermissionUsage() {
    return this.permissions.getUsage();
  }
}

module.exports = { ToolExecutor };
