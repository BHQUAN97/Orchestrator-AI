'use strict';

// Doc/ghi Windows clipboard qua PowerShell
const { runPowerShell } = require('./ps-bridge');

const MAX_CLIP = 100 * 1024;

async function readClipboard() {
  // Kiểm tra xem clipboard có chứa ảnh không
  const checkImg = await runPowerShell({
    script: '$ProgressPreference = "SilentlyContinue"; $c = Get-Clipboard -Format Image; if ($c) { "IMAGE" } else { "TEXT" }',
    timeout: 5000
  });

  if (checkImg.stdout.trim() === 'IMAGE') {
    // Lưu ảnh ra file tạm để agent có thể xử lý
    const tempPath = require('path').join(process.env.TEMP || '.', `clip_${Date.now()}.png`);
    const saveImg = await runPowerShell({
      script: `$ProgressPreference = "SilentlyContinue"; $c = Get-Clipboard -Format Image; $c.Save("${tempPath}", [System.Drawing.Imaging.ImageFormat]::Png)`,
      timeout: 10000
    });
    if (saveImg.success) {
      return { success: true, content: `IMAGE:${tempPath}`, isImage: true };
    }
  }

  const res = await runPowerShell({
    script: '$ProgressPreference = "SilentlyContinue"; Get-Clipboard -Raw',
    timeout: 10000,
  });
  // Neu co stdout thi coi nhu OK du exit code khac 0 (CLIXML noise)
  let content = res.stdout || '';
  if (!content && !res.success) {
    return { success: false, content: '', error: res.error || 'clipboard read failed' };
  }
  if (content.length > MAX_CLIP) {
    content = content.slice(0, MAX_CLIP) + `\n\n[...truncated]`;
  }
  return { success: true, content };
}

async function writeClipboard({ content } = {}) {
  if (content == null) {
    return { success: false, error: 'content is required' };
  }
  const str = String(content);
  if (str.length > MAX_CLIP) {
    return { success: false, error: `content exceeds 100KB limit (got ${str.length})` };
  }

  // Dung stdin-like: truyen qua bien ENV de tranh escape
  // Ky thuat: encode base64 roi decode trong PowerShell
  const b64 = Buffer.from(str, 'utf8').toString('base64');
  const script = `
$bytes = [Convert]::FromBase64String('${b64}')
$text = [System.Text.Encoding]::UTF8.GetString($bytes)
Set-Clipboard -Value $text
`;
  const res = await runPowerShell({ script, timeout: 10000 });
  if (!res.success) {
    return { success: false, error: res.stderr || res.error || 'clipboard write failed' };
  }
  return { success: true, bytes: str.length };
}

module.exports = { readClipboard, writeClipboard };
