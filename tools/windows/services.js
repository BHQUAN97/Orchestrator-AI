'use strict';

// Windows Services wrapper via Get-Service / Set-Service
const { runPowerShell } = require('./ps-bridge');

// Critical services — tuyet doi khong cho dung/restart
const CRITICAL = new Set(['winmgmt', 'rpcss', 'lsass', 'wininit', 'csrss', 'smss', 'services']);

function q(s) {
  return String(s).replace(/'/g, "''");
}

function isCritical(name) {
  return CRITICAL.has(String(name || '').toLowerCase());
}

function parseJson(stdout) {
  const s = (stdout || '').replace(/^\uFEFF/, '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

async function servicesList({ filter } = {}) {
  // Filter chỉ cho phép alphanum + vài ký tự an toàn cho service name — tránh PS script block escape qua `}`
  const safeFilter = filter ? String(filter).replace(/[^A-Za-z0-9\-_.]/g, '') : '';
  const where = safeFilter ? `| Where-Object { $_.Name -like '*${safeFilter}*' -or $_.DisplayName -like '*${safeFilter}*' }` : '';
  const script = `Get-Service ${where} | Select-Object Name,DisplayName,Status,StartType | ConvertTo-Json -Depth 3 -Compress`;
  const r = await runPowerShell({ script });
  if (!r.success) return { ok: false, error: r.error || 'powershell failed', stderr: r.stderr };
  const raw = parseJson(r.stdout);
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  // Status/StartType la enum int — convert to string where possible
  const normalize = (v) => (v && typeof v === 'object' && 'value' in v) ? v.value : v;
  const data = arr.map((s) => ({
    Name: s.Name,
    DisplayName: s.DisplayName,
    Status: normalize(s.Status),
    StartType: normalize(s.StartType),
  }));
  return { ok: true, data };
}

async function servicesGet({ name } = {}) {
  if (!name) return { ok: false, error: 'name is required' };
  const script = `
$ErrorActionPreference='Stop'
$s = Get-Service -Name '${q(name)}'
$c = Get-CimInstance -ClassName Win32_Service -Filter "Name='${q(name)}'"
@{
  Name = $s.Name
  DisplayName = $s.DisplayName
  Status = "$($s.Status)"
  StartType = "$($s.StartType)"
  Description = $c.Description
  PathName = $c.PathName
  StartName = $c.StartName
  ProcessId = $c.ProcessId
  DependentServices = @($s.DependentServices | ForEach-Object { $_.Name })
  RequiredServices = @($s.RequiredServices | ForEach-Object { $_.Name })
} | ConvertTo-Json -Depth 4 -Compress
`;
  const r = await runPowerShell({ script });
  if (!r.success) return { ok: false, error: r.error || 'powershell failed', stderr: r.stderr };
  return { ok: true, data: parseJson(r.stdout) };
}

function guardService(name, confirm) {
  if (confirm !== true) return 'writes require confirm:true';
  if (!name) return 'name is required';
  if (isCritical(name)) return `service '${name}' is critical and cannot be modified`;
  return null;
}

async function servicesStart({ name, confirm } = {}) {
  const g = guardService(name, confirm);
  if (g) return { ok: false, error: g };
  const r = await runPowerShell({ script: `Start-Service -Name '${q(name)}' -ErrorAction Stop; @{ok=$true}|ConvertTo-Json -Compress` });
  if (!r.success) return { ok: false, error: r.error || 'powershell failed', stderr: r.stderr };
  return { ok: true, data: { name, action: 'start' } };
}

async function servicesStop({ name, confirm } = {}) {
  const g = guardService(name, confirm);
  if (g) return { ok: false, error: g };
  const r = await runPowerShell({ script: `Stop-Service -Name '${q(name)}' -Force -ErrorAction Stop; @{ok=$true}|ConvertTo-Json -Compress` });
  if (!r.success) return { ok: false, error: r.error || 'powershell failed', stderr: r.stderr };
  return { ok: true, data: { name, action: 'stop' } };
}

async function servicesRestart({ name, confirm } = {}) {
  const g = guardService(name, confirm);
  if (g) return { ok: false, error: g };
  const r = await runPowerShell({ script: `Restart-Service -Name '${q(name)}' -Force -ErrorAction Stop; @{ok=$true}|ConvertTo-Json -Compress` });
  if (!r.success) return { ok: false, error: r.error || 'powershell failed', stderr: r.stderr };
  return { ok: true, data: { name, action: 'restart' } };
}

async function servicesSetStartType({ name, type, confirm } = {}) {
  const g = guardService(name, confirm);
  if (g) return { ok: false, error: g };
  const valid = ['Automatic', 'Auto', 'Manual', 'Disabled'];
  if (!valid.includes(type)) return { ok: false, error: `invalid type '${type}' (Auto|Manual|Disabled)` };
  const psType = type === 'Auto' ? 'Automatic' : type;
  const r = await runPowerShell({ script: `Set-Service -Name '${q(name)}' -StartupType ${psType} -ErrorAction Stop; @{ok=$true}|ConvertTo-Json -Compress` });
  if (!r.success) return { ok: false, error: r.error || 'powershell failed', stderr: r.stderr };
  return { ok: true, data: { name, startType: psType } };
}

module.exports = {
  servicesList,
  servicesGet,
  servicesStart,
  servicesStop,
  servicesRestart,
  servicesSetStartType,
};
