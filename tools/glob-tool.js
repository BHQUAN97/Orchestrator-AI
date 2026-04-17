#!/usr/bin/env node
/**
 * Glob Tool — Tim file theo pattern nhanh
 *
 * Khac list_files: glob chi tra ve FILES (khong folder), sap xep theo mtime desc,
 * khong gioi han max_depth (di sau unlimited), toi uu cho case "tim moi file matching pattern".
 */

const fg = require('fast-glob');
const fs = require('fs');
const path = require('path');

const IGNORE_PATTERNS = [
  '**/node_modules/**', '**/.git/**', '**/__pycache__/**',
  '**/dist/**', '**/build/**', '**/.next/**', '**/.nuxt/**',
  '**/coverage/**', '**/.turbo/**', '**/vendor/**', '**/.venv/**',
  '**/.cache/**', '**/target/**'
];

/**
 * @param {{ pattern: string, path?: string, max_results?: number }} args
 * @param {string} projectDir
 */
async function glob(args = {}, projectDir) {
  const { pattern, path: cwd = '.', max_results = 100 } = args;

  if (!pattern) return { success: false, error: 'Missing pattern' };

  const resolved = path.isAbsolute(cwd) ? path.normalize(cwd) : path.resolve(projectDir, cwd);
  const projNorm = path.normalize(projectDir);

  // Sandbox: chi cho glob trong project dir
  if (!resolved.startsWith(projNorm + path.sep) && resolved !== projNorm) {
    return { success: false, error: `BLOCKED: Path outside project dir: ${resolved}` };
  }

  if (!fs.existsSync(resolved)) {
    return { success: false, error: `Directory not found: ${cwd}` };
  }

  try {
    const entries = await fg(pattern, {
      cwd: resolved,
      ignore: IGNORE_PATTERNS,
      onlyFiles: true,
      dot: false,
      stats: true,
      absolute: false,
      // fast-glob deep default la Infinity — unlimited
    });

    // Sort by mtime desc (file moi nhat len dau — phu hop coding usecase)
    entries.sort((a, b) => {
      const am = a.stats?.mtimeMs || 0;
      const bm = b.stats?.mtimeMs || 0;
      return bm - am;
    });

    const limited = entries.slice(0, max_results);

    return {
      success: true,
      pattern,
      cwd: path.relative(projectDir, resolved) || '.',
      files: limited.map(e => (typeof e === 'string' ? e : e.path)),
      total: entries.length,
      truncated: entries.length > max_results
    };
  } catch (e) {
    return { success: false, error: `Glob failed: ${e.message}` };
  }
}

module.exports = { glob };
