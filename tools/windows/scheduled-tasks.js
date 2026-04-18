'use strict';

// Scheduled Tasks wrapper via schtasks.exe
const { runPowerShell } = require('./ps-bridge');

function q(s) {
  return String(s).replace(/'/g, "''");
}

// Parse CSV output tu schtasks /fo csv
function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const splitRow = (line) => {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (c === ',' && !inQ) {
        out.push(cur); cur = '';
      } else { cur += c; }
    }
    out.push(cur);
    return out;
  };
  const headers = splitRow(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitRow(lines[i]);
    // schtasks csv co the repeat header — skip
    if (cols[0] === headers[0]) continue;
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = cols[j] || '';
    rows.push(obj);
  }
  return rows;
}

function parseListFormat(text) {
  // schtasks /fo LIST output: "Key:    Value"
  const out = {};
  String(text || '').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^([^:]+?):\s*(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  });
  return out;
}

async function tasksList({ filter } = {}) {
  const script = `schtasks /query /fo csv /v 2>&1`;
  const r = await runPowerShell({ script, timeout: 60000 });
  if (!r.success) return { ok: false, error: r.error || 'schtasks failed', stderr: r.stderr };
  let tasks = parseCsv(r.stdout);
  if (filter) {
    const f = String(filter).toLowerCase();
    tasks = tasks.filter((t) => Object.values(t).some((v) => String(v).toLowerCase().includes(f)));
  }
  return { ok: true, data: tasks };
}

async function tasksGet({ name } = {}) {
  if (!name) return { ok: false, error: 'name is required' };
  const script = `schtasks /query /tn '${q(name)}' /fo LIST /v 2>&1`;
  const r = await runPowerShell({ script });
  if (!r.success) return { ok: false, error: r.error || 'schtasks failed', stderr: r.stderr };
  return { ok: true, data: parseListFormat(r.stdout) };
}

async function tasksRun({ name } = {}) {
  if (!name) return { ok: false, error: 'name is required' };
  const r = await runPowerShell({ script: `schtasks /run /tn '${q(name)}' 2>&1` });
  if (!r.success) return { ok: false, error: r.error || 'schtasks failed', stderr: r.stderr };
  return { ok: true, data: { name, started: true, output: r.stdout.trim() } };
}

async function tasksEnd({ name } = {}) {
  if (!name) return { ok: false, error: 'name is required' };
  const r = await runPowerShell({ script: `schtasks /end /tn '${q(name)}' 2>&1` });
  if (!r.success) return { ok: false, error: r.error || 'schtasks failed', stderr: r.stderr };
  return { ok: true, data: { name, ended: true, output: r.stdout.trim() } };
}

async function tasksCreate({ name, command, schedule, startTime, user, confirm } = {}) {
  if (confirm !== true) return { ok: false, error: 'writes require confirm:true' };
  if (!name || !command || !schedule) {
    return { ok: false, error: 'name, command, schedule are required' };
  }
  // schedule: MINUTE|HOURLY|DAILY|WEEKLY|MONTHLY|ONCE|ONSTART|ONLOGON|ONIDLE
  const parts = [
    `/create`,
    `/tn '${q(name)}'`,
    `/tr '${q(command)}'`,
    `/sc ${q(schedule)}`,
  ];
  if (startTime) parts.push(`/st ${q(startTime)}`);
  if (user) parts.push(`/ru '${q(user)}'`);
  parts.push('/f');
  const script = `schtasks ${parts.join(' ')} 2>&1`;
  const r = await runPowerShell({ script });
  if (!r.success) return { ok: false, error: r.error || 'schtasks failed', stderr: r.stderr };
  return { ok: true, data: { name, created: true, output: r.stdout.trim() } };
}

async function tasksDelete({ name, confirm } = {}) {
  if (confirm !== true) return { ok: false, error: 'writes require confirm:true' };
  if (!name) return { ok: false, error: 'name is required' };
  const r = await runPowerShell({ script: `schtasks /delete /tn '${q(name)}' /f 2>&1` });
  if (!r.success) return { ok: false, error: r.error || 'schtasks failed', stderr: r.stderr };
  return { ok: true, data: { name, deleted: true, output: r.stdout.trim() } };
}

module.exports = { tasksList, tasksGet, tasksRun, tasksEnd, tasksCreate, tasksDelete };
