'use strict';

// Windows Registry wrapper — read/write via PowerShell Get/Set-ItemProperty
const { runPowerShell } = require('./ps-bridge');

// Cac path nhay cam — chan write tru khi ORCAI_REGISTRY_UNSAFE=1
const DANGEROUS_PATTERNS = [
  /^HKLM:\\SYSTEM\\CurrentControlSet\\Services(\\|$)/i,
  /\bSAM\b/i,
  /\bSECURITY\b/i,
  /\bPolicies\b/i,
];

function isDangerous(path) {
  if (!path) return false;
  return DANGEROUS_PATTERNS.some((re) => re.test(path));
}

function guardWrite(path) {
  if (process.env.ORCAI_REGISTRY_UNSAFE === '1') return null;
  if (isDangerous(path)) {
    return `path '${path}' is protected (set ORCAI_REGISTRY_UNSAFE=1 to override)`;
  }
  return null;
}

// Escape single quotes for PowerShell single-quoted string
function q(s) {
  return String(s).replace(/'/g, "''");
}

// Parse PS JSON output, trim trailing newlines/BOM
function parseJson(stdout) {
  const s = (stdout || '').replace(/^\uFEFF/, '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

async function registryGet({ path, valueName } = {}) {
  if (!path) return { ok: false, error: 'path is required' };
  const script = valueName
    ? `$ErrorActionPreference='Stop'; (Get-ItemProperty -Path '${q(path)}' -Name '${q(valueName)}') | Select-Object -ExpandProperty '${q(valueName)}' | ConvertTo-Json -Depth 4 -Compress`
    : `$ErrorActionPreference='Stop'; Get-ItemProperty -Path '${q(path)}' | ConvertTo-Json -Depth 4 -Compress`;
  const r = await runPowerShell({ script });
  if (!r.success) return { ok: false, error: r.error || 'powershell failed', stderr: r.stderr };
  return { ok: true, data: { path, valueName: valueName || null, value: parseJson(r.stdout) } };
}

async function registryList({ path } = {}) {
  if (!path) return { ok: false, error: 'path is required' };
  const script = `
$ErrorActionPreference='Stop'
$p='${q(path)}'
$subkeys = @()
try { $subkeys = Get-ChildItem -Path $p -ErrorAction Stop | ForEach-Object { $_.PSChildName } } catch {}
$values = @{}
try {
  $item = Get-ItemProperty -Path $p -ErrorAction Stop
  $item.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object { $values[$_.Name] = $_.Value }
} catch {}
@{ subkeys = $subkeys; values = $values } | ConvertTo-Json -Depth 4 -Compress
`;
  const r = await runPowerShell({ script });
  if (!r.success) return { ok: false, error: r.error || 'powershell failed', stderr: r.stderr };
  return { ok: true, data: { path, ...parseJson(r.stdout) } };
}

async function registrySet({ path, valueName, value, type, confirm } = {}) {
  if (confirm !== true) return { ok: false, error: 'writes require confirm:true' };
  if (!path || !valueName) return { ok: false, error: 'path and valueName are required' };
  const guard = guardWrite(path);
  if (guard) return { ok: false, error: guard };
  const validTypes = ['String', 'ExpandString', 'Binary', 'DWord', 'QWord', 'MultiString'];
  const t = type || 'String';
  if (!validTypes.includes(t)) return { ok: false, error: `invalid type '${t}'` };

  // Serialize value depending on type
  let valExpr;
  if (t === 'DWord' || t === 'QWord') {
    valExpr = String(Number(value));
  } else if (t === 'Binary') {
    const arr = Array.isArray(value) ? value : [];
    valExpr = `([byte[]](${arr.map((n) => Number(n) & 0xff).join(',') || '0'}))`;
  } else if (t === 'MultiString') {
    const arr = Array.isArray(value) ? value : [String(value)];
    valExpr = `@(${arr.map((s) => `'${q(s)}'`).join(',')})`;
  } else {
    valExpr = `'${q(value == null ? '' : value)}'`;
  }

  const script = `
$ErrorActionPreference='Stop'
if (-not (Test-Path -LiteralPath '${q(path)}')) { New-Item -Path '${q(path)}' -Force | Out-Null }
Set-ItemProperty -Path '${q(path)}' -Name '${q(valueName)}' -Value ${valExpr} -Type ${t} -Force
@{ ok = $true } | ConvertTo-Json -Compress
`;
  const r = await runPowerShell({ script });
  if (!r.success) return { ok: false, error: r.error || 'powershell failed', stderr: r.stderr };
  return { ok: true, data: { path, valueName, type: t } };
}

async function registryDelete({ path, valueName, confirm } = {}) {
  if (confirm !== true) return { ok: false, error: 'writes require confirm:true' };
  if (!path) return { ok: false, error: 'path is required' };
  const guard = guardWrite(path);
  if (guard) return { ok: false, error: guard };

  const script = valueName
    ? `$ErrorActionPreference='Stop'; Remove-ItemProperty -Path '${q(path)}' -Name '${q(valueName)}' -Force; @{ok=$true}|ConvertTo-Json -Compress`
    : `$ErrorActionPreference='Stop'; Remove-Item -Path '${q(path)}' -Recurse -Force; @{ok=$true}|ConvertTo-Json -Compress`;
  const r = await runPowerShell({ script });
  if (!r.success) return { ok: false, error: r.error || 'powershell failed', stderr: r.stderr };
  return { ok: true, data: { path, valueName: valueName || null, deleted: true } };
}

module.exports = { registryGet, registryList, registrySet, registryDelete };
