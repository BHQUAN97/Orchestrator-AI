#!/usr/bin/env node
/**
 * Slash Commands — Framework kham pha va goi /command
 *
 * Load tu:
 *   1. {projectDir}/skills/*.md
 *   2. {projectDir}/.claude/commands/*.md
 *   3. ~/.claude/commands/*.md
 *
 * Format 1 — YAML frontmatter (Claude Code style):
 *   ---
 *   description: Review pull request
 *   argument-hint: <pr-number>
 *   ---
 *   Review the PR #$ARGUMENTS focusing on security, logic, tests.
 *
 * Format 2 — Orcai legacy style (## sections):
 *   # Skill: Developer
 *   ## Trigger
 *   ...
 *   ## System Prompt
 *   ...
 *   ## Model
 *   default
 *
 * Format duoc auto-detect. $ARGUMENTS se duoc replace boi argument text.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Parse YAML frontmatter (minimal, khong can thu vien ngoai)
 */
function parseFrontmatter(content) {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { meta: {}, body: content };
  }
  const offset = content.startsWith('---\r\n') ? 5 : 4;
  // Tim marker ket thuc --- tren dong rieng
  const rest = content.slice(offset);
  const endMatch = rest.match(/^---\s*$/m);
  if (!endMatch) return { meta: {}, body: content };

  const endIdx = endMatch.index;
  const fmRaw = rest.slice(0, endIdx);
  // Body bat dau sau --- va newline
  const afterEnd = rest.slice(endIdx + endMatch[0].length);
  const body = afterEnd.replace(/^\r?\n/, '');

  const meta = {};
  for (const line of fmRaw.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_-]+)\s*:\s*(.*)$/);
    if (m) {
      let v = m[2].trim();
      // Strip quotes
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      meta[m[1]] = v;
    }
  }
  return { meta, body };
}

/**
 * Parse orcai legacy markdown (## Trigger / ## System Prompt / ## Model / ## Tools)
 */
function parseLegacyMarkdown(content) {
  const lines = content.split(/\r?\n/);
  // Title: first # heading
  const titleMatch = content.match(/^#\s+(?:Skill:\s*)?(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // Sections
  const sections = {};
  let current = null;
  let buffer = [];
  for (const line of lines) {
    const h = line.match(/^##\s+(.+)/);
    if (h) {
      if (current) sections[current.toLowerCase()] = buffer.join('\n').trim();
      current = h[1].trim();
      buffer = [];
    } else if (current) {
      buffer.push(line);
    }
  }
  if (current) sections[current.toLowerCase()] = buffer.join('\n').trim();

  return {
    meta: {
      description: title || sections['trigger']?.split('\n')[0] || '',
      model: sections['model'] || '',
      tools: sections['tools'] || ''
    },
    body: sections['system prompt'] || sections['prompt'] || content
  };
}

/**
 * Parse 1 command file — auto detect format
 */
function parseCommandFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const name = path.basename(filePath, '.md');

  let meta, body;
  if (raw.startsWith('---\n') || raw.startsWith('---\r\n')) {
    ({ meta, body } = parseFrontmatter(raw));
  } else {
    ({ meta, body } = parseLegacyMarkdown(raw));
  }

  return {
    name,
    description: meta.description || meta.desc || `Skill: ${name}`,
    argumentHint: meta['argument-hint'] || meta.argumentHint || '',
    model: meta.model || '',
    body: body.trim(),
    source: filePath
  };
}

/**
 * Tim tat ca slash commands available
 */
function discoverCommands(projectDir) {
  const commands = new Map(); // name → CommandInfo (later overrides earlier)
  const dirs = [
    path.join(os.homedir(), '.claude', 'commands'),
    projectDir ? path.join(projectDir, '.claude', 'commands') : null,
    projectDir ? path.join(projectDir, 'skills') : null
  ].filter(Boolean);

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir);
      for (const f of entries) {
        if (!f.endsWith('.md')) continue;
        const name = path.basename(f, '.md');
        // Skip hidden & special files
        if (name.startsWith('.') || name.startsWith('_') || name === 'README') continue;
        try {
          const cmd = parseCommandFile(path.join(dir, f));
          commands.set(cmd.name, cmd);
        } catch {
          // ignore bad file
        }
      }
    } catch { /* ignore dir errors */ }
  }
  return commands;
}

/**
 * Expand 1 command → user prompt text (substitute $ARGUMENTS)
 */
function expandCommand(cmd, argumentsText = '') {
  if (!cmd) return null;
  let body = cmd.body;
  if (body.includes('$ARGUMENTS')) {
    body = body.split('$ARGUMENTS').join(argumentsText);
  } else if (argumentsText) {
    body = body + '\n\n---\nUser input: ' + argumentsText;
  }
  return body.trim();
}

/**
 * Format command list cho /help
 */
function formatCommandList(commands) {
  if (commands.size === 0) return '  (no commands found)';
  const lines = [];
  const sorted = [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const cmd of sorted) {
    const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : '';
    const desc = cmd.description.split('\n')[0].slice(0, 70);
    lines.push(`  /${cmd.name}${hint} — ${desc}`);
  }
  return lines.join('\n');
}

module.exports = {
  discoverCommands,
  expandCommand,
  parseFrontmatter,
  parseLegacyMarkdown,
  parseCommandFile,
  formatCommandList
};
