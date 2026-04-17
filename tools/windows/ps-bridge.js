'use strict';

// PowerShell bridge: chay script PowerShell va tra ve ket qua chuan hoa
const { spawn } = require('child_process');
const treeKill = require('tree-kill');

const MAX_OUTPUT = 100 * 1024; // 100KB

// Cat bot output neu qua dai de tranh nuot het context window
function truncate(str) {
  if (!str) return '';
  if (str.length <= MAX_OUTPUT) return str;
  const head = str.slice(0, MAX_OUTPUT);
  return head + `\n\n[...truncated ${str.length - MAX_OUTPUT} chars]`;
}

/**
 * Chay mot doan PowerShell script va tra ve output.
 * @param {Object} opts
 * @param {string} opts.script - PowerShell script (co the nhieu dong)
 * @param {number} [opts.timeout=30000] - Timeout (ms)
 * @param {string} [opts.cwd] - Working directory
 * @returns {Promise<{success: boolean, stdout: string, stderr: string, exitCode: number, error?: string}>}
 */
async function runPowerShell({ script, timeout = 30000, cwd } = {}) {
  if (!script || typeof script !== 'string') {
    return { success: false, stdout: '', stderr: '', exitCode: -1, error: 'script is required' };
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    let settled = false;

    // Encode script dang base64 de tranh van de escape dau nhay khi script phuc tap
    const encoded = Buffer.from(script, 'utf16le').toString('base64');

    const child = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { cwd: cwd || process.cwd(), windowsHide: true }
    );

    const timer = setTimeout(() => {
      killed = true;
      try {
        treeKill(child.pid, 'SIGKILL');
      } catch (_) { /* ignore */ }
    }, timeout);

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ success: false, stdout: truncate(stdout), stderr: truncate(stderr), exitCode: -1, error: err.message });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killed) {
        return resolve({
          success: false,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          exitCode: code == null ? -1 : code,
          error: `Timeout after ${timeout}ms`,
        });
      }
      resolve({
        success: code === 0,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        exitCode: code == null ? -1 : code,
      });
    });
  });
}

module.exports = { runPowerShell };
