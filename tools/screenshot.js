#!/usr/bin/env node
'use strict';

/**
 * Screenshot Tool — Chup man hinh Windows de feed cho vision model
 *
 * Dung PowerShell + System.Windows.Forms + System.Drawing (khong can npm dep).
 * Output: file PNG/JPG + optional base64 data URL (de goi /api/vision).
 *
 * Exports:
 *   captureScreen({monitor, region, format, save_path, return_base64})
 *   captureWindow({title, fuzzy})
 *   listMonitors()
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// Giam gioi han base64 ~ 5MB de tranh nuot RAM/context
const BASE64_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;

// Project root: cwd (tuong ung orcai CLI working dir)
function getScreenshotDir() {
  const dir = path.join(process.cwd(), '.orcai', 'screenshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function timestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds()) +
    '-' +
    pad(d.getMilliseconds(), 3)
  );
}

function isWindows() {
  return os.platform() === 'win32';
}

function notSupported() {
  return { success: false, error: 'Only supported on Windows' };
}

/**
 * Chay PowerShell script (encoded base64 UTF-16LE) va tra ve { success, stdout, stderr }.
 * Khong dung shell — spawn truc tiep de tranh escape hell.
 */
function runPowerShell(script, timeout = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    // PowerShell -EncodedCommand nhan base64 cua UTF-16LE
    const encoded = Buffer.from(script, 'utf16le').toString('base64');

    let child;
    try {
      child = spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true }
      );
    } catch (err) {
      return resolve({ success: false, stdout: '', stderr: '', error: err.message });
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      if (!settled) {
        settled = true;
        resolve({ success: false, stdout, stderr, error: `Timeout after ${timeout}ms` });
      }
    }, timeout);

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ success: false, stdout, stderr, error: err.message });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ success: code === 0, stdout, stderr, exitCode: code });
    });
  });
}

/**
 * Build doan PS set ImageFormat tu extension.
 */
function formatToImageFormat(format) {
  const f = String(format || 'png').toLowerCase();
  if (f === 'jpg' || f === 'jpeg') return { ext: 'jpg', psFormat: 'Jpeg' };
  return { ext: 'png', psFormat: 'Png' };
}

/**
 * Dam bao save_path co extension dung + tao thu muc cha neu can.
 */
function resolveSavePath(savePath, ext) {
  let p;
  if (savePath) {
    p = path.resolve(savePath);
  } else {
    p = path.join(getScreenshotDir(), `${timestamp()}.${ext}`);
  }
  const parent = path.dirname(p);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  return p;
}

/**
 * Escape string cho nhung single-quoted PowerShell literal ('...').
 * Trong PS single-quote, chi can double dau nhay don.
 */
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * Doc file da save, tao metadata { size_bytes, base64? }.
 */
function readOutput(filePath, returnBase64, mimeHint) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: `Output file not found: ${filePath}` };
  }
  const stat = fs.statSync(filePath);
  const out = { ok: true, size_bytes: stat.size };

  if (returnBase64) {
    if (stat.size > BASE64_MAX_BYTES) {
      out.warning = `File ${stat.size} bytes > ${BASE64_MAX_BYTES} limit; base64 skipped.`;
    } else {
      const buf = fs.readFileSync(filePath);
      const mime = mimeHint === 'jpg' ? 'image/jpeg' : 'image/png';
      out.base64 = `data:${mime};base64,${buf.toString('base64')}`;
    }
  }
  return out;
}

