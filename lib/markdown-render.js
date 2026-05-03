#!/usr/bin/env node
/**
 * Markdown Render — render markdown trong terminal voi color
 */

if (!process.env.FORCE_COLOR) process.env.FORCE_COLOR = '1';
const chalk = require('chalk');

/** Xóa ANSI escape codes để đo độ dài thực */
const visLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;

/** Áp dụng inline formatting đơn giản (bold, code) bên trong cell */
function fmtCell(s) {
  if (!s) return '';
  return s
    .replace(/\*\*([^*]+)\*\*/g, (_, t) => chalk.bold(t))
    .replace(/`([^`]+)`/g, (_, t) => chalk.cyan(t));
}

/** Độ dài visible của chuỗi trước khi format */
function plainLen(s) {
  return s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').length;
}

/** Cắt ngắn + format, giữ ANSI */
function truncateCell(s, max) {
  const plain = s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
  if (plain.length <= max) return fmtCell(s);
  return fmtCell(plain.slice(0, max - 1)) + chalk.gray('…');
}

/** Pad cell đến đúng width, giữ alignment */
function padCell(s, width, align) {
  const formatted = truncateCell(s, width);
  const pad = Math.max(0, width - visLen(formatted));
  if (align === 'right') return ' '.repeat(pad) + formatted;
  if (align === 'center') {
    const l = Math.floor(pad / 2);
    return ' '.repeat(l) + formatted + ' '.repeat(pad - l);
  }
  return formatted + ' '.repeat(pad);
}

/**
 * Render một markdown table block thành terminal output đẹp.
 * Input: raw markdown table text (multi-line string).
 */
function renderTable(tableText) {
  const rawLines = tableText.trim().split('\n').filter(l => l.trim());
  if (rawLines.length < 3) return tableText;

  const parseRow = (line) =>
    line.split('|').slice(1, -1).map(c => c.trim());

  // Validate: dòng thứ 2 phải là separator (|:---|:---|)
  if (!/^\|[\s:|-]+\|$/.test(rawLines[1])) return tableText;

  const header   = parseRow(rawLines[0]);
  const sepCells = parseRow(rawLines[1]);
  const data     = rawLines.slice(2).map(parseRow);
  const numCols  = header.length;

  // Parse alignment từ separator cells
  const aligns = sepCells.map(s => {
    if (s.startsWith(':') && s.endsWith(':')) return 'center';
    if (s.endsWith(':')) return 'right';
    return 'left';
  });

  // Terminal width — chia đều cột, tối đa 40 chars/cột
  const termW = Math.max(80, process.stdout.columns || 120);
  const available = termW - 4 - (numCols - 1) * 2; // 4=indent, 2=gap per column
  const maxColW = Math.min(40, Math.max(8, Math.floor(available / numCols)));

  // Tính column width = max(header, data) capped tại maxColW
  const colWidths = Array.from({ length: numCols }, (_, i) => {
    const vals = [header[i] || '', ...data.map(r => r[i] || '')];
    const max = Math.max(...vals.map(v => plainLen(v)));
    return Math.min(max, maxColW);
  });

  const indent  = '  ';
  const colSep  = '  ';

  const renderRow = (cells, bold = false) => {
    const parts = cells.map((cell, i) =>
      padCell(cell || '', colWidths[i] || 4, aligns[i] || 'left')
    );
    const line = indent + parts.join(colSep);
    return bold ? chalk.bold(line) : line;
  };

  const separator = indent + chalk.gray(colWidths.map(w => '─'.repeat(w)).join(colSep));

  return [
    renderRow(header, true),
    separator,
    ...data.map(row => renderRow(row, false)),
  ].join('\n');
}

/**
 * Quét text theo từng dòng, gom các block table liên tiếp rồi render.
 * Trả về text đã thay thế table blocks bằng rendered output.
 */
function processTables(text) {
  const lines = text.split('\n');
  const result = [];
  let tableLines = [];

  const flushTable = () => {
    if (tableLines.length >= 3) {
      result.push(renderTable(tableLines.join('\n')));
    } else {
      result.push(...tableLines);
    }
    tableLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trimEnd();
    // Dòng table: bắt đầu và kết thúc bằng |
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      tableLines.push(line);
    } else {
      flushTable();
      result.push(line);
    }
  }
  flushTable();

  return result.join('\n');
}

/**
 * Render markdown text voi color codes.
 * @param {string} md
 * @returns {string}
 */
function renderMarkdown(md) {
  if (!md || typeof md !== 'string') return md || '';

  let out = md;

  // 1. Code blocks ```lang\n...\n``` — tách trước tất cả
  const codeBlocks = [];
  out = out.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    const trimmed = code.replace(/\n$/, '');
    const lines = trimmed.split('\n');
    let displayCode = trimmed;
    let suffix = '';

    if (lines.length > 40) {
      displayCode = lines.slice(0, 20).join('\n') +
                    '\n' + chalk.yellow(`  ... [${lines.length - 30} lines truncated] ...`) + '\n' +
                    lines.slice(-10).join('\n');
      suffix = chalk.gray.dim(`  (Full content hidden, use /read to see all)`);
    }

    const indented = displayCode.split('\n').map(l => '  ' + chalk.gray(l)).join('\n');
    const header = lang ? chalk.gray.dim(`  ┌─ ${lang}`) + '\n' : chalk.gray.dim('  ┌─\n');
    codeBlocks.push(header + indented + '\n' + chalk.gray.dim('  └─') + (suffix ? '\n' + suffix : ''));
    return `\0CODEBLOCK${idx}\0`;
  });

  // 2. Tables — xử lý trước inline code để cell content còn nguyên
  out = processTables(out);

  // 3. Inline code — placeholder để tránh double-replace
  const inlineCodes = [];
  out = out.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(chalk.cyan(code));
    return `\0INLINE${idx}\0`;
  });

  // 4. Headings
  out = out.replace(/^####\s+(.+)$/gm, (_, t) => chalk.bold.white(t));
  out = out.replace(/^###\s+(.+)$/gm,  (_, t) => chalk.bold.yellow(t));
  out = out.replace(/^##\s+(.+)$/gm,   (_, t) => chalk.bold.cyan(t));
  out = out.replace(/^#\s+(.+)$/gm,    (_, t) => chalk.bold.underline.magenta(t));

  // 5. Bold / Italic
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_, t) => chalk.bold(t));
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, pre, t) => pre + chalk.italic(t));

  // 6. Links
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
    (_, text, url) => chalk.blue.underline(text) + chalk.gray(` (${url})`));

  // 7. Lists
  out = out.replace(/^(\s*)[-*]\s+(.+)$/gm, (_, indent, item) => `${indent}${chalk.yellow('•')} ${item}`);
  out = out.replace(/^(\s*)(\d+)\.\s+(.+)$/gm, (_, indent, n, item) => `${indent}${chalk.yellow(n + '.')} ${item}`);

  // 8. Block quotes
  out = out.replace(/^>\s+(.+)$/gm, (_, text) => chalk.gray('│ ') + chalk.italic(text));

  // 9. Image tags
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, p) =>
    chalk.yellow(`📷 [${alt || 'image'}: ${p}]`));

  // Restore
  out = out.replace(/\0INLINE(\d+)\0/g,    (_, i) => inlineCodes[parseInt(i, 10)]);
  out = out.replace(/\0CODEBLOCK(\d+)\0/g, (_, i) => codeBlocks[parseInt(i, 10)]);

  return out;
}

module.exports = { renderMarkdown };
