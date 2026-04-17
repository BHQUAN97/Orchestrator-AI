#!/usr/bin/env node
/**
 * @mention Expander — Parse @path trong prompt, inline file content
 *
 * Cach dung:
 *   prompt: "Sua bug trong @src/auth.js va @tests/auth.test.js"
 *   → read 2 files, append content vao prompt
 *
 * Rules:
 * - @path: path tuong doi tu projectDir
 * - @"path with spaces.txt": quoted cho path co space
 * - Chi read file (khong folder)
 * - Max 200KB/file, max 10 mentions/prompt (chong spam)
 * - Chi read trong project dir (khong leak file ngoai)
 * - Skip neu match email/twitter (co @ giua 2 word)
 */

const fs = require('fs');
const path = require('path');

const MAX_MENTIONS = 10;
const MAX_FILE_SIZE = 200 * 1024; // 200KB

/**
 * @param {string} prompt
 * @param {string} projectDir
 * @returns {{ prompt: string, attachments: Array<{path, lines, bytes}> }}
 */
function expandMentions(prompt, projectDir) {
  if (!prompt || !prompt.includes('@')) {
    return { prompt, attachments: [] };
  }

  // Regex: @"quoted path" HOAC @non-whitespace
  // Chan email: neu co char truoc @ la word char → skip
  const regex = /(^|[^\w])@(?:"([^"]+)"|([^\s"@<>|]+))/g;

  const mentions = [];
  const seen = new Set();
  let match;
  while ((match = regex.exec(prompt))) {
    const raw = match[2] || match[3];
    if (!raw) continue;
    // Loai bo trailing punctuation (@file.js, va @other.js.)
    const cleaned = raw.replace(/[.,;:!?)\]}>]+$/, '');
    if (!cleaned) continue;
    // Skip neu khong giong path
    if (!/[\/\\]/.test(cleaned) && !/\.[a-zA-Z0-9]+$/.test(cleaned)) continue;
    if (cleaned.length > 250) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    mentions.push(cleaned);
    if (mentions.length >= MAX_MENTIONS) break;
  }

  if (mentions.length === 0) return { prompt, attachments: [] };

  const projNorm = path.normalize(projectDir);
  const attachments = [];

  for (const rel of mentions) {
    const full = path.isAbsolute(rel) ? path.normalize(rel) : path.resolve(projectDir, rel);
    // Sandbox check
    if (!full.startsWith(projNorm + path.sep) && full !== projNorm) continue;
    if (!fs.existsSync(full)) continue;

    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_SIZE) {
        attachments.push({ path: rel, error: `File too large (${Math.round(stat.size / 1024)}KB > 200KB)` });
        continue;
      }
      const content = fs.readFileSync(full, 'utf-8');
      // Skip binary (NUL byte)
      if (content.includes('\0')) continue;

      attachments.push({
        path: rel,
        lines: content.split('\n').length,
        bytes: stat.size,
        content
      });
    } catch (e) {
      attachments.push({ path: rel, error: e.message });
    }
  }

  const readable = attachments.filter(a => a.content);
  if (readable.length === 0) return { prompt, attachments };

  // Build appendix
  const appendix = readable
    .map(a => `--- ${a.path} (${a.lines} lines) ---\n${a.content}\n--- end ${a.path} ---`)
    .join('\n\n');

  const newPrompt = `${prompt}\n\n[@mention attachments — ${readable.length} file(s)]\n${appendix}`;

  return { prompt: newPrompt, attachments };
}

module.exports = { expandMentions };
