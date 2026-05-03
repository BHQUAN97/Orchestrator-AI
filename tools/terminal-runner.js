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
 *
 * === DEFENSE IN DEPTH ===
 * Tuyến phòng thủ chính là LLM system prompt — agent được hướng dẫn
 * chỉ chạy các lệnh an toàn trong phạm vi task. Blocklist ở đây là
 * tuyến phòng thủ CUỐI CÙNG (last resort) để chặn các lệnh phá hoại
 * trong trường hợp prompt injection hoặc hallucination vượt qua
 * system prompt. Không nên dựa hoàn toàn vào blocklist vì regex
 * luôn có thể bị bypass bằng encoding/obfuscation.
 */

const { spawn } = require('child_process');
const path = require('path');
const treeKill = require('tree-kill');

/**
 * Translate Unix pipe fragments → PowerShell equivalents.
 * PowerShell đã có alias ls/cat/pwd; chỉ cần fix những gì không có alias.
 */
function translateForWindows(command) {
  return command
    // head -n N  →  Select-Object -First N
    .replace(/\|\s*head\s+-n\s+(\d+)/g, '| Select-Object -First $1')
    .replace(/\|\s*head\s+-(\d+)/g, '| Select-Object -First $1')
    // tail -n N  →  Select-Object -Last N
    .replace(/\|\s*tail\s+-n\s+(\d+)/g, '| Select-Object -Last $1')
    .replace(/\|\s*tail\s+-(\d+)/g, '| Select-Object -Last $1')
    // wc -l  →  Measure-Object -Line
    .replace(/\|\s*wc\s+-l/g, '| Measure-Object -Line')
    // grep [-i] pattern  →  Select-String [-CaseSensitive] pattern
    .replace(/\|\s*grep\s+-i\s+/g, '| Select-String -CaseSensitive:$false ')
    .replace(/\|\s*grep\s+/g, '| Select-String ');
}

