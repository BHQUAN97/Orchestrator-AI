'use strict';

// Truy van WMI qua Get-CimInstance (PowerShell)
const { runPowerShell } = require('./ps-bridge');

function psString(s) {
  return String(s).replace(/'/g, "''");
}

// WMI class/property name chỉ cho phép alphanum + underscore (tránh PS injection)
const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Query WMI/CIM.
 * @param {Object} opts
 * @param {string} opts.class_name - VD: Win32_Process, Win32_Service, Win32_LogicalDisk
 * @param {string[]} [opts.properties] - list field can lay
 * @param {string} [opts.where] - WMI WQL filter (VD: "Name LIKE '%node%'")
 */
async function wmiQuery({ class_name, properties, where } = {}) {
  if (!class_name || typeof class_name !== 'string') {
    return { success: false, error: 'class_name is required', results: [] };
  }

  // Class name phải là identifier hợp lệ (Win32_Process, Win32_Service, ...)
  if (!SAFE_IDENT_RE.test(class_name)) {
    return { success: false, error: `class_name không hợp lệ: ${class_name} (chỉ alphanum + underscore)`, results: [] };
  }

  // Properties phải là identifier hợp lệ — tránh PS injection qua field name
  if (Array.isArray(properties) && properties.length) {
    const bad = properties.find(p => typeof p !== 'string' || !SAFE_IDENT_RE.test(p));
    if (bad) {
      return { success: false, error: `property không hợp lệ: ${bad} (chỉ alphanum + underscore)`, results: [] };
    }
  }

  const cls = psString(class_name);
  const selectFields = Array.isArray(properties) && properties.length
    ? properties.join(',')
    : '*';

  let cmd;
  if (where && typeof where === 'string') {
    cmd = `Get-CimInstance -ClassName '${cls}' -Filter '${psString(where)}'`;
  } else {
    cmd = `Get-CimInstance -ClassName '${cls}'`;
  }

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try {
  $data = ${cmd} | Select-Object ${selectFields}
  if ($data) { $data | ConvertTo-Json -Depth 4 -Compress } else { '[]' }
} catch {
  Write-Output '[]'
}
`;

  const res = await runPowerShell({ script, timeout: 30000 });

  // Parse stdout du stderr co noise
  let results = [];
  let parseOk = false;
  try {
    const raw = (res.stdout || '').trim();
    if (raw) {
      const j = JSON.parse(raw);
      results = Array.isArray(j) ? j : [j];
      parseOk = true;
    } else {
      parseOk = true;
    }
  } catch (_) {
    parseOk = false;
  }

  if (!parseOk && !res.success) {
    return { success: false, error: res.error || 'wmi query failed', results: [] };
  }

  return { success: true, results, count: results.length };
}

module.exports = { wmiQuery };
