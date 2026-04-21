#!/usr/bin/env node
/**
 * Markdown Render — render markdown trong terminal voi color
 *
 * Minimal impl (no deps):
 * - **bold** → chalk.bold
 * - *italic* → chalk.italic
 * - `inline code` → chalk.cyan
 * - ```code blocks``` → indent + chalk.gray
 * - # headings → chalk.bold.underline
 * - - lists → preserve
 * - [text](url) → text in blue + url gray
 *
 * Fallback khi chalk khong co → return plain text
 */

if (!process.env.FORCE_COLOR) process.env.FORCE_COLOR = '1';
const chalk = require('chalk');

/**
 * Render markdown text voi color codes
 * @param {string} md
 * @returns {string}
 */
function renderMarkdown(md) {
  if (!md || typeof md !== 'string') return md || '';

  let out = md;

  // Code blocks ```lang\n...\n``` — tach de khong bi xu ly boi inline rules
  const codeBlocks = [];
  out = out.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    const trimmed = code.replace(/\n$/, '');
    const indented = trimmed.split('\n').map(l => '  ' + chalk.gray(l)).join('\n');
    const header = lang ? chalk.gray.dim(`  ┌─ ${lang}`) + '\n' : chalk.gray.dim('  ┌─\n');
    codeBlocks.push(header + indented + '\n' + chalk.gray.dim('  └─'));
    return `\0CODEBLOCK${idx}\0`;
  });

  // Inline code — placeholder to prevent double-replace
  const inlineCodes = [];
  out = out.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(chalk.cyan(code));
    return `\0INLINE${idx}\0`;
  });

  // Headings — order matters: longest prefix first
  out = out.replace(/^####\s+(.+)$/gm, (_, t) => chalk.bold.white(t));
  out = out.replace(/^###\s+(.+)$/gm, (_, t) => chalk.bold.yellow(t));
  out = out.replace(/^##\s+(.+)$/gm, (_, t) => chalk.bold.cyan(t));
  out = out.replace(/^#\s+(.+)$/gm, (_, t) => chalk.bold.underline.magenta(t));

  // Bold **text**
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_, t) => chalk.bold(t));
  // Italic *text* (no double)
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, pre, t) => pre + chalk.italic(t));

  // Links [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => chalk.blue.underline(text) + chalk.gray(` (${url})`));

  // Bullet lists — add indent
  out = out.replace(/^(\s*)[-*]\s+(.+)$/gm, (_, indent, item) => `${indent}${chalk.yellow('•')} ${item}`);

  // Numbered lists
  out = out.replace(/^(\s*)(\d+)\.\s+(.+)$/gm, (_, indent, n, item) => `${indent}${chalk.yellow(n + '.')} ${item}`);

  // Block quotes
  out = out.replace(/^>\s+(.+)$/gm, (_, text) => chalk.gray('│ ') + chalk.italic(text));

  // Restore inline codes
  out = out.replace(/\0INLINE(\d+)\0/g, (_, idx) => inlineCodes[parseInt(idx, 10)]);
  // Restore code blocks
  out = out.replace(/\0CODEBLOCK(\d+)\0/g, (_, idx) => codeBlocks[parseInt(idx, 10)]);

  return out;
}

module.exports = { renderMarkdown };