// Lệnh bị cấm hoàn toàn — không có cách nào chạy
// Lưu ý: đây là tuyến phòng thủ cuối, primary defense là system prompt
const BLOCKED_COMMANDS = [
  // --- Xóa hệ thống ---
  /rm\s+(-rf?|--recursive)\s+[\/\\]($|\s)/,       // rm -rf /
  /rm\s+(-rf?|--recursive)\s+[\/\\]\*/,            // rm -rf /* (với glob)
  /rm\s+(-rf?|--recursive)\s+~\//,                 // rm -rf ~/ (xóa home)
  /del\s+\/[sq]\s+[a-z]:\\/i,                      // del /s /q C:\
  /format\s+[a-z]:/i,                               // format C:

  // --- find + delete toàn bộ ---
  /find\s+[\/\\]\s+.*-delete/,                      // find / -delete
  /find\s+[\/\\]\s+.*-exec\s+rm/,                   // find / -exec rm

  // --- Database destruction ---
  /drop\s+database/i,                                // DROP DATABASE
  /drop\s+table/i,                                   // DROP TABLE
  /truncate\s+table/i,                               // TRUNCATE TABLE

  // --- Ghi đè thiết bị / phá filesystem ---
  />\s*\/dev\/sd[a-z]/,                              // > /dev/sda
  /dd\s+.*of=\/dev\/sd[a-z]/,                        // dd if=/dev/zero of=/dev/sda
  /dd\s+.*of=\/dev\/nvme/,                           // dd to NVMe devices
  /mkfs\./,                                           // mkfs.ext4

  // --- Fork bomb và biến thể ---
  /:\(\)\s*\{\s*:\|:&\s*\};:/,                      // :(){ :|:& };: classic
  /\.\(\)\s*\{\s*\.\|\.\&\s*\};/,                   // biến thể dùng dot
  /fork\s*bomb/i,                                     // comment/intent detection

  // --- Download + execute (pipe to shell) ---
  /curl\s+.*\|\s*(ba)?sh/i,                          // curl ... | bash/sh
  /wget\s+.*\|\s*(ba)?sh/i,                          // wget ... | bash/sh
  /curl\s+.*\|\s*python/i,                           // curl ... | python
  /wget\s+.*\|\s*python/i,                           // wget ... | python
  /curl\s+.*\|\s*perl/i,                             // curl ... | perl
  /wget\s+.*\|\s*perl/i,                             // wget ... | perl
  /curl\s+.*\|\s*ruby/i,                             // curl ... | ruby
  /wget\s+.*\|\s*ruby/i,                             // wget ... | ruby

  // --- Python inline destruction ---
  /python[3]?\s+-c\s+.*shutil\.rmtree\s*\(\s*['"]\/['"]/i, // python -c "shutil.rmtree('/')"
  /python[3]?\s+-c\s+.*os\.system\s*\(/i,            // python -c "os.system(...)"

  // --- Windows: PowerShell encoded commands (bypass detection) ---
  // Match -enc, -encodedcommand nhung KHONG match -ExecutionPolicy, -ErrorAction
  /powershell\s+.*-enc(odedcommand)?(\s|$)/i,       // powershell -enc ... (base64 hidden)
  /pwsh\s+.*-enc(odedcommand)?(\s|$)/i,             // pwsh -enc ...

  // --- Force push to main/master (phá code chung) ---
  /git\s+push\s+.*--force.*\s+(main|master)/i,      // git push --force origin main
  /git\s+push\s+.*\s+(main|master)\s+.*--force/i,   // git push origin main --force
  /git\s+push\s+-f\s+.*\s+(main|master)/i,          // git push -f origin main
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

  // --- Download từ URL bên ngoài (không pipe to shell thì confirm) ---
  { pattern: /curl\s+https?:\/\//i, reason: 'Download từ URL bên ngoài' },
  { pattern: /wget\s+https?:\/\//i, reason: 'Download từ URL bên ngoài' },

  // --- chmod đệ quy nguy hiểm ---
  { pattern: /chmod\s+(-R|--recursive)\s+777/i, reason: 'chmod 777 đệ quy — mở toàn bộ quyền' },
  { pattern: /chmod\s+777\s+.*-R/i, reason: 'chmod 777 đệ quy — mở toàn bộ quyền' },

  // --- eval / bash -c wrapping (có thể ẩn lệnh nguy hiểm) ---
  { pattern: /eval\s+\$\(/i, reason: 'eval $(...) — có thể ẩn lệnh nguy hiểm' },
  { pattern: /bash\s+-c\s+["']/i, reason: 'bash -c — chạy lệnh gián tiếp, kiểm tra nội dung' },
  { pattern: /sh\s+-c\s+["']/i, reason: 'sh -c — chạy lệnh gián tiếp, kiểm tra nội dung' },

  // --- npm run với script không rõ nội dung ---
  { pattern: /npm\s+run\s+(?!start|dev|build|test|lint|format|typecheck)/i, reason: 'npm run script không chuẩn — kiểm tra nội dung script' },
  { pattern: /npx\s+/i, reason: 'npx — chạy package trực tiếp, cần verify' },
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
   * Chạy lệnh shell (foreground voi timeout, hoac background voi PID)
   */
  async executeCommand({ command, cwd, timeout = DEFAULT_TIMEOUT, background = false }) {
    // Background mode: spawn detached, return ngay
    if (background) {
      // 1. Check blocked (van apply — tranh spawn destructive bg)
      const blockCheck = this._checkBlocked(command);
      if (blockCheck.blocked) {
        return { success: false, error: `BLOCKED: ${blockCheck.reason}`, exit_code: -1 };
      }
      // 2. Check confirm (bg commands van can user approve neu risky)
      const confirmCheck = this._checkNeedsConfirm(command);
      if (confirmCheck.needsConfirm) {
        if (!this.confirmCallback) {
          return { success: false, error: `BLOCKED: "${confirmCheck.reason}" — cần confirm nhưng không có confirm callback.`, exit_code: -1 };
        }
        const confirmed = await this.confirmCallback(command, confirmCheck.reason);
        if (!confirmed) return { success: false, error: `User từ chối: ${confirmCheck.reason}`, exit_code: -1 };
      }

      const execCwd = cwd
        ? (path.isAbsolute(cwd) ? cwd : path.resolve(this.projectDir, cwd))
        : this.projectDir;

      try {
        const { getBgManager } = require('./background-bash');
        const pid = getBgManager().spawn(command, execCwd);
        return {
          success: true,
          background: true,
          pid,
          cmd: command.slice(0, 100),
          cwd: execCwd,
          hint: 'Use bg_output(pid) to read output, bg_kill(pid) to stop.'
        };
      } catch (e) {
        return { success: false, error: `Background spawn failed: ${e.message}`, exit_code: -1 };
      }
    }

    // 1. Check blocked
    const blockCheck = this._checkBlocked(command);
    if (blockCheck.blocked) {
      return {
        success: false,
        error: `BLOCKED: ${blockCheck.reason}`,
        exit_code: -1
      };
    }

    // 2. Check confirm — neu khong co callback thi BLOCK lenh can confirm (an toan)
    const confirmCheck = this._checkNeedsConfirm(command);
    if (confirmCheck.needsConfirm) {
      if (!this.confirmCallback) {
        return {
          success: false,
          error: `BLOCKED: "${confirmCheck.reason}" — cần confirm nhưng không có confirm callback. Cấu hình onConfirm khi tạo TerminalRunner.`,
          exit_code: -1
        };
      }
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
      // PowerShell có aliases ls/cat/pwd và hỗ trợ piping tốt hơn cmd.exe.
      // Translate các Unix pipe fragments phổ biến để agent không cần biết PS syntax.
      const resolvedCommand = isWindows ? translateForWindows(command) : command;
      const shell = isWindows ? 'powershell.exe' : '/bin/bash';
      const shellArgs = isWindows
        ? ['-NoProfile', '-NonInteractive', '-Command', resolvedCommand]
        : ['-c', resolvedCommand];

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

// Standalone blocklist check — dùng cho tool khác (wsl_exec, background-bash) để
// apply cùng blocklist mà không cần instantiate TerminalRunner
function checkBlocked(command) {
  if (typeof command !== 'string') return { blocked: true, reason: 'command không phải string' };
  for (const pattern of BLOCKED_COMMANDS) {
    if (pattern.test(command)) {
      return { blocked: true, reason: `Lệnh bị cấm: ${command.slice(0, 80)}` };
    }
  }
  return { blocked: false };
}

module.exports = { TerminalRunner, BLOCKED_COMMANDS, CONFIRM_COMMANDS, checkBlocked };
