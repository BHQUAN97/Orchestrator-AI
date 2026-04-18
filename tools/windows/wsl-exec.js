'use strict';

// Passthrough tham chieu WSL — chay command Linux tu Windows
const { spawn } = require('child_process');
const treeKill = require('tree-kill');
const { checkBlocked } = require('../terminal-runner');

const MAX_OUTPUT = 100 * 1024;
let _distros = null; // cache danh sach distro

function truncate(str) {
  if (!str) return '';
  if (str.length <= MAX_OUTPUT) return str;
  return str.slice(0, MAX_OUTPUT) + `\n\n[...truncated ${str.length - MAX_OUTPUT} chars]`;
}

function runWslList() {
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', ['--list', '--quiet'], { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf16le'); });
    child.stderr.on('data', (d) => { err += d.toString('utf16le'); });
    child.on('error', () => resolve({ code: -1, distros: [], error: 'wsl not available' }));
    child.on('close', (code) => {
      if (code !== 0) return resolve({ code, distros: [], error: err });
      const distros = out
        .replace(/\u0000/g, '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      resolve({ code: 0, distros });
    });
  });
}

async function listDistros() {
  if (_distros) return _distros;
  const res = await runWslList();
  _distros = res.distros || [];
  return _distros;
}

/**
 * Chay command trong WSL.
 * @param {Object} opts
 * @param {string} opts.command - bash command
 * @param {string} [opts.distro] - ten distro (optional)
 * @param {string} [opts.cwd] - working dir WINDOWS (wsl.exe tu chuyen doi)
 * @param {number} [opts.timeout=30000]
 */
async function wslExec({ command, distro, cwd, timeout = 30000 } = {}) {
  if (!command || typeof command !== 'string') {
    return { success: false, stdout: '', stderr: '', exitCode: -1, error: 'command is required' };
  }

  // Apply cùng blocklist như TerminalRunner — wsl_exec vẫn chạy qua `sh -c` nên cần chặn
  // các lệnh phá hoại (rm -rf /, curl | bash, fork bomb, v.v.) dù là trong WSL
  const block = checkBlocked(command);
  if (block.blocked) {
    return { success: false, stdout: '', stderr: '', exitCode: -1, error: `BLOCKED: ${block.reason}` };
  }

  // Lay danh sach distro de verify
  const distros = await listDistros();
  if (distros.length === 0) {
    return { success: false, stdout: '', stderr: '', exitCode: -1, error: 'WSL not installed or no distros' };
  }
  if (distro && !distros.includes(distro)) {
    return { success: false, stdout: '', stderr: '', exitCode: -1, error: `distro '${distro}' not found. Available: ${distros.join(', ')}` };
  }

  const args = [];
  if (distro) { args.push('-d', distro); }
  if (cwd) { args.push('--cd', cwd); }
  // Dung sh thay vi bash de tuong thich voi minimal distro (docker-desktop, alpine)
  args.push('sh', '-c', command);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    let settled = false;

    const child = spawn('wsl.exe', args, { windowsHide: true });

    const timer = setTimeout(() => {
      killed = true;
      try { treeKill(child.pid, 'SIGKILL'); } catch (_) {}
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

module.exports = { wslExec, listDistros };
