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

// Persistent readline — tránh toggle raw mode liên tục gây stdin bị lệch trong WebSocket terminals
let _persistentRl = null;
let _currentCompleter = null;

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
 * Prompt user voi tab completion.
 * Dung persistent readline interface de tranh toggle raw mode — fix loi Enter nhieu lan.
 * @returns {Promise<string>} User input
 */
function promptInput({ projectDir, customCommandNames, builtinCommandNames, prompt = '❯ ' }) {
  // Cap nhat completer moi lan goi (command list co the thay doi)
  _currentCompleter = buildCompleter({ projectDir, customCommandNames, builtinCommandNames });

  if (!_persistentRl) {
    _persistentRl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      // Proxy completer de cap nhat duoc sau khi tao
      completer: (line) => _currentCompleter ? _currentCompleter(line) : [[], line],
      terminal: true,
      historySize: 100
    });
    _persistentRl.on('close', () => { _persistentRl = null; });
  }

  return new Promise((resolve, reject) => {
    // SIGINT per-call: reject promise hien tai
    const onSIGINT = () => reject(new Error('SIGINT'));
    _persistentRl.once('SIGINT', onSIGINT);

    _persistentRl.question(prompt, (answer) => {
      _persistentRl.removeListener('SIGINT', onSIGINT);
      resolve(answer.trim());
    });
  });
}

/** Dong persistent readline (goi khi thoat app) */
function closeInput() {
  if (_persistentRl) {
    _persistentRl.close();
    _persistentRl = null;
  }
}

module.exports = { promptInput, buildCompleter, closeInput };
