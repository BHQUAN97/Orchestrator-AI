#!/usr/bin/env node
/**
 * InputQueue — always-on input listener với message queue
 *
 * Pattern giống Claude Code: readline luôn sẵn sàng nhận input.
 * Khi agent đang chạy → input được buffer vào queue.
 * Khi agent xong → next() trả ngay từ queue không cần chờ.
 *
 * Flow:
 *   inputQueue.start()
 *   while (true) {
 *     input = await inputQueue.next('❯ ')     // block nếu queue rỗng
 *     inputQueue.agentStart(agent)            // bật chế độ buffer
 *     await agent.run(input)
 *     inputQueue.agentDone()                  // tắt buffer
 *   }
 */

const readline = require('readline');
const chalk = require('chalk');
const { buildCompleter } = require('./interactive-input');

class InputQueue {
  constructor() {
    this._queue = [];          // messages typed while agent was running
    this._waiter = null;       // { resolve, reject } — at most 1 at a time
    this._rl = null;
    this._completerFn = (line) => [[], line];
    this._currentAgent = null; // agent to interrupt on Ctrl+C
    this._muted = false;       // khi muted, _handleLine bỏ qua input (tránh conflict với inquirer/readline ngoài)
  }

  /**
   * Khởi tạo readline persistent — gọi 1 lần khi session bắt đầu.
   */
  start() {
    if (this._rl) return;
    this._rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: (line) => this._completerFn(line),
      terminal: true,
      historySize: 100
    });
    this._rl.on('line', (raw) => this._handleLine(raw));
    this._rl.on('SIGINT', () => this._handleSIGINT());
    this._rl.on('close', () => { this._rl = null; });
  }

  /** Cập nhật tab-completion (command list thay đổi được) */
  updateCompleter(opts) {
    this._completerFn = buildCompleter(opts);
  }

  /**
   * Đánh dấu agent đang chạy — input sẽ bị buffer.
   * @param {object} agent — AgentLoop instance (để interrupt khi Ctrl+C)
   */
  agentStart(agent) {
    this._currentAgent = agent;
  }

  /** Đánh dấu agent xong — buffer mode tắt. */
  agentDone() {
    this._currentAgent = null;
  }

  /**
   * Chờ message tiếp theo.
   * - Nếu queue có sẵn → trả ngay (không hiện prompt).
   * - Nếu queue rỗng → hiện prompt, block cho đến khi user gõ.
   * @param {string} promptStr
   * @returns {Promise<string>}
   */
  async next(promptStr = chalk.cyan('❯ ')) {
    if (this._queue.length > 0) {
      const msg = this._queue.shift();
      if (this._queue.length > 0) {
        process.stdout.write(chalk.gray(`  (còn ${this._queue.length} tin nhắn trong queue)\n`));
      }
      return msg;
    }
    // Hiện prompt và block
    if (this._rl) process.stdout.write(promptStr);
    return new Promise((resolve, reject) => {
      this._waiter = { resolve, reject };
    });
  }

  /** Lấy synchronously từ queue (dùng trong amend flow). */
  dequeue() {
    return this._queue.shift() ?? null;
  }

  /** Kiểm tra có tin nhắn đang chờ không. */
  hasQueued() {
    return this._queue.length > 0;
  }

  /**
   * Tạm ngắt xử lý input — dùng trước khi gọi inquirer / readline tạm thời.
   * Khi muted, _handleLine bỏ qua tất cả input để tránh conflict.
   */
  mute() { this._muted = true; }

  /** Bật lại xử lý input sau khi inquirer / readline tạm thời xong. */
  unmute() { this._muted = false; }

  /** Đóng readline khi thoát app. */
  close() {
    if (this._rl) {
      this._rl.close();
      this._rl = null;
    }
  }

  // ── private ──────────────────────────────────────────────

  _handleLine(raw) {
    if (this._muted) return; // inquirer / confirm dialog đang dùng stdin
    const line = raw.trim();

    if (this._waiter) {
      // Có người đang chờ → trả ngay
      const { resolve } = this._waiter;
      this._waiter = null;
      resolve(line);
      return;
    }

    // Agent đang chạy → buffer
    if (line) {
      this._queue.push(line);
      process.stdout.write(
        chalk.gray(`  ⏳ Queued (${this._queue.length}): "${line.slice(0, 60)}${line.length > 60 ? '…' : ''}"\n`)
      );
    }
  }

  _handleSIGINT() {
    if (this._waiter) {
      // Đang ở prompt → Ctrl+C = thoát
      const { reject } = this._waiter;
      this._waiter = null;
      reject(new Error('SIGINT'));
      return;
    }

    if (this._currentAgent && this._currentAgent._interruptRequested !== undefined) {
      // Agent đang chạy → interrupt
      process.stdout.write(chalk.yellow('\n  ⚡ Interrupting...\n'));
      this._currentAgent.interrupt();
    }
  }
}

module.exports = { InputQueue };
