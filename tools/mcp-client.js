#!/usr/bin/env node
/**
 * MCP Client — Minimal Model Context Protocol client (stdio transport)
 *
 * Cho phep orcai su dung cac MCP server (filesystem, github, playwright, context7...)
 * nhu Claude Code.
 *
 * Config: .mcp.json trong project hoac ~/.claude/mcp.json
 * Format:
 *   {
 *     "mcpServers": {
 *       "filesystem": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
 *         "env": {}
 *       },
 *       "github": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-github"],
 *         "env": { "GITHUB_TOKEN": "..." }
 *       }
 *     }
 *   }
 *
 * Tools duoc prefix: mcp__<server>__<tool> (giong Claude Code convention)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MCP_PROTOCOL_VERSION = '2024-11-05';
const RPC_TIMEOUT_MS = 30000;
const INIT_TIMEOUT_MS = 15000;

/**
 * 1 MCP server client (stdio JSON-RPC)
 */
class MCPClient {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.tools = [];
    this.initialized = false;
    this.startError = null;
  }

  async start(timeoutMs = INIT_TIMEOUT_MS) {
    if (this.initialized) return;
    if (!this.config.command) throw new Error(`MCP ${this.name}: missing 'command'`);

    return new Promise((resolve, reject) => {
      const onTimeout = setTimeout(() => {
        this.startError = new Error(`MCP ${this.name}: init timeout after ${timeoutMs}ms`);
        try { this.proc?.kill(); } catch {}
        reject(this.startError);
      }, timeoutMs);

      try {
        this.proc = spawn(this.config.command, this.config.args || [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...(this.config.env || {}) },
          windowsHide: true,
          shell: process.platform === 'win32' // npx tren Windows can shell
        });
      } catch (e) {
        clearTimeout(onTimeout);
        return reject(new Error(`MCP ${this.name}: spawn failed — ${e.message}`));
      }

      this.proc.stdout.on('data', (d) => this._onData(d));
      this.proc.stderr.on('data', () => {}); // silent — some MCP servers log to stderr
      this.proc.on('error', (err) => {
        clearTimeout(onTimeout);
        this.startError = err;
        reject(new Error(`MCP ${this.name}: proc error — ${err.message}`));
      });
      this.proc.on('exit', (code) => {
        this.initialized = false;
        // Reject pending if still waiting
        for (const [, { reject: rej }] of this.pending) {
          rej(new Error(`MCP ${this.name}: process exited with code ${code}`));
        }
        this.pending.clear();
      });

      // Handshake: initialize → notifications/initialized → tools/list
      (async () => {
        try {
          const initRes = await this._rpc('initialize', {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            clientInfo: { name: 'orcai', version: '2.2' }
          });
          if (initRes.error) throw new Error(`initialize: ${initRes.error.message}`);

          this._notify('notifications/initialized', {});
          this.initialized = true;

          const toolsRes = await this._rpc('tools/list', {});
          if (toolsRes.error) throw new Error(`tools/list: ${toolsRes.error.message}`);
          this.tools = toolsRes.result?.tools || [];

          clearTimeout(onTimeout);
          resolve();
        } catch (e) {
          clearTimeout(onTimeout);
          this.startError = e;
          try { this.proc?.kill(); } catch {}
          reject(e);
        }
      })();
    });
  }

  async callTool(toolName, args) {
    if (!this.initialized) throw new Error(`MCP ${this.name}: not initialized`);
    const res = await this._rpc('tools/call', { name: toolName, arguments: args || {} });
    if (res.error) return { success: false, error: res.error.message };

    const content = res.result?.content || [];
    // Flatten text content
    const text = content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
    // Some servers return image/resource — include metadata
    const nonText = content.filter(c => c.type !== 'text');

    return {
      success: !res.result?.isError,
      content: text || '(no text content)',
      ...(nonText.length > 0 ? { attachments: nonText.map(c => ({ type: c.type, mimeType: c.mimeType })) } : {}),
      ...(res.result?.isError ? { error: text || 'Tool returned isError' } : {})
    };
  }

  async stop() {
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
    this.initialized = false;
  }

  _onData(chunk) {
    this.buffer += chunk.toString('utf-8');
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }

      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        resolve(msg);
      }
      // Server-initiated notifications ignored in minimal client
    }
  }

  _rpc(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin?.writable) {
        return reject(new Error(`MCP ${this.name}: stdin not writable`));
      }
      const id = this.nextId++;
      const msg = { jsonrpc: '2.0', id, method, params };
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP ${this.name}: RPC timeout on ${method}`));
        }
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  _notify(method, params) {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
}

/**
 * Registry: quan ly nhieu MCP clients, expose tool list & call dispatch
 */
class MCPRegistry {
  constructor() {
    this.clients = new Map();
    this.toolMap = new Map(); // prefixed name → { client, origName }
    this.errors = [];
  }

  loadConfig(configPath) {
    if (!configPath || !fs.existsSync(configPath)) return {};
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const cfg = JSON.parse(raw);
      return cfg.mcpServers || cfg.mcp_servers || {};
    } catch (e) {
      this.errors.push({ path: configPath, error: e.message });
      return {};
    }
  }

  /**
   * Init: load config tu global + project, start tat ca servers song song.
   * Server fail → bo qua, khong fail toan bo.
   */
  async init({ projectDir, extraConfigPath } = {}) {
    const globalCfg = path.join(os.homedir(), '.claude', 'mcp.json');
    const projectCfg = projectDir ? path.join(projectDir, '.mcp.json') : null;
    const orcaiProjectCfg = projectDir ? path.join(projectDir, '.orcai', 'mcp.json') : null;

    const configs = {
      ...this.loadConfig(globalCfg),
      ...(projectCfg ? this.loadConfig(projectCfg) : {}),
      ...(orcaiProjectCfg ? this.loadConfig(orcaiProjectCfg) : {}),
      ...(extraConfigPath ? this.loadConfig(extraConfigPath) : {})
    };

    const entries = Object.entries(configs).filter(([, cfg]) => !cfg.disabled);

    if (entries.length === 0) {
      return { count: 0, tools: 0, servers: [] };
    }

    const results = await Promise.allSettled(entries.map(async ([name, cfg]) => {
      const client = new MCPClient(name, cfg);
      await client.start();
      this.clients.set(name, client);
      for (const tool of client.tools) {
        const prefixed = `mcp__${name}__${tool.name}`;
        this.toolMap.set(prefixed, { client, origName: tool.name });
      }
      return { name, toolCount: client.tools.length };
    }));

    const servers = [];
    results.forEach((r, i) => {
      const [name] = entries[i];
      if (r.status === 'fulfilled') {
        servers.push({ name, status: 'ok', tools: r.value.toolCount });
      } else {
        this.errors.push({ server: name, error: r.reason?.message || String(r.reason) });
        servers.push({ name, status: 'failed', error: r.reason?.message });
      }
    });

    return {
      count: this.clients.size,
      tools: this.toolMap.size,
      servers,
      errors: this.errors
    };
  }

  /**
   * Lay danh sach tool definitions theo format OpenAI function calling
   */
  getToolDefinitions() {
    const defs = [];
    for (const [prefixed, { client, origName }] of this.toolMap) {
      const origTool = client.tools.find(t => t.name === origName);
      if (!origTool) continue;

      // Clean up schema — mot so server tra ve schema co field nonsense
      const schema = origTool.inputSchema && typeof origTool.inputSchema === 'object'
        ? origTool.inputSchema
        : { type: 'object', properties: {} };

      defs.push({
        type: 'function',
        function: {
          name: prefixed,
          description: `[MCP:${client.name}] ${(origTool.description || origTool.name).slice(0, 500)}`,
          parameters: schema
        }
      });
    }
    return defs;
  }

  async callTool(prefixed, args) {
    const entry = this.toolMap.get(prefixed);
    if (!entry) return { success: false, error: `MCP tool not registered: ${prefixed}` };
    try {
      return await entry.client.callTool(entry.origName, args);
    } catch (e) {
      return { success: false, error: `MCP call failed: ${e.message}` };
    }
  }

  hasTool(name) {
    return this.toolMap.has(name);
  }

  async shutdown() {
    await Promise.all([...this.clients.values()].map(c => c.stop()));
    this.clients.clear();
    this.toolMap.clear();
  }

  getStats() {
    return {
      servers: this.clients.size,
      tools: this.toolMap.size,
      serverList: [...this.clients.keys()],
      errors: this.errors
    };
  }
}

// Singleton cho orcai process
let globalRegistry = null;
function getRegistry() {
  if (!globalRegistry) globalRegistry = new MCPRegistry();
  return globalRegistry;
}

module.exports = { MCPClient, MCPRegistry, getRegistry };