// =====================================================================
// listMonitors()
// =====================================================================
async function listMonitors() {
  if (!isWindows()) return notSupported();

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$screens = [System.Windows.Forms.Screen]::AllScreens
$primary = [System.Windows.Forms.Screen]::PrimaryScreen
$result = @()
for ($i = 0; $i -lt $screens.Length; $i++) {
  $s = $screens[$i]
  $b = $s.Bounds
  $result += [PSCustomObject]@{
    index = $i
    width = [int]$b.Width
    height = [int]$b.Height
    primary = ($s.DeviceName -eq $primary.DeviceName)
    bounds = @{ x = [int]$b.X; y = [int]$b.Y; w = [int]$b.Width; h = [int]$b.Height }
    device = $s.DeviceName
  }
}
$result | ConvertTo-Json -Compress -Depth 5
`;

  const res = await runPowerShell(script, 10000);
  if (!res.success) {
    return { success: false, error: res.error || res.stderr || 'PowerShell failed' };
  }
  try {
    const raw = res.stdout.trim();
    if (!raw) return { success: true, monitors: [] };
    let parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) parsed = [parsed];
    return { success: true, monitors: parsed };
  } catch (err) {
    return { success: false, error: `Parse JSON failed: ${err.message}`, raw: res.stdout };
  }
}

// =====================================================================
// captureScreen(...)
// =====================================================================
async function captureScreen({
  monitor = 'primary',
  region = null,
  format = 'png',
  save_path = null,
  return_base64 = true,
} = {}) {
  if (!isWindows()) return notSupported();

  const { ext, psFormat } = formatToImageFormat(format);
  const outPath = resolveSavePath(save_path, ext);

  // Build doan chon bounds
  // - region: uu tien tuyet doi (toa do virtual screen)
  // - monitor 'all': chup toan bo virtual desktop (SystemInformation.VirtualScreen)
  // - monitor 'primary' (default): PrimaryScreen.Bounds
  // - monitor <int>: AllScreens[<index>].Bounds
  let boundsBlock;
  if (region && typeof region === 'object') {
    const x = Number(region.x) | 0;
    const y = Number(region.y) | 0;
    const w = Math.max(1, Number(region.width) | 0);
    const h = Math.max(1, Number(region.height) | 0);
    boundsBlock = `$bx = ${x}; $by = ${y}; $bw = ${w}; $bh = ${h}`;
  } else if (monitor === 'all') {
    boundsBlock = `
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bx = [int]$vs.X; $by = [int]$vs.Y; $bw = [int]$vs.Width; $bh = [int]$vs.Height
`;
  } else if (typeof monitor === 'number' || (typeof monitor === 'string' && /^\d+$/.test(monitor))) {
    const idx = Number(monitor) | 0;
    boundsBlock = `
$screens = [System.Windows.Forms.Screen]::AllScreens
if (${idx} -ge $screens.Length) { throw "Monitor index ${idx} out of range ($($screens.Length) screens)" }
$b = $screens[${idx}].Bounds
$bx = [int]$b.X; $by = [int]$b.Y; $bw = [int]$b.Width; $bh = [int]$b.Height
`;
  } else {
    // primary
    boundsBlock = `
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bx = [int]$b.X; $by = [int]$b.Y; $bw = [int]$b.Width; $bh = [int]$b.Height
`;
  }

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
${boundsBlock}
$bmp = New-Object System.Drawing.Bitmap $bw, $bh
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen((New-Object System.Drawing.Point $bx, $by), [System.Drawing.Point]::Empty, (New-Object System.Drawing.Size $bw, $bh))
  $bmp.Save(${psQuote(outPath)}, [System.Drawing.Imaging.ImageFormat]::${psFormat})
} finally {
  $g.Dispose()
  $bmp.Dispose()
}
Write-Output (@{ width = $bw; height = $bh; path = ${psQuote(outPath)} } | ConvertTo-Json -Compress)
`;

  const res = await runPowerShell(script, DEFAULT_TIMEOUT_MS);
  if (!res.success) {
    return { success: false, error: res.error || res.stderr || 'PowerShell capture failed', path: outPath };
  }

  let meta = {};
  try {
    const line = res.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
    if (line) meta = JSON.parse(line);
  } catch (_) { /* ignore parse — fall back to file */ }

  const out = readOutput(outPath, return_base64, ext);
  if (!out.ok) return { success: false, error: out.error, path: outPath };

  return {
    success: true,
    path: outPath,
    width: meta.width || null,
    height: meta.height || null,
    size_bytes: out.size_bytes,
    base64: out.base64 || null,
    warning: out.warning || null,
  };
}

