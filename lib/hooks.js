#!/usr/bin/env node
/**
 * Hooks System — Chay shell command khi co event
 *
 * Compat voi Claude Code settings.json format:
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         { "matcher": "write_file|edit_file",
 *           "hooks": [{ "type": "command", "command": "npm run lint -- --fix" }] }
 *       ],
 *       "PostToolUse": [...],
 *       "Stop": [...],
 *       "SessionStart": [...]
 *     }
 *   }
 *
 * Events:
 * - SessionStart: agent khoi tao
 * - PreToolUse: truoc khi goi tool (matcher match tool name) — exit !=0 → block
 * - PostToolUse: sau khi tool chay xong
 * - Stop: agent hoan thanh hoac abort
 *
 * Load thu tu: ~/.claude/settings.json → {projectDir}/.claude/settings.json → {projectDir}/.orcai/settings.json
 * Project hooks CONG them vao global hooks (khong override).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const HOOK_TIMEOUT_MS = 30000; // 30s mac dinh

function loadSettings(settingsPath) {
  try {
    if (!fs.existsSync(settingsPath)) return null;
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * HookRunner — quan ly va chay hooks
 */
class HookRunner {
  constructor(options = {}) {
    this.projectDir = options.projectDir || process.cwd();
    this.enabled = options.enabled !== false;
    this.verbose = !!options.verbose;
    this.hooks = {
      SessionStart: [],
      PreToolUse: [],
      PostToolUse: [],
      Stop: []
    };
    this._loaded = false;
  }

  load() {
    if (this._loaded) return;
    const sources = [
      path.join(os.homedir(), '.claude', 'settings.json'),
      path.join(this.projectDir, '.claude', 'settings.json'),
      path.join(this.projectDir, '.orcai', 'settings.json')
    ];
    for (const src of sources) {
      const settings = loadSettings(src);
      if (!settings?.hooks) continue;
      for (const event of Object.keys(this.hooks)) {
        const list = settings.hooks[event];
        if (Array.isArray(list)) {
          for (const entry of list) {
            this.hooks[event].push({ ...entry, _source: src });
          }
        }
      }
    }
    this._loaded = true;
  }

  /**
   * Chay hooks cho event
   * @param {string} event
   * @param {Object} context - { toolName, args, result, session, projectDir }
   * @returns {Promise<{ blocked: boolean, reason?: string, outputs: Array }>}
   */
  async run(event, context = {}) {
    if (!this.enabled) return { blocked: false, outputs: [] };
    this.load();

    const entries = this.hooks[event] || [];
    if (entries.length === 0) return { blocked: false, outputs: [] };

    const outputs = [];
    let blocked = false;
    let blockReason = null;

    for (const entry of entries) {
      // Matcher: regex string match tool name (chi ap cho PreToolUse/PostToolUse)
      if (entry.matcher && context.toolName) {
        let matched = false;
        try {
          matched = new RegExp(entry.matcher).test(context.toolName);
        } catch {
          // invalid regex — skip
          continue;
        }
        if (!matched) continue;
      }

      const hookList = entry.hooks || [];
      for (const hook of hookList) {
        if (hook.type !== 'command' || !hook.command) continue;
        try {
          const res = await runCommand(hook.command, {
            cwd: this.projectDir,
            timeout: hook.timeout || HOOK_TIMEOUT_MS,
            env: {
              ...process.env,
              ORCAI_EVENT: event,
              ORCAI_TOOL: context.toolName || '',
              ORCAI_PROJECT: this.projectDir,
              ORCAI_SESSION: context.session || ''
            },
            input: this.verbose ? JSON.stringify(context) : undefined
          });
          outputs.push({ event, command: hook.command, ...res });

          // PreToolUse: exit_code != 0 → block tool
          if (event === 'PreToolUse' && res.exit_code !== 0) {
            blocked = true;
            blockReason = res.stderr || res.stdout || `Hook ${hook.command.slice(0, 40)} returned ${res.exit_code}`;
            break;
          }
        } catch (e) {
          outputs.push({ event, command: hook.command, error: e.message });
          if (event === 'PreToolUse') {
            blocked = true;
            blockReason = `Hook failed: ${e.message}`;
            break;
          }
        }
      }
      if (blocked) break;
    }

    return { blocked, reason: blockReason, outputs };
  }

  /**
   * Count hooks loaded (cho startup banner)
   */
  getStats() {
    this.load();
    const stats = {};
    for (const event of Object.keys(this.hooks)) {
      stats[event] = this.hooks[event].length;
    }
    return stats;
  }
}

function runCommand(command, opts = {}) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/bash';
    const shellArgs = isWindows ? ['/c', command] : ['-c', command];

    let stdout = '', stderr = '';
    const proc = spawn(shell, shellArgs, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
    }, opts.timeout || HOOK_TIMEOUT_MS);

    if (opts.input) {
      try { proc.stdin.write(opts.input); proc.stdin.end(); } catch {}
    } else {
      try { proc.stdin.end(); } catch {}
    }

    proc.stdout.on('data', d => { stdout += d.toString(); if (stdout.length > 50000) stdout = stdout.slice(-25000); });
    proc.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 50000) stderr = stderr.slice(-25000); });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({
        exit_code: code,
        stdout: stdout.trim().slice(0, 5000),
        stderr: stderr.trim().slice(0, 2000)
      });
    });
  });
}

module.exports = { HookRunner, loadSettings };
