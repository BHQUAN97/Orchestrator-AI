#!/usr/bin/env node
/**
 * CLAUDE.md Hierarchy Loader
 *
 * Duyet tu projectDir len filesystem root, load tat ca CLAUDE.md.
 * Cong them ~/.claude/CLAUDE.md (global private rules).
 *
 * Giong Claude Code: build context theo layered hierarchy —
 *   global (user private) → monorepo root → subproject.
 *
 * Merge order: global → root → intermediate parents → project (cang gan cang sau cuoi).
 * Ly do: cac rule cang cu the (gan project) should take precedence.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_LAYER_BYTES = 50 * 1024; // 50KB/layer — tranh prompt qua dai

/**
 * Load CLAUDE.md tu hierarchy
 * @param {string} projectDir
 * @returns {{ content: string, sources: Array<{source, path, bytes}> }}
 */
function loadClaudeMdHierarchy(projectDir) {
  const layers = [];

  // 1. Global user rules (~/.claude/CLAUDE.md)
  const globalMd = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  _tryLoad(globalMd, 'global', layers);

  // 2. Walk from filesystem root DOWN to projectDir
  const absProject = path.resolve(projectDir);
  const parts = absProject.split(path.sep).filter(Boolean);
  const root = path.parse(absProject).root;

  // Build chain of parent dirs (from root to project)
  const chain = [];
  let acc = root;
  for (const p of parts) {
    acc = path.join(acc, p);
    chain.push(acc);
  }

  // Load each dir's CLAUDE.md (skip global dup)
  for (const dir of chain) {
    const md = path.join(dir, 'CLAUDE.md');
    if (md === globalMd) continue;
    const source = dir === absProject ? 'project' : 'parent';
    _tryLoad(md, source, layers);
  }

  if (layers.length === 0) return { content: '', sources: [] };

  // Merge with attribution markers
  const merged = layers.map(l =>
    `<!-- CLAUDE.md (${l.source}: ${l.path}) -->\n${l.content}\n<!-- end ${l.path} -->`
  ).join('\n\n');

  return {
    content: merged,
    sources: layers.map(l => ({ source: l.source, path: l.path, bytes: l.content.length }))
  };
}

function _tryLoad(filePath, source, layers) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return;
    let content = fs.readFileSync(filePath, 'utf-8');
    if (content.length > MAX_LAYER_BYTES) {
      content = content.slice(0, MAX_LAYER_BYTES) + '\n[truncated]';
    }
    if (content.trim()) {
      layers.push({ source, path: filePath, content });
    }
  } catch { /* ignore unreadable */ }
}

module.exports = { loadClaudeMdHierarchy };