// =====================================================================
// captureWindow(...)
// =====================================================================
async function captureWindow({ title, fuzzy = true, format = 'png', save_path = null, return_base64 = true } = {}) {
  if (!isWindows()) return notSupported();
  if (!title || typeof title !== 'string') {
    return { success: false, error: '`title` is required' };
  }

  const { ext, psFormat } = formatToImageFormat(format);
  const outPath = resolveSavePath(save_path, ext);

  // Dung P/Invoke: FindWindow + GetWindowRect + SetForegroundWindow
  // Fuzzy: EnumWindows + match partial title (case-insensitive)
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null

$sig = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32Api {
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
if (-not ([System.Management.Automation.PSTypeName]'Win32Api').Type) {
  Add-Type -TypeDefinition $sig -Language CSharp
}

$target = ${psQuote(title)}
$fuzzy = $${fuzzy ? 'true' : 'false'}
$found = [IntPtr]::Zero
$foundTitle = ''

$cb = [Win32Api+EnumWindowsProc]{
  param($hWnd, $lParam)
  if (-not [Win32Api]::IsWindowVisible($hWnd)) { return $true }
  $len = [Win32Api]::GetWindowTextLength($hWnd)
  if ($len -le 0) { return $true }
  $sb = New-Object System.Text.StringBuilder ($len + 1)
  [Win32Api]::GetWindowText($hWnd, $sb, $sb.Capacity) | Out-Null
  $t = $sb.ToString()
  if ($fuzzy) {
    if ($t.ToLower().Contains($target.ToLower())) {
      $script:found = $hWnd
      $script:foundTitle = $t
      return $false
    }
  } else {
    if ($t -eq $target) {
      $script:found = $hWnd
      $script:foundTitle = $t
      return $false
    }
  }
  return $true
}
[Win32Api]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ($found -eq [IntPtr]::Zero) { throw "Window not found: $target" }

# Dua cua so len truoc va cho render
[Win32Api]::ShowWindow($found, 9) | Out-Null   # SW_RESTORE
[Win32Api]::SetForegroundWindow($found) | Out-Null
Start-Sleep -Milliseconds 250

$rect = New-Object Win32Api+RECT
[Win32Api]::GetWindowRect($found, [ref]$rect) | Out-Null
$bx = [int]$rect.Left
$by = [int]$rect.Top
$bw = [int]($rect.Right - $rect.Left)
$bh = [int]($rect.Bottom - $rect.Top)
if ($bw -le 0 -or $bh -le 0) { throw "Window has zero size (minimized?)" }

$bmp = New-Object System.Drawing.Bitmap $bw, $bh
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen((New-Object System.Drawing.Point $bx, $by), [System.Drawing.Point]::Empty, (New-Object System.Drawing.Size $bw, $bh))
  $bmp.Save(${psQuote(outPath)}, [System.Drawing.Imaging.ImageFormat]::${psFormat})
} finally {
  $g.Dispose()
  $bmp.Dispose()
}

Write-Output (@{ width = $bw; height = $bh; path = ${psQuote(outPath)}; title = $foundTitle } | ConvertTo-Json -Compress)
`;

  const res = await runPowerShell(script, DEFAULT_TIMEOUT_MS);
  if (!res.success) {
    return { success: false, error: res.error || res.stderr || 'PowerShell window-capture failed', path: outPath };
  }

  let meta = {};
  try {
    const line = res.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
    if (line) meta = JSON.parse(line);
  } catch (_) { /* ignore */ }

  const out = readOutput(outPath, return_base64, ext);
  if (!out.ok) return { success: false, error: out.error, path: outPath };

  return {
    success: true,
    path: outPath,
    width: meta.width || null,
    height: meta.height || null,
    matched_title: meta.title || null,
    size_bytes: out.size_bytes,
    base64: out.base64 || null,
    warning: out.warning || null,
  };
}

module.exports = {
  captureScreen,
  captureWindow,
  listMonitors,
};
