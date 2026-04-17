#!/usr/bin/env node
/**
 * MCP Slash Commands — pure helpers, khong cham CLI hay executor truc tiep.
 *
 * Moi function tra ve { ok: boolean, output: string, data?: any }
 * CLI layer se goi va print `output`.
 *
 * Cac command duoc bridge sau boi bin/orcai.js:
 *   /mcp list                    → mcpList(registry)
 *   /mcp tools <server>          → mcpTools(registry, server)
 *   /mcp enable <server>         → mcpEnable(projectDir, server)
 *   /mcp disable <server>        → mcpDisable(projectDir, server)
 *   /mcp add <json>              → mcpAdd(projectDir, spec)
 *   /mcp call <prefixed> <json>  → mcpCall(registry, prefixed, argsJson)
 */

const fs = require('fs');
const path = require('path');
const { listAvailableServers, loadInheritedMCPConfig } = require('../lib/mcp-auto-config');

// ---------- config writer ----------

function ensureOrcaiDir(projectDir) {
  const dir = path.join(projectDir, '.orcai');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readOrcaiMCP(projectDir) {
  const file = path.join(projectDir, '.orcai', 'mcp.json');
  if (!fs.existsSync(file)) return { mcpServers: {} };
  try {
    const raw = fs.readFileSync(file, 'utf-8') || '{}';
    const j = JSON.parse(raw);
    if (!j.mcpServers) j.mcpServers = {};
    return j;
  } catch (e) {
    return { mcpServers: {}, __error: e.message };
  }
}

function writeOrcaiMCP(projectDir, data) {
  ensureOrcaiDir(projectDir);
  const file = path.join(projectDir, '.orcai', 'mcp.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  return file;
}

// ---------- formatting helpers ----------

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

function formatServerRow(s, running) {
  const status = s.disabled ? 'disabled' : (running?.ok ? 'ok' : (running ? 'failed' : 'not-started'));
  const toolCount = running?.tools != null ? running.tools : '-';
  const transport = s.transport || (s.url ? 'sse' : 'stdio');
  return `  ${pad(s.name, 24)} ${pad(transport, 7)} ${pad(status, 11)} tools:${toolCount}  [${s.source}]`;
}

// ---------- commands ----------

/**
 * /mcp list — liet ke tat ca server tu moi source, kem trang thai runtime.
 */
async function mcpList(registry) {
  const projectDir = process.cwd();
  const { servers, errors } = listAvailableServers(projectDir);

  // Trang thai runtime tu registry (neu da init)
  const runningByName = {};
  if (registry && registry.clients) {
    for (const [name, client] of registry.clients) {
      runningByName[name] = { ok: !!client.initialized, tools: (client.tools || []).length };
    }
    if (registry.errors) {
      for (const e of registry.errors) {
        if (e.server && !runningByName[e.server]) runningByName[e.server] = { ok: false, tools: 0 };
      }
    }
  }

  if (servers.length === 0) {
    return { ok: true, output: 'No MCP servers configured.\nThem server voi: /mcp add <json> hoac sua .orcai/mcp.json' };
  }

  const lines = [];
  lines.push(`MCP Servers (${servers.length}):`);
  lines.push(`  ${pad('NAME', 24)} ${pad('TRANSP', 7)} ${pad('STATUS', 11)} TOOLS  [SOURCE]`);
  for (const s of servers) {
    lines.push(formatServerRow(s, runningByName[s.name]));
  }
  if (errors && errors.length > 0) {
    lines.push('');
    lines.push('Config errors:');
    for (const e of errors) lines.push(`  - ${e.source}: ${e.error}`);
  }

  return { ok: true, output: lines.join('\n'), data: { servers, running: runningByName } };
}

/**
 * /mcp tools <server> — liet ke tool cua 1 server dang chay.
 */
async function mcpTools(registry, serverName) {
  if (!registry || !registry.clients) return { ok: false, output: 'Registry not initialized' };
  if (!serverName) return { ok: false, output: 'Usage: /mcp tools <server>' };

  const client = registry.clients.get(serverName);
  if (!client) return { ok: false, output: `Server not running: ${serverName}. Try /mcp list` };

  const tools = client.tools || [];
  if (tools.length === 0) return { ok: true, output: `${serverName}: no tools exposed` };

  const lines = [`${serverName} (${tools.length} tools):`];
  for (const t of tools) {
    const desc = (t.description || '').replace(/\s+/g, ' ').slice(0, 80);
    lines.push(`  mcp__${serverName}__${t.name} — ${desc}`);
  }
  return { ok: true, output: lines.join('\n'), data: { tools } };
}

/**
 * /mcp enable <server> — set disabled=false trong .orcai/mcp.json.
 * Neu server chua ton tai trong .orcai/mcp.json, copy tu inherited config.
 */
async function mcpEnable(projectDir, serverName) {
  if (!serverName) return { ok: false, output: 'Usage: /mcp enable <server>' };

  const data = readOrcaiMCP(projectDir);
  if (data.__error) return { ok: false, output: `Read config error: ${data.__error}` };

  if (!data.mcpServers[serverName]) {
    // Copy tu inherited
    const inherited = loadInheritedMCPConfig(projectDir).mcpServers;
    if (!inherited[serverName]) {
      return { ok: false, output: `Server '${serverName}' not found in any config source` };
    }
    data.mcpServers[serverName] = { ...inherited[serverName] };
  }
  data.mcpServers[serverName].disabled = false;
  const file = writeOrcaiMCP(projectDir, data);
  return { ok: true, output: `Enabled '${serverName}' in ${file}. Restart orcai de reload.` };
}

/**
 * /mcp disable <server> — set disabled=true.
 */
async function mcpDisable(projectDir, serverName) {
  if (!serverName) return { ok: false, output: 'Usage: /mcp disable <server>' };

  const data = readOrcaiMCP(projectDir);
  if (data.__error) return { ok: false, output: `Read config error: ${data.__error}` };

  if (!data.mcpServers[serverName]) {
    const inherited = loadInheritedMCPConfig(projectDir).mcpServers;
    if (!inherited[serverName]) {
      return { ok: false, output: `Server '${serverName}' not found` };
    }
    data.mcpServers[serverName] = { ...inherited[serverName] };
  }
  data.mcpServers[serverName].disabled = true;
  const file = writeOrcaiMCP(projectDir, data);
  return { ok: true, output: `Disabled '${serverName}' in ${file}. Restart orcai de reload.` };
}

/**
 * /mcp add — them server moi vao .orcai/mcp.json.
 * spec: { name, command?, args?, env?, url?, headers?, type? }
 */
async function mcpAdd(projectDir, spec) {
  if (!spec || !spec.name) return { ok: false, output: 'Usage: /mcp add {"name":"...", "command":"npx", "args":[...]}' };
  if (!spec.command && !spec.url) {
    return { ok: false, output: 'Spec must have either "command" (stdio) or "url" (sse)' };
  }

  const data = readOrcaiMCP(projectDir);
  if (data.__error) return { ok: false, output: `Read config error: ${data.__error}` };

  const entry = {};
  if (spec.command) entry.command = spec.command;
  if (spec.args) entry.args = Array.isArray(spec.args) ? spec.args : [String(spec.args)];
  if (spec.env && typeof spec.env === 'object') entry.env = spec.env;
  if (spec.url) entry.url = spec.url;
  if (spec.headers && typeof spec.headers === 'object') entry.headers = spec.headers;
  if (spec.type) entry.type = spec.type;

  const existed = !!data.mcpServers[spec.name];
  data.mcpServers[spec.name] = entry;
  const file = writeOrcaiMCP(projectDir, data);
  return {
    ok: true,
    output: `${existed ? 'Updated' : 'Added'} server '${spec.name}' in ${file}. Restart orcai de connect.`
  };
}

/**
 * /mcp call <prefixed> <argsJson> — goi truc tiep 1 tool MCP de debug.
 */
async function mcpCall(registry, prefixedName, argsJson) {
  if (!registry) return { ok: false, output: 'Registry not initialized' };
  if (!prefixedName) return { ok: false, output: 'Usage: /mcp call <mcp__server__tool> <argsJson>' };
  if (!registry.hasTool || !registry.hasTool(prefixedName)) {
    return { ok: false, output: `Tool not registered: ${prefixedName}. Try /mcp tools <server>` };
  }

  let args = {};
  if (argsJson) {
    if (typeof argsJson === 'object') {
      args = argsJson;
    } else {
      try { args = JSON.parse(argsJson); }
      catch (e) { return { ok: false, output: `Invalid JSON args: ${e.message}` }; }
    }
  }

  try {
    const res = await registry.callTool(prefixedName, args);
    if (res.success === false) {
      return { ok: false, output: `ERROR: ${res.error || 'unknown'}`, data: res };
    }
    const lines = [`OK ${prefixedName}`];
    if (res.content) lines.push('---', res.content);
    if (res.attachments && res.attachments.length) {
      lines.push(`(+${res.attachments.length} attachments: ${res.attachments.map(a => a.type).join(', ')})`);
    }
    return { ok: true, output: lines.join('\n'), data: res };
  } catch (e) {
    return { ok: false, output: `Call failed: ${e.message}` };
  }
}

module.exports = {
  mcpList,
  mcpTools,
  mcpEnable,
  mcpDisable,
  mcpAdd,
  mcpCall,
  // internals exposed for advanced integration
  readOrcaiMCP,
  writeOrcaiMCP
};
