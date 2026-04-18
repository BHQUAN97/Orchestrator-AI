#!/usr/bin/env node
/**
 * Privacy Rules — force local model khi file matches pattern nhay cam
 *
 * Business logic (VI):
 *   Co nhung file khong bao gio duoc gui len cloud: .env, credentials,
 *   private keys, secrets folder. Router phai detect va force local-heavy
 *   truoc khi goi bat ky cloud API nao.
 *
 * Custom rules loaded from .orcai/privacy.json (optional):
 *   { "rules": ["**\/my-secret/**", "config/prod.json"] }
 */

const fs = require('fs');
const path = require('path');

// Default patterns — cover OWASP-common sensitive paths
const DEFAULT_RULES = [
  '**/.env*',
  '**/secrets/**',
  '**/credentials*',
  '**/*.key',
  '**/*.pem',
  '**/auth/**'
];

let _cachedRules = null;
let _cachedMtime = 0;

/**
 * Convert glob pattern → regex.
 * Supports: ** (any path segments), * (any chars except /), ? (1 char)
 */
function globToRegex(glob) {
  // Dung placeholders de tranh xung dot giua cac lan replace.
  // Token hoa truoc → escape → de-token → ra regex cuoi.
  const tokens = {
    '__GLOBSTAR_SLASH__': '(?:.*/)?',
    '__SLASH_GLOBSTAR__': '(?:/.*)?',
    '__GLOBSTAR__': '.*',
    '__STAR__': '[^/]*',
    '__QMARK__': '[^/]'
  };
  let s = glob
    .replace(/\*\*\//g, '__GLOBSTAR_SLASH__')
    .replace(/\/\*\*/g, '__SLASH_GLOBSTAR__')
    .replace(/\*\*/g, '__GLOBSTAR__')
    .replace(/\*/g, '__STAR__')
    .replace(/\?/g, '__QMARK__');
  // Escape regex meta chars (sau khi tokenize, cac wildcard da tro thanh placeholder)
  s = s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // De-tokenize
  for (const [k, v] of Object.entries(tokens)) {
    s = s.split(k).join(v);
  }
  return new RegExp('^' + s + '$', 'i');
}

/**
 * Load rules from .orcai/privacy.json if exists, else return defaults.
 * Cached for perf, invalidated on file mtime change.
 */
function loadRules(projectDir = process.cwd()) {
  const rulesFile = path.join(projectDir, '.orcai', 'privacy.json');
  try {
    const stat = fs.statSync(rulesFile);
    if (_cachedRules && _cachedMtime === stat.mtimeMs) return _cachedRules;
    const raw = fs.readFileSync(rulesFile, 'utf8');
    const parsed = JSON.parse(raw);
    const userRules = Array.isArray(parsed.rules) ? parsed.rules : [];
    // Them default roi merge user rules (user khong the disable default)
    _cachedRules = [...DEFAULT_RULES, ...userRules];
    _cachedMtime = stat.mtimeMs;
    return _cachedRules;
  } catch {
    return DEFAULT_RULES;
  }
}

/**
 * Check if a single file path matches any privacy rule.
 * @param {string} filePath - absolute or relative path
 * @param {string[]} [rules] - optional custom rules (else loads defaults)
 * @returns {boolean}
 */
function isPrivatePath(filePath, rules) {
  if (!filePath) return false;
  const norm = String(filePath).replace(/\\/g, '/').toLowerCase();
  const active = rules && rules.length > 0 ? rules : DEFAULT_RULES;
  for (const rule of active) {
    const re = globToRegex(String(rule).toLowerCase());
    if (re.test(norm)) return true;
    // Also match against basename for patterns without path separators
    const base = norm.split('/').pop();
    if (!rule.includes('/') && re.test(base)) return true;
  }
  return false;
}

/**
 * Return true if ANY path in list matches privacy rules → force local.
 * @param {string[]} filePaths
 * @param {{ projectDir?: string, rules?: string[] }} [opts]
 * @returns {boolean}
 */
function forceLocalForPaths(filePaths, opts = {}) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return false;
  const rules = opts.rules || loadRules(opts.projectDir);
  for (const p of filePaths) {
    if (isPrivatePath(p, rules)) return true;
  }
  return false;
}

/**
 * Return the first matching path + rule (for reason reporting).
 */
function findPrivateMatch(filePaths, opts = {}) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return null;
  const rules = opts.rules || loadRules(opts.projectDir);
  for (const p of filePaths) {
    for (const rule of rules) {
      const norm = String(p).replace(/\\/g, '/').toLowerCase();
      const re = globToRegex(String(rule).toLowerCase());
      if (re.test(norm)) return { file: p, rule };
    }
  }
  return null;
}

module.exports = {
  DEFAULT_RULES,
  loadRules,
  isPrivatePath,
  forceLocalForPaths,
  findPrivateMatch,
  _globToRegex: globToRegex
};
