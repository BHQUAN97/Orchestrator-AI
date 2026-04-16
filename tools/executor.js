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

const { FileManager } = require('./file-manager');
const { TerminalRunner } = require('./terminal-runner');

class ToolExecutor {
  constructor(options = {}) {
    this.projectDir = options.projectDir || process.cwd();

    this.fileManager = new FileManager({ projectDir: this.projectDir });
    this.terminalRunner = new TerminalRunner({
      projectDir: this.projectDir,
      onConfirm: options.onConfirm || null,
      onOutput: options.onOutput || null
    });

    // Registry: tool name → handler function
    this.handlers = {
      'read_file':       (args) => this.fileManager.readFile(args),
      'write_file':      (args) => this.fileManager.writeFile(args),
      'edit_file':       (args) => this.fileManager.editFile(args),
      'list_files':      (args) => this.fileManager.listFiles(args),
      'search_files':    (args) => this.fileManager.searchFiles(args),
      'execute_command':  (args) => this.terminalRunner.executeCommand(args),
      'task_complete':    (args) => this._handleTaskComplete(args)
    };

    // Tracking: files đã thay đổi, commands đã chạy
    this.history = [];
    this.filesChanged = new Set();
    this.commandsRun = [];
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

    // Tìm handler
    const handler = this.handlers[name];
    if (!handler) {
      return this._formatResult(id, name, {
        success: false,
        error: `Tool không tồn tại: ${name}. Có: ${Object.keys(this.handlers).join(', ')}`
      });
    }

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
}

module.exports = { ToolExecutor };
