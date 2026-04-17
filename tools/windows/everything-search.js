'use strict';

// Tich hop Everything CLI (es.exe) de search file cuc nhanh tren Windows
// Fallback: Get-ChildItem khi khong co Everything
const { spawn } = require('child_process');
const { runPowerShell } = require('./ps-bridge');

let _esDetected = null; // cache

function which(cmd) {
  return new Promise((resolve) => {
    const child = spawn('where', [cmd], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code === 0 && out.trim()) resolve(out.trim().split(/\r?\n/)[0]);
      else resolve(null);
    });
  });
}

async function hasEverything() {
  if (_esDetected !== null) return _esDetected;
  const p = await which('es.exe');
  _esDetected = !!p;
  return _esDetected;
}

function runEs(args, timeout = 15000) {
  return new Promise((resolve) => {
    const child = spawn('es.exe', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
    }, timeout);
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function psString(s) {
  // Escape single quote cho PowerShell literal string
  return String(s).replace(/'/g, "''");
}

/**
 * Search file theo query.
 * @param {Object} opts
 * @param {string} opts.query
 * @param {number} [opts.max_results=50]
 * @param {boolean} [opts.regex=false]
 * @param {string} [opts.path] - Gioi han trong folder (fallback only)
 */
async function everythingSearch({ query, max_results = 50, regex = false, path } = {}) {
  if (!query || typeof query !== 'string') {
    return { success: false, error: 'query is required', results: [] };
  }

  const useEs = await hasEverything();

  if (useEs) {
    // es.exe: -n <max> -size -date-modified, optional -r cho regex, optional -path
    const args = ['-n', String(max_results), '-size', '-date-modified'];
    if (regex) args.push('-r');
    if (path) { args.push('-path', path); }
    args.push(query);

    try {
      const { code, stdout, stderr } = await runEs(args);
      if (code !== 0 && !stdout) {
        return { success: false, error: stderr || `es.exe exit ${code}`, results: [] };
      }
      // Parse output: mac dinh es.exe in ra tung duong dan tren 1 dong
      // Voi cac flag -size -date-modified, es.exe tra ve dang:
      //  <size> <date> <time> <path>
      // Tuy nhien format co the khac; fallback: chi lay path tu cuoi dong
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      const results = lines.slice(0, max_results).map((line) => {
        const m = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
        if (m) {
          return { path: m[4], size: Number(m[1]), modified: `${m[2]} ${m[3]}` };
        }
        return { path: line.trim(), size: null, modified: null };
      });
      return { success: true, results, engine: 'everything' };
    } catch (err) {
      return { success: false, error: err.message, results: [] };
    }
  }

  // Fallback: Get-ChildItem
  // Gioi han trong path de tranh scan toan bo C:\
  const searchRoot = path || process.cwd();
  const safeQuery = psString(query);
  const safeRoot = psString(searchRoot);
  const filter = regex
    ? `Where-Object { $_.Name -match '${safeQuery}' }`
    : `Where-Object { $_.Name -like '*${safeQuery}*' }`;

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$items = Get-ChildItem -LiteralPath '${safeRoot}' -Recurse -Force |
  ${filter} |
  Select-Object -First ${max_results} |
  ForEach-Object {
    [PSCustomObject]@{
      path = $_.FullName
      size = if ($_.PSIsContainer) { $null } else { $_.Length }
      modified = $_.LastWriteTime.ToString('o')
    }
  }
if ($items) { $items | ConvertTo-Json -Depth 3 -Compress } else { '[]' }
`;

  const res = await runPowerShell({ script, timeout: 30000 });

  // Parse stdout du co loi — PowerShell co the in CLIXML warning vao stderr nhung van co data
  let parsed = [];
  let parseOk = false;
  try {
    const raw = (res.stdout || '').trim();
    if (raw) {
      const j = JSON.parse(raw);
      parsed = Array.isArray(j) ? j : [j];
      parseOk = true;
    } else {
      parseOk = true; // khong co ket qua la hop le
    }
  } catch (_) {
    parseOk = false;
  }

  if (!parseOk && !res.success) {
    return { success: false, error: res.error || 'scan failed', results: [], engine: 'getchilditem' };
  }

  return { success: true, results: parsed, engine: 'getchilditem' };
}

module.exports = { everythingSearch, hasEverything };
