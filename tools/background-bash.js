#!/usr/bin/env node
/**
 * Background Bash — Spawn dai han (dev server, tail -f, watch) va quan ly
 *
 * Tools moi:
 * - execute_command({..., background: true}) → return PID + auto-detach
 * - bg_list → liet ke all running bg processes
 * - bg_output(pid) → lay output gan day cua bg proc
 * - bg_kill(pid) → kill proc
 *
 * Processes:
 * - Spawn detached, stdout/stderr captured to ring buffer (last 100KB)
 * - Auto-cleanup on orcai exit
 * - PID map luu trong BackgroundProcessManager (singleton per orcai process)
 */

const { spawn } = require('child_process');
const treeKill = require('tree-kill');

const MAX_OUTPUT_BYTES = 100 * 1024; // 100KB ring buffer per proc

class BackgroundProcessManager {
  constructor() {
    this.procs = new Map(); // pid → { proc, cmd, cwd, startedAt, stdout, stderr, exitCode, exitedAt }
    this._onExitRegistered = false;
    this._registerExitHandler();
  }

  _registerExitHandler() {
    if (this._onExitRegistered) return;
    this._onExitRegistered = true;
    const cleanup = () => {
      for (const [pid, info] of this.procs) {
        if (info.proc && info.exitCode === null) {
          try { treeKill(pid, 'SIGKILL'); } catch { try { info.proc.kill('SIGKILL'); } catch {} }
        }
      }
    };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(130); });
    process.on('SIGTERM', () => { cleanup(); process.exit(143); });
  }

  spawn(command, cwd) {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/bash';
    const shellArgs = isWindows ? ['/c', command] : ['-c', command];

    const proc = spawn(shell, shellArgs, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWindows, // Windows doesn't have detached stdio the same way
      windowsHide: true
    });

    const info = {
      proc,
      cmd: command,
      cwd,
      startedAt: new Date().toISOString(),
      stdout: '',
      stderr: '',
      exitCode: null,
      exitedAt: null
    };

    proc.stdout?.on('data', d => {
      info.stdout += d.toString();
      if (info.stdout.length > MAX_OUTPUT_BYTES) info.stdout = info.stdout.slice(-MAX_OUTPUT_BYTES / 2);
    });
    proc.stderr?.on('data', d => {
      info.stderr += d.toString();
      if (info.stderr.length > MAX_OUTPUT_BYTES) info.stderr = info.stderr.slice(-MAX_OUTPUT_BYTES / 2);
    });
    proc.on('exit', (code) => {
      info.exitCode = code;
      info.exitedAt = new Date().toISOString();
    });
    proc.on('error', (err) => {
      info.stderr += `\n[spawn error] ${err.message}`;
      info.exitCode = -1;
      info.exitedAt = new Date().toISOString();
    });

    this.procs.set(proc.pid, info);
    return proc.pid;
  }

  list() {
    return [...this.procs.entries()].map(([pid, info]) => ({
      pid,
      cmd: info.cmd.slice(0, 100),
      cwd: info.cwd,
      startedAt: info.startedAt,
      exitCode: info.exitCode,
      running: info.exitCode === null,
      output_bytes: info.stdout.length + info.stderr.length
    }));
  }

  getOutput(pid, { tail = 50 } = {}) {
    const info = this.procs.get(Number(pid));
    if (!info) return null;
    const stdoutLines = info.stdout.split('\n').slice(-tail).join('\n');
    const stderrLines = info.stderr.split('\n').slice(-tail).join('\n');
    return {
      pid,
      cmd: info.cmd,
      running: info.exitCode === null,
      exitCode: info.exitCode,
      stdout: stdoutLines,
      stderr: stderrLines
    };
  }

  kill(pid) {
    const info = this.procs.get(Number(pid));
    if (!info) return { success: false, error: `No such PID: ${pid}` };
    if (info.exitCode !== null) return { success: true, already_exited: true, exitCode: info.exitCode };
    try {
      treeKill(Number(pid), 'SIGKILL');
    } catch (e) {
      try { info.proc.kill('SIGKILL'); } catch (e2) {
        return { success: false, error: `kill failed: ${e2.message}` };
      }
    }
    return { success: true, killed: pid };
  }
}

// Singleton per orcai process
let globalBgManager = null;
function getBgManager() {
  if (!globalBgManager) globalBgManager = new BackgroundProcessManager();
  return globalBgManager;
}

// === Tool handlers ===
async function bgList() {
  const mgr = getBgManager();
  const processes = mgr.list();
  return { success: true, total: processes.length, processes };
}

async function bgOutput(args) {
  const { pid, tail = 50 } = args;
  if (!pid) return { success: false, error: 'pid required' };
  const mgr = getBgManager();
  const result = mgr.getOutput(pid, { tail });
  if (!result) return { success: false, error: `No such PID: ${pid}` };
  return { success: true, ...result };
}

async function bgKill(args) {
  const { pid } = args;
  if (!pid) return { success: false, error: 'pid required' };
  const mgr = getBgManager();
  return mgr.kill(pid);
}

module.exports = { BackgroundProcessManager, getBgManager, bgList, bgOutput, bgKill };
