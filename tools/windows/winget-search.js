'use strict';

// Tim package qua winget
const { spawn } = require('child_process');

function runWinget(args, timeout = 30000) {
  return new Promise((resolve) => {
    const child = spawn('winget', args, { windowsHide: true });
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

// Parse bang winget: header dang "Name  Id  Version  [Match] Source"
// Sau header la dong "-----" roi den data rows, mac dinh cach nhau bang space
function parseWingetTable(output) {
  const lines = output.split(/\r?\n/).map((l) => l.replace(/\u0000/g, '')).filter((l) => l.trim().length > 0);
  // Tim dong header (chua "Name" va "Id" va "Version")
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/\bName\b/.test(l) && /\bId\b/.test(l) && /\bVersion\b/.test(l)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];

  const header = lines[headerIdx];
  // Dong ngay sau header thuong la "-----", bo qua
  const dataStart = (lines[headerIdx + 1] && /^-+(\s+-+)*$/.test(lines[headerIdx + 1].trim()))
    ? headerIdx + 2
    : headerIdx + 1;

  // Xac dinh vi tri cot tu header
  const cols = [];
  const names = ['Name', 'Id', 'Version', 'Match', 'Source'];
  for (const n of names) {
    const idx = header.indexOf(n);
    if (idx >= 0) cols.push({ name: n, idx });
  }
  cols.sort((a, b) => a.idx - b.idx);

  const results = [];
  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^-+/.test(line.trim())) continue;

    const row = {};
    for (let c = 0; c < cols.length; c++) {
      const start = cols[c].idx;
      const end = c + 1 < cols.length ? cols[c + 1].idx : line.length;
      row[cols[c].name] = line.slice(start, end).trim();
    }
    if (row.Name || row.Id) {
      results.push({
        name: row.Name || '',
        id: row.Id || '',
        version: row.Version || '',
        source: row.Source || '',
      });
    }
  }
  return results;
}

/**
 * Search package qua winget.
 * @param {Object} opts
 * @param {string} opts.query
 */
async function wingetSearch({ query } = {}) {
  if (!query || typeof query !== 'string') {
    return { success: false, error: 'query is required', results: [] };
  }

  const { code, stdout, stderr } = await runWinget(
    ['search', query, '--accept-source-agreements', '--disable-interactivity'],
    60000
  );

  if (code !== 0 && !stdout) {
    return { success: false, error: stderr || `winget exit ${code}`, results: [] };
  }

  const results = parseWingetTable(stdout);
  return { success: true, results, count: results.length };
}

module.exports = { wingetSearch };
