#!/usr/bin/env node
/**
 * Terminal Runner — Chạy lệnh shell an toàn cho AI Agent
 *
 * Features:
 * - Timeout (mặc định 30s, tối đa 120s)
 * - Kill process khi timeout
 * - Chặn lệnh nguy hiểm (rm -rf /, drop database, git push --force)
 * - Trả stdout + stderr + exit code
 * - Stream output cho long-running commands
 */

const { spawn } = require('child_process');
const path = require('path');
const treeKill = require('tree-kill');

// Lệnh bị cấm hoàn toàn — không có cách nào chạy
const BLOCKED_COMMANDS = [
  /rm\s+(-rf?|--recursive)\s+[\/\\]($|\s)/,    // rm -rf /
  /del\s+\/[sq]\s+[a-z]:\\/i,                    // del /s /q C:\
  /format\s+[a-z]:/i,                             // format C:
  /drop\s+database/i,                              // DROP DATABASE
  /drop\s+table/i,                                 // DROP TABLE (cần confirm)
  /truncate\s+table/i,                             // TRUNCATE TABLE
  />\s*\/dev\/sda/,                                // > /dev/sda
  /mkfs\./,                                         // mkfs.ext4
  /:(){ :\|:& };:/,                                // fork bomb
];

// Lệnh cần confirm từ user trước khi chạy
const CONFIRM_COMMANDS = [
  { pattern: /git\s+push/i, reason: 'Push code lên remote' },
  { pattern: /git\s+push\s+.*--force/i, reason: 'Force push — có thể mất code' },
  { pattern: /git\s+reset\s+--hard/i, reason: 'Reset hard — mất uncommitted changes' },
  { pattern: /rm\s+(-r|--recursive)/i, reason: 'Xóa đệ quy files/folders' },
  { pattern: /npm\s+publish/i, reason: 'Publish package lên npm' },
  { pattern: /docker\s+rm/i, reason: 'Xóa Docker container' },
  { pattern: /docker\s+system\s+prune/i, reason: 'Dọn dẹp Docker system' },
  { pattern: /npm\s+install\s+-g/i, reason: 'Cài package global' },
];

// Timeout mặc định và tối đa
const DEFAULT_TIMEOUT = 30000;  // 30s
const MAX_TIMEOUT = 120000;     // 2 phút

class TerminalRunner {
  constructor(options = {}) {
    this.projectDir = options.projectDir || process.cwd();
    this.confirmCallback = options.onConfirm || null;  // Hàm confirm từ CLI
    this.onOutput = options.onOutput || null;           // Stream output callback
  }

  /**
   * Kiểm tra lệnh có bị chặn không
   */
  _checkBlocked(command) {
    for (const pattern of BLOCKED_COMMANDS) {
      if (pattern.test(command)) {
        return { blocked: true, reason: `Lệnh bị cấm: ${command.slice(0, 50)}` };
      }
    }
    return { blocked: false };
  }

  /**
   * Kiểm tra lệnh có cần confirm không
   */
  _checkNeedsConfirm(command) {
    for (const { pattern, reason } of CONFIRM_COMMANDS) {
      if (pattern.test(command)) {
        return { needsConfirm: true, reason };
      }
    }
    return { needsConfirm: false };
  }

  /**
   * Chạy lệnh shell
   */
  async executeCommand({ command, cwd, timeout = DEFAULT_TIMEOUT }) {
    // 1. Check blocked
    const blockCheck = this._checkBlocked(command);
    if (blockCheck.blocked) {
      return {
        success: false,
        error: `BLOCKED: ${blockCheck.reason}`,
        exit_code: -1
      };
    }

    // 2. Check confirm
    const confirmCheck = this._checkNeedsConfirm(command);
    if (confirmCheck.needsConfirm && this.confirmCallback) {
      const confirmed = await this.confirmCallback(command, confirmCheck.reason);
      if (!confirmed) {
        return {
          success: false,
          error: `User từ chối: ${confirmCheck.reason}`,
          exit_code: -1
        };
      }
    }

    // 3. Resolve cwd
    const execCwd = cwd
      ? (path.isAbsolute(cwd) ? cwd : path.resolve(this.projectDir, cwd))
      : this.projectDir;

    // 4. Clamp timeout
    const actualTimeout = Math.min(Math.max(timeout, 1000), MAX_TIMEOUT);

    // 5. Execute
    return new Promise((resolve) => {
      const isWindows = process.platform === 'win32';
      const shell = isWindows ? 'cmd.exe' : '/bin/bash';
      const shellArgs = isWindows ? ['/c', command] : ['-c', command];

      let stdout = '';
      let stderr = '';
      let killed = false;

      const proc = spawn(shell, shellArgs, {
        cwd: execCwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });

      // Timeout handler
      const timer = setTimeout(() => {
        killed = true;
        try {
          treeKill(proc.pid, 'SIGKILL');
        } catch {
          proc.kill('SIGKILL');
        }
      }, actualTimeout);

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        if (this.onOutput) this.onOutput(chunk);

        // Giới hạn output 100KB
        if (stdout.length > 100 * 1024) {
          stdout = stdout.slice(-50 * 1024);
        }
      });

      proc.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;

        if (stderr.length > 50 * 1024) {
          stderr = stderr.slice(-25 * 1024);
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timer);

        // Trim output
        stdout = stdout.trim();
        stderr = stderr.trim();

        if (killed) {
          resolve({
            success: false,
            error: `Timeout sau ${actualTimeout / 1000}s`,
            stdout: stdout.slice(-2000),
            stderr: stderr.slice(-1000),
            exit_code: -1,
            timed_out: true
          });
          return;
        }

        resolve({
          success: code === 0,
          stdout: stdout.slice(-5000),  // Giới hạn 5KB stdout trong response
          stderr: stderr.slice(-2000),
          exit_code: code
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          error: `Spawn error: ${err.message}`,
          exit_code: -1
        });
      });
    });
  }
}

module.exports = { TerminalRunner, BLOCKED_COMMANDS, CONFIRM_COMMANDS };
