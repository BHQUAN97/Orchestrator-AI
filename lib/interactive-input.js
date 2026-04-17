#!/usr/bin/env node
/**
 * Interactive Input — readline-based input voi tab completion
 *
 * Thay the inquirer.prompt cho main input loop.
 * Inquirer khong ho tro tab completion cho 'input' type.
 *
 * Completion:
 * - Dong bat dau bang `/` → complete command names
 * - Token bat dau bang `@` → complete file paths tu projectDir
 *
 * History: in-memory 100 entries (up/down arrow). Khong persist (tranh leak prompt).
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');

// Ignore khi complete files
const IGNORE_ENTRIES = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.next', 'coverage']);

/**
 * Build completer function cho readline
 */
function buildCompleter({ projectDir, customCommandNames = [], builtinCommandNames = [] }) {
  const allCommands = [...new Set([...customCommandNames, ...builtinCommandNames])].sort();

  return (line) => {
    // /command completion (line starts with /)
    if (line.startsWith('/')) {
      const partial = line.slice(1).split(/\s/)[0]; // first token after /
      const matches = allCommands
        .filter(c => c.startsWith(partial))
        .map(c => '/' + c);
      return [matches, '/' + partial];
    }

    // @file completion — find LAST @ in line
    const atIdx = line.lastIndexOf('@');
    if (atIdx !== -1 && (atIdx === 0 || /\s/.test(line[atIdx - 1]))) {
      const partial = line.slice(atIdx + 1);
      // Don't complete if contains spaces (already done)
      if (/\s/.test(partial)) return [[], line];

      try {
        const dir = partial.includes('/') ? path.dirname(partial) : '.';
        const prefix = partial.includes('/') ? path.basename(partial) : partial;
        const absDir = path.isAbsolute(dir) ? dir : path.resolve(projectDir, dir);

        if (!fs.existsSync(absDir)) return [[], line];

        const entries = fs.readdirSync(absDir)
          .filter(e => !IGNORE_ENTRIES.has(e) && !e.startsWith('.') && e.startsWith(prefix));

        const completions = entries.slice(0, 50).map(e => {
          const relPath = dir === '.' ? e : `${dir}/${e}`;
          try {
            const stat = fs.statSync(path.join(absDir, e));
            return '@' + (stat.isDirectory() ? relPath + '/' : relPath);
          } catch {
            return '@' + relPath;
          }
        });

        return [completions, '@' + partial];
      } catch {
        return [[], line];
      }
    }

    return [[], line];
  };
}

/**
 * Prompt user voi tab completion
 * @returns {Promise<string>} User input
 */
function promptInput({ projectDir, customCommandNames, builtinCommandNames, prompt = '❯ ' }) {
  return new Promise((resolve, reject) => {
    const completer = buildCompleter({ projectDir, customCommandNames, builtinCommandNames });

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer,
      terminal: true,
      historySize: 100
    });

    // Ctrl+C handler
    rl.on('SIGINT', () => {
      rl.close();
      reject(new Error('SIGINT'));
    });

    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

module.exports = { promptInput, buildCompleter };
