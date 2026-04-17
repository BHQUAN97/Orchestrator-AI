'use strict';

// Doc Windows Event Log — dung Get-WinEvent voi FilterHashtable
const { runPowerShell } = require('./ps-bridge');

// Map level string -> int cua Windows (1=Critical,2=Error,3=Warning,4=Information)
const LEVEL_MAP = {
  Critical: 1,
  Error: 2,
  Warning: 3,
  Information: 4,
};

function psString(s) {
  return String(s).replace(/'/g, "''");
}

/**
 * Doc Event Log.
 * @param {Object} opts
 * @param {string} [opts.log='System'] - Ten log (System, Application, Security...)
 * @param {string} [opts.level] - Critical | Error | Warning | Information
 * @param {string} [opts.source] - ProviderName
 * @param {number} [opts.max=20]
 * @param {number} [opts.since_minutes=60]
 */
async function readEventLog({ log = 'System', level, source, max = 20, since_minutes = 60 } = {}) {
  const logName = psString(log);
  const parts = [`LogName='${logName}'`];

  if (level && LEVEL_MAP[level] != null) {
    parts.push(`Level=${LEVEL_MAP[level]}`);
  }
  if (source) {
    parts.push(`ProviderName='${psString(source)}'`);
  }
  if (since_minutes > 0) {
    parts.push(`StartTime=(Get-Date).AddMinutes(-${Math.abs(Number(since_minutes) || 60)})`);
  }

  const filter = `@{ ${parts.join('; ')} }`;
  const maxN = Math.max(1, Math.min(1000, Number(max) || 20));

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try {
  $evts = Get-WinEvent -FilterHashtable ${filter} -MaxEvents ${maxN} |
    Select-Object TimeCreated, LevelDisplayName, ProviderName, Id, Message |
    ForEach-Object {
      [PSCustomObject]@{
        TimeCreated = $_.TimeCreated.ToString('o')
        Level = $_.LevelDisplayName
        ProviderName = $_.ProviderName
        Id = $_.Id
        Message = ($_.Message -replace "\\r\\n"," " -replace "\\n"," ")
      }
    }
  if ($evts) { $evts | ConvertTo-Json -Depth 3 -Compress } else { '[]' }
} catch {
  Write-Output '[]'
}
`;

  const res = await runPowerShell({ script, timeout: 20000 });

  // Parse stdout ngay ca khi exit code != 0 (CLIXML warning)
  let events = [];
  let parseOk = false;
  try {
    const raw = (res.stdout || '').trim();
    if (raw) {
      const j = JSON.parse(raw);
      events = Array.isArray(j) ? j : [j];
      parseOk = true;
    } else {
      parseOk = true;
    }
  } catch (_) {
    parseOk = false;
  }

  if (!parseOk && !res.success) {
    return { success: false, error: res.error || 'event log read failed', events: [] };
  }

  return { success: true, events, count: events.length };
}

module.exports = { readEventLog };
