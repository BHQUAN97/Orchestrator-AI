#!/usr/bin/env node
/**
 * MCP Auto-Config — tu dong ke thua cau hinh MCP tu Claude Code cua user
 *
 * Uu tien (cao → thap):
 *   1. Project .orcai/mcp.json         ← override cao nhat
 *   2. Project .mcp.json               ← chuan cong dong
 *   3. Global ~/.claude/mcp.json       ← ban ly orcai
 *   4. Claude Code ~/.claude/settings.json (mcpServers)
 *   5. Claude Code ~/.claude.json      (noi Claude Code luu mcpServers toan cuc)
 *
 * Ket qua merge: source cao hon ghi de source thap hon theo ten server.
 * Server bi disabled (`disabled: true`) van giu lai trong ket qua de UI hien thi,
 * nhung registry.init() se tu loc.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Doc + parse JSON an toan — khong throw, tra ve {} neu loi.
 */
function readJsonSafe(filePath) {
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw || !raw.trim()) return {};
    return JSON.parse(raw);
  } catch (e) {
    return { __error: e.message, __path: filePath };
  }
}

/**
 * Lay mcpServers tu 1 object JSON, chap nhan cac ten field khac nhau.
 */
function extractServers(obj) {
  if (!obj || typeof obj !== 'object' || obj.__error) return {};
  return obj.mcpServers || obj.mcp_servers || {};
}

/**
 * Lay danh sach file config theo thu tu uu tien (thap → cao).
 * Source cao hon o cuoi mang se override source thap hon khi merge.
 */
function resolveConfigSources(projectDir) {
  const home = os.homedir();
  const sources = [
    { name: 'claude-user-json',    path: path.join(home, '.claude.json'),              tag: 'claude' },
    { name: 'claude-user-settings', path: path.join(home, '.claude', 'settings.json'), tag: 'claude' },
    { name: 'orcai-global',        path: path.join(home, '.claude', 'mcp.json'),       tag: 'orcai-global' }
  ];
  if (projectDir) {
    sources.push({ name: 'project-mcp',   path: path.join(projectDir, '.mcp.json'),          tag: 'project' });
    sources.push({ name: 'project-orcai', path: path.join(projectDir, '.orcai', 'mcp.json'), tag: 'project-orcai' });
  }
  return sources;
}

/**
 * Load + merge toan bo config MCP. Tra ve { mcpServers, _sources, _errors }.
 */
function loadInheritedMCPConfig(projectDir) {
  const sources = resolveConfigSources(projectDir);
  const merged = {};
  const usedSources = [];
  const errors = [];

  for (const src of sources) {
    const data = readJsonSafe(src.path);
    if (!data) continue;
    if (data.__error) {
      errors.push({ source: src.name, path: src.path, error: data.__error });
      continue;
    }

    const servers = extractServers(data);
    if (!servers || typeof servers !== 'object') continue;

    let addedCount = 0;
    for (const [name, cfg] of Object.entries(servers)) {
      if (!cfg || typeof cfg !== 'object') continue;
      // Ghi de: source sau override source truoc
      merged[name] = { ...cfg, __source: src.name };
      addedCount++;
    }
    if (addedCount > 0) usedSources.push({ name: src.name, path: src.path, servers: addedCount });
  }

  // Strip internal markers truoc khi tra ve mcpServers chuan
  const mcpServers = {};
  for (const [name, cfg] of Object.entries(merged)) {
    const { __source, ...rest } = cfg;
    mcpServers[name] = rest;
  }

  return {
    mcpServers,
    _sources: usedSources,
    _errors: errors,
    _sourceByServer: Object.fromEntries(
      Object.entries(merged).map(([n, c]) => [n, c.__source])
    )
  };
}

/**
 * Liet ke server kha dung + nguon + trang thai — phuc vu slash command `/mcp list`.
 */
function listAvailableServers(projectDir) {
  const { mcpServers, _sourceByServer, _errors } = loadInheritedMCPConfig(projectDir);
  const out = [];
  for (const [name, cfg] of Object.entries(mcpServers)) {
    const transport = cfg.url || cfg.type === 'sse' || cfg.type === 'http' ? 'sse' : 'stdio';
    out.push({
      name,
      source: _sourceByServer[name] || 'unknown',
      transport,
      command: cfg.command || null,
      args: cfg.args || null,
      url: cfg.url || null,
      disabled: !!cfg.disabled,
      hasEnv: !!cfg.env && Object.keys(cfg.env).length > 0
    });
  }
  return { servers: out, errors: _errors };
}

module.exports = {
  loadInheritedMCPConfig,
  listAvailableServers,
  // exported for testing / reuse
  readJsonSafe,
  extractServers,
  resolveConfigSources
};
