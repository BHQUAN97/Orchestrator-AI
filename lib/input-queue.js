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
 *
 * Keyboard shortcuts:
 *   Ctrl+V        — dán ảnh hoặc văn bản từ clipboard (Windows)
 *   Ctrl+Enter    — xuống dòng (multiline), Enter thường để gửi
 *   Ctrl+C        — interrupt agent hoặc thoát nếu ở prompt
 */

const readline = require('readline');
const path = require('path');
const chalk = require('chalk');
const { buildCompleter } = require('./interactive-input');

class InputQueue {
  constructor() {
    this._queue = [];           // messages typed while agent was running
    this._waiter = null;        // { resolve, reject } — at most 1 at a time
    this._rl = null;
    this._completerFn = (line) => [[], line];
    this._currentAgent = null;  // agent to interrupt on Ctrl+C
    this._muted = false;        // khi muted, _handleLine bỏ qua input
    this._multilineMode = false;
    this._multilineBuffer = []; // accumulated lines khi Ctrl+Enter
    this._promptStr = chalk.cyan('❯ ');
  }

  /**
   * Khởi tạo readline persistent — gọi 1 lần khi session bắt đầu.
   */
  start() {
    if (this._rl) return;

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

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

    // Monkey-patch _ttyWrite để intercept Ctrl+V và Ctrl+Enter
    // trước khi readline xử lý — cách này ngăn readline hiểu sai ký tự.
    if (this._rl._ttyWrite) {
      const origTtyWrite = this._rl._ttyWrite.bind(this._rl);
      this._rl._ttyWrite = (s, key) => {
        if (!key) return origTtyWrite(s, key);

        // Ctrl+V → dán clipboard
        if (key.ctrl && key.name === 'v') {
          if (process.platform === 'win32') {
            this._handleCtrlV().catch(() => {});
            return; // chặn readline xử lý tiếp
          }
        }

        // Ctrl+Enter → xuống dòng mà không gửi
        if (key.ctrl && (key.name === 'return' || key.name === 'enter')) {
          this._handleCtrlEnter();
          return;
        }

        return origTtyWrite(s, key);
      };
    }
  }

  /** Cập nhật tab-completion (command list thay đổi được) */
  updateCompleter(opts) {
    this._completerFn = buildCompleter(opts);
  }

  /**
   * Đánh dấu agent đang chạy — input sẽ bị buffer.
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
   * - Nếu queue có sẵn → trả ngay.
   * - Nếu queue rỗng → hiện prompt, block cho đến khi user gõ.
   */
  async next(promptStr = chalk.cyan('❯ ')) {
    this._promptStr = promptStr;
    if (this._queue.length > 0) {
      const msg = this._queue.shift();
      if (this._queue.length > 0) {
        process.stdout.write(chalk.gray(`  (còn ${this._queue.length} tin nhắn trong queue)\n`));
      }
      return msg;
    }
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
   * Vẽ lại prompt sau khi có output bất ngờ (async log, spinner...).
   * Chỉ hoạt động khi đang chờ input (_waiter != null).
   */
  redrawPrompt() {
    if (!this._waiter || !this._rl) return;
    const prompt = this._multilineMode ? chalk.cyan('... ') : this._promptStr;
    process.stdout.write('\n' + prompt);
    if (this._rl.line) process.stdout.write(this._rl.line);
  }

  /** Tạm ngắt xử lý input — tránh conflict với inquirer. */
  mute() { this._muted = true; }

  /** Bật lại xử lý input. */
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
    if (this._muted) return;

    let line;
    if (this._multilineMode) {
      // Gộp tất cả lines đã accumulate + dòng hiện tại
      this._multilineBuffer.push(raw);
      line = this._multilineBuffer.join('\n').trim();
      this._multilineMode = false;
      this._multilineBuffer = [];
    } else {
      line = raw.trim();
    }

    if (this._waiter) {
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

  _handleCtrlEnter() {
    if (!this._rl) return;

    const currentLine = this._rl.line || '';

    if (!this._multilineMode) {
      this._multilineMode = true;
      this._multilineBuffer = [];
    }
    this._multilineBuffer.push(currentLine);

    // Xóa dòng đang gõ trong readline
    this._rl.line = '';
    this._rl.cursor = 0;

    // Hiển thị xuống dòng + prompt tiếp theo
    process.stdout.write('\n');
    process.stdout.write(chalk.cyan('... '));
  }

  async _handleCtrlV() {
    if (!this._rl) return;
    try {
      const { readClipboard } = require('../tools/windows/clipboard');
      const res = await readClipboard();
      if (!res.success || !res.content) return;

      if (res.isImage) {
        // Ảnh: insert tag ngắn gọn vào buffer, thông báo bên dưới
        const imgPath = res.content.replace('IMAGE:', '');
        const tag = `[Image: ${path.basename(imgPath)}]`;
        // Lưu mapping để agent sau nhận full path
        this._insertIntoRl(tag);
        process.stdout.write(chalk.green(`\n  📷 ${path.basename(imgPath)} (${imgPath})\n`));
        this._reprintPrompt();
      } else {
        // Văn bản: insert thẳng vào cursor position
        this._insertIntoRl(res.content);
      }
    } catch (_) {}
  }

  /**
   * Insert text vào cursor position của readline buffer.
   * Dùng internal API _insertString nếu có, fallback sang rl.write().
   */
  _insertIntoRl(text) {
    if (!this._rl) return;
    if (typeof this._rl._insertString === 'function') {
      this._rl._insertString(text);
    } else {
      // Fallback: manipulate buffer trực tiếp
      const before = (this._rl.line || '').slice(0, this._rl.cursor || 0);
      const after = (this._rl.line || '').slice(this._rl.cursor || 0);
      this._rl.line = before + text + after;
      this._rl.cursor = before.length + text.length;
      if (typeof this._rl._refreshLine === 'function') {
        this._rl._refreshLine();
      }
    }
  }

  /** In lại prompt + nội dung rl.line hiện tại sau khi thông báo clipboard. */
  _reprintPrompt() {
    if (!this._rl) return;
    const prompt = this._multilineMode ? chalk.cyan('... ') : this._promptStr;
    process.stdout.write(prompt);
    if (this._rl.line) process.stdout.write(this._rl.line);
  }

  _handleSIGINT() {
    if (this._multilineMode) {
      // Thoát multiline mode
      this._multilineMode = false;
      this._multilineBuffer = [];
      this._rl.line = '';
      this._rl.cursor = 0;
      process.stdout.write(chalk.gray('\n  (multiline cancelled)\n'));
      process.stdout.write(this._promptStr);
      return;
    }

    if (this._waiter) {
      const { reject } = this._waiter;
      this._waiter = null;
      reject(new Error('SIGINT'));
      return;
    }

    if (this._currentAgent && this._currentAgent._interruptRequested !== undefined) {
      process.stdout.write(chalk.yellow('\n  ⚡ Interrupting...\n'));
      this._currentAgent.interrupt();
    }
  }
}

module.exports = { InputQueue };
