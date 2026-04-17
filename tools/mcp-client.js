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

// fetch built-in tu Node 18+; fallback an toan neu moi truong cu
const _fetch = (typeof fetch === 'function') ? fetch : null;

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
    this.resources = [];
    this.prompts = [];
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

          // Resources (optional — many servers don't implement)
          try {
            const resRes = await this._rpc('resources/list', {});
            if (!resRes.error) this.resources = resRes.result?.resources || [];
          } catch { this.resources = []; }

          // Prompts (optional)
          try {
            const promptRes = await this._rpc('prompts/list', {});
            if (!promptRes.error) this.prompts = promptRes.result?.prompts || [];
          } catch { this.prompts = []; }

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

  async readResource(uri) {
    if (!this.initialized) throw new Error(`MCP ${this.name}: not initialized`);
    const res = await this._rpc('resources/read', { uri });
    if (res.error) return { success: false, error: res.error.message };
    const contents = res.result?.contents || [];
    const text = contents.filter(c => c.text).map(c => c.text).join('\n');
    return { success: true, content: text || '(no text content)', mimeType: contents[0]?.mimeType };
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
 * 1 MCP server client qua HTTP+SSE transport (MCP 2024-11-05 SSE spec)
 *
 * Config format:
 *   { url: 'https://host/sse', headers: { Authorization: 'Bearer ...' }, type: 'sse' }
 *
 * Luong giao tiep:
 *   - GET <url> (Accept: text/event-stream) → server tra event 'endpoint' voi POST URL
 *   - POST <endpoint> body = JSON-RPC request → response qua SSE stream
 *   - Notifications cung qua SSE
 */
class MCPSSEClient {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.resources = [];
    this.prompts = [];
    this.initialized = false;
    this.startError = null;

    // SSE state
    this.sseController = null;
    this.sseReader = null;
    this.postEndpoint = null; // URL de POST JSON-RPC (server cung cap qua event 'endpoint')
    this._endpointWaiters = [];
    this._closed = false;
  }

  async start(timeoutMs = INIT_TIMEOUT_MS) {
    if (this.initialized) return;
    if (!_fetch) throw new Error(`MCP ${this.name}: global fetch not available (requires Node 18+)`);
    if (!this.config.url) throw new Error(`MCP ${this.name}: missing 'url' for SSE transport`);

    const deadline = Date.now() + timeoutMs;

    // Open SSE stream
    try {
      await this._openSSE(timeoutMs);
    } catch (e) {
      this.startError = e;
      throw new Error(`MCP ${this.name}: SSE connect failed — ${e.message}`);
    }

    // Wait endpoint event (some servers send it immediately, others require handshake)
    try {
      await this._waitForEndpoint(Math.max(1000, deadline - Date.now()));
    } catch (e) {
      // Neu server khong dung "endpoint" event, fallback: POST truc tiep vao url goc
      this.postEndpoint = this.config.url;
    }

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

      try {
        const resRes = await this._rpc('resources/list', {});
        if (!resRes.error) this.resources = resRes.result?.resources || [];
      } catch { this.resources = []; }

      try {
        const pRes = await this._rpc('prompts/list', {});
        if (!pRes.error) this.prompts = pRes.result?.prompts || [];
      } catch { this.prompts = []; }
    } catch (e) {
      this.startError = e;
      await this.stop();
      throw e;
    }
  }

  async callTool(toolName, args) {
    if (!this.initialized) throw new Error(`MCP ${this.name}: not initialized`);
    const res = await this._rpc('tools/call', { name: toolName, arguments: args || {} });
    if (res.error) return { success: false, error: res.error.message };

    const content = res.result?.content || [];
    const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    const nonText = content.filter(c => c.type !== 'text');
    return {
      success: !res.result?.isError,
      content: text || '(no text content)',
      ...(nonText.length > 0 ? { attachments: nonText.map(c => ({ type: c.type, mimeType: c.mimeType })) } : {}),
      ...(res.result?.isError ? { error: text || 'Tool returned isError' } : {})
    };
  }

  async readResource(uri) {
    if (!this.initialized) throw new Error(`MCP ${this.name}: not initialized`);
    const res = await this._rpc('resources/read', { uri });
    if (res.error) return { success: false, error: res.error.message };
    const contents = res.result?.contents || [];
    const text = contents.filter(c => c.text).map(c => c.text).join('\n');
    return { success: true, content: text || '(no text content)', mimeType: contents[0]?.mimeType };
  }

  async stop() {
    this._closed = true;
    this.initialized = false;
    try { this.sseController?.abort(); } catch {}
    try { await this.sseReader?.cancel(); } catch {}
    this.sseController = null;
    this.sseReader = null;
    for (const [, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      try { reject(new Error(`MCP ${this.name}: stopped`)); } catch {}
    }
    this.pending.clear();
  }

  // --- SSE internals ---

  async _openSSE(timeoutMs) {
    this.sseController = new AbortController();
    const headers = {
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...(this.config.headers || {})
    };
    const t = setTimeout(() => { try { this.sseController.abort(); } catch {} }, timeoutMs);

    const res = await _fetch(this.config.url, {
      method: 'GET',
      headers,
      signal: this.sseController.signal
    });
    clearTimeout(t);

    if (!res.ok) throw new Error(`SSE HTTP ${res.status} ${res.statusText}`);
    if (!res.body) throw new Error('SSE: no response body');

    this.sseReader = res.body.getReader();
    // Background loop — khong await de handshake duoc chay song song
    this._pumpSSE().catch((e) => {
      if (!this._closed) this._fatal(e);
    });
  }

  async _pumpSSE() {
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    while (!this._closed) {
      const { value, done } = await this.sseReader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Tach theo \n\n — moi event SSE ket thuc bang blank line
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1 || (idx = buffer.indexOf('\r\n\r\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 4 : 2));
        this._handleSSEEvent(rawEvent);
      }
    }
  }

  _handleSSEEvent(raw) {
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue; // comment/keepalive
      const colonIdx = line.indexOf(':');
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
      const val = colonIdx === -1 ? '' : line.slice(colonIdx + 1).replace(/^ /, '');
      if (field === 'event') event = val;
      else if (field === 'data') dataLines.push(val);
    }
    const data = dataLines.join('\n');
    if (!data) return;

    if (event === 'endpoint') {
      // Server thong bao URL de POST JSON-RPC
      try {
        const base = new URL(this.config.url);
        const resolved = new URL(data, base).toString();
        this.postEndpoint = resolved;
      } catch {
        this.postEndpoint = data;
      }
      const waiters = this._endpointWaiters.splice(0);
      waiters.forEach(w => w.resolve(this.postEndpoint));
      return;
    }

    // Message event — parse JSON-RPC
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      resolve(msg);
    }
    // Server notifications ignored
  }

  _waitForEndpoint(timeoutMs) {
    if (this.postEndpoint) return Promise.resolve(this.postEndpoint);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this._endpointWaiters.findIndex(w => w.timer === timer);
        if (i >= 0) this._endpointWaiters.splice(i, 1);
        reject(new Error('endpoint event not received'));
      }, timeoutMs);
      this._endpointWaiters.push({ resolve: (v) => { clearTimeout(timer); resolve(v); }, timer });
    });
  }

  _fatal(err) {
    this.startError = err;
    for (const [, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      try { reject(err); } catch {}
    }
    this.pending.clear();
    this.initialized = false;
  }

  async _postRPC(payload) {
    const endpoint = this.postEndpoint || this.config.url;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(this.config.headers || {})
    };
    const res = await _fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    // 202 Accepted — response qua SSE stream (khong doc body)
    // 200 + JSON — 1 so server tra ket qua truc tiep
    if (res.status === 200) {
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        try {
          const body = await res.json();
          if (body && body.id != null && this.pending.has(body.id)) {
            const { resolve, timer } = this.pending.get(body.id);
            clearTimeout(timer);
            this.pending.delete(body.id);
            resolve(body);
          }
        } catch { /* ignore — cho SSE */ }
      }
    } else if (res.status >= 400) {
      throw new Error(`POST ${endpoint} HTTP ${res.status}`);
    }
  }

  _rpc(method, params) {
    return new Promise((resolve, reject) => {
      if (this._closed) return reject(new Error(`MCP ${this.name}: closed`));
      const id = this.nextId++;
      const payload = { jsonrpc: '2.0', id, method, params };
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP ${this.name}: RPC timeout on ${method}`));
        }
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this._postRPC(payload).catch((e) => {
        if (this.pending.has(id)) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(e);
        }
      });
    });
  }

  _notify(method, params) {
    // Notification: khong co id, khong cho response
    this._postRPC({ jsonrpc: '2.0', method, params }).catch(() => {});
  }
}

/**
 * Chon transport class dua tren config
 */
function pickTransportClass(cfg) {
  if (!cfg) return MCPClient;
  if (cfg.type === 'sse' || cfg.type === 'http') return MCPSSEClient;
  if (cfg.url && !cfg.command) return MCPSSEClient;
  return MCPClient;
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
      const Transport = pickTransportClass(cfg);
      const client = new Transport(name, cfg);
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

  /**
   * Liet ke resources tren cac MCP server
   */
  listResources() {
    const out = [];
    for (const [name, client] of this.clients) {
      for (const r of (client.resources || [])) {
        out.push({ server: name, uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType });
      }
    }
    return out;
  }

  /**
   * Doc resource tu server cu the
   */
  async readResource(serverName, uri) {
    const client = this.clients.get(serverName);
    if (!client) return { success: false, error: `MCP server not found: ${serverName}` };
    try {
      return await client.readResource(uri);
    } catch (e) {
      return { success: false, error: `Read resource failed: ${e.message}` };
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

module.exports = { MCPClient, MCPSSEClient, MCPRegistry, getRegistry, pickTransportClass };
