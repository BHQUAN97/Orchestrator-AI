#!/usr/bin/env node
/**
 * EmbeddingStore — OpenAI-compatible embedding client + JSON vector store.
 *
 * Goi qua LiteLLM gateway (mac dinh http://localhost:5002) voi payload
 * chuan `/v1/embeddings`. Luu vao `.orcai/embeddings/<sha256(model)>.json`.
 *
 * - Khong co deps moi: dung fetch built-in cua Node 18+
 * - Vector duoc normalize khi luu → cosine = dot product (nhanh)
 * - Atomic write: viet tmp roi rename
 * - Lazy load file khi can
 *
 * Business logic (tieng Viet): thiet ke don gian cho solo dev, it file,
 * khong can vector DB rieng. Khi corpus > ~50k chunks nen chuyen qua
 * vector DB that (pgvector, qdrant...).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_ENDPOINT = 'http://localhost:5002';
// Mac dinh dung local-embed (LM Studio) de tiet kiem; fallback cloud khi local fail.
// Override qua ORCAI_EMBED_MODEL / ORCAI_EMBED_FALLBACK.
const DEFAULT_MODEL = process.env.ORCAI_EMBED_MODEL || 'local-embed';
const DEFAULT_FALLBACK_MODEL = process.env.ORCAI_EMBED_FALLBACK || 'text-embedding-3-small';
const DEFAULT_DIM = 1536;
const BATCH_SIZE = 100;          // embed() batch per HTTP call
const UPSERT_CHUNK = 50;         // upsertBatch chunk size
const MAX_RETRIES = 2;           // retry on 429/5xx

// Cross-project defaults
const DEFAULT_SHARED_ROOT = 'E:\\DEVELOP\\.claude-shared';
// Giam gioi han file de tranh index binary/build artifacts
const CROSS_MAX_FILE_BYTES = 256 * 1024;   // 256 KB
const CROSS_CHUNK_SIZE = 1200;              // chars per chunk
const CROSS_CHUNK_OVERLAP = 150;
const CROSS_EXT_ALLOW = new Set(['.md', '.mdx', '.txt']);

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Normalize vector in-place, return same array.
 * Neu norm = 0 → return original (khong divide by zero).
 */
function normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i] / norm;
  return vec;
}

/**
 * Check if file path likely binary by sniffing first bytes.
 */
function isBinary(buf) {
  if (!buf || buf.length === 0) return false;
  const len = Math.min(buf.length, 512);
  for (let i = 0; i < len; i++) {
    const b = buf[i];
    // Null byte — strong binary signal
    if (b === 0) return true;
  }
  return false;
}

class EmbeddingStore {
  constructor(options = {}) {
    const {
      projectDir = process.cwd(),
      model = DEFAULT_MODEL,
      fallbackModel = DEFAULT_FALLBACK_MODEL,
      endpoint = process.env.LITELLM_URL || DEFAULT_ENDPOINT,
      apiKey = process.env.LITELLM_KEY,
      dim = DEFAULT_DIM
    } = options;

    this.projectDir = projectDir;
    this.model = model;
    this.fallbackModel = fallbackModel;
    this.endpoint = String(endpoint).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.dim = dim;
    // Track fallback state — neu local fail 3 lan, skip local tam thoi
    this._localFailures = 0;
    this._skipLocalUntil = 0;

    // Path: .orcai/embeddings/<sha256(model)>.json
    this.storeDir = path.join(projectDir, '.orcai', 'embeddings');
    this.storeFile = path.join(this.storeDir, `${sha256(model)}.json`);

    this._data = null;       // {model, dim, items}
    this._loaded = false;
    this._failCount = 0;     // track khi endpoint fail de khong loop
  }

  // =================== Persistence ===================

  _ensureDir() {
    if (!fs.existsSync(this.storeDir)) {
      fs.mkdirSync(this.storeDir, { recursive: true });
    }
  }

  load() {
    if (this._loaded) return this._data;
    this._ensureDir();
    if (fs.existsSync(this.storeFile)) {
      try {
        const raw = fs.readFileSync(this.storeFile, 'utf8');
        this._data = JSON.parse(raw);
        // Migrate/validate
        if (!this._data.items) this._data.items = [];
        if (!this._data.model) this._data.model = this.model;
        if (!this._data.dim) this._data.dim = this.dim;
      } catch (e) {
        // File hong → bat dau lai
        this._data = { model: this.model, dim: this.dim, items: [] };
      }
    } else {
      this._data = { model: this.model, dim: this.dim, items: [] };
    }
    this._loaded = true;
    return this._data;
  }

  save() {
    this._ensureDir();
    const data = this.load();
    data.model = this.model;
    data.dim = this.dim;
    const tmp = `${this.storeFile}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, this.storeFile);
  }

  // =================== Cosine similarity ===================

  /**
   * Cosine similarity for 2 number[] of same length.
   * Neu ca 2 da normalized → ket qua = dot product.
   */
  _cosine(a, b) {
    if (!a || !b) return 0;
    const n = Math.min(a.length, b.length);
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < n; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    if (denom === 0) return 0;
    return dot / denom;
  }

  // =================== HTTP embedding call ===================

  /**
   * Low-level HTTP call to /v1/embeddings. Retry 2x on 429/5xx.
   * Throws on final failure.
   * @param {string[]} inputs
   * @param {string} [modelOverride] - goi model khac thay vi this.model
   */
  async _callEmbedAPI(inputs, modelOverride) {
    const url = `${this.endpoint}/v1/embeddings`;
    const headers = {
      'Content-Type': 'application/json'
    };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const body = JSON.stringify({
      model: modelOverride || this.model,
      input: inputs
    });

    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, { method: 'POST', headers, body });
        if (!res.ok) {
          const status = res.status;
          // Retry on 429 / 5xx
          if ((status === 429 || status >= 500) && attempt < MAX_RETRIES) {
            const wait = 500 * Math.pow(2, attempt);
            await sleep(wait);
            continue;
          }
          const text = await res.text().catch(() => '');
          throw new Error(`Embedding API ${status}: ${text.slice(0, 200)}`);
        }
        const json = await res.json();
        if (!json.data || !Array.isArray(json.data)) {
          throw new Error(`Embedding API bad response: missing data[]`);
        }
        // Sort by index de dam bao thu tu (OpenAI format co field `index`)
        const sorted = json.data.slice().sort((a, b) => (a.index || 0) - (b.index || 0));
        return sorted.map(d => d.embedding);
      } catch (e) {
        lastErr = e;
        // Network error: retry
        if (attempt < MAX_RETRIES) {
          const wait = 500 * Math.pow(2, attempt);
          await sleep(wait);
          continue;
        }
      }
    }
    this._failCount++;
    throw new Error(
      `Embedding endpoint failed after ${MAX_RETRIES + 1} attempts: ` +
      `${lastErr?.message || 'unknown'} (endpoint=${this.endpoint})`
    );
  }

  /**
   * Call API thu primary, neu loi fallback sang model du phong.
   * Chi fallback neu primary != fallback va fallbackModel duoc cau hinh.
   */
  async _callWithFallback(inputs, modelOverride) {
    const primary = modelOverride || this.model;
    // Neu dang trong cooldown → skip local, di thang fallback
    const now = Date.now();
    const skipPrimary = this._skipLocalUntil > now && primary === this.model && this.fallbackModel;

    if (!skipPrimary) {
      try {
        const vecs = await this._callEmbedAPI(inputs, primary);
        // Reset fail counter on success
        if (primary === this.model) this._localFailures = 0;
        return vecs;
      } catch (err) {
        // Neu khong co fallback hoac primary == fallback → throw
        if (!this.fallbackModel || primary === this.fallbackModel) throw err;
        // Track local failures — neu 3 lan lien tiep → cooldown 60s
        if (primary === this.model) {
          this._localFailures++;
          if (this._localFailures >= 3) {
            this._skipLocalUntil = now + 60_000;
            this._localFailures = 0;
          }
        }
      }
    }
    // Fallback path
    return await this._callEmbedAPI(inputs, this.fallbackModel);
  }

  /**
   * Public embed — batch into 100 items/req.
   * Try local first, fallback to cloud on failure (silent — no user-visible error).
   * @param {string[]} texts
   * @param {{ model?: string }} [opts] - override model per-call
   * @returns {Promise<number[][]>}
   */
  async embed(texts, opts = {}) {
    if (!Array.isArray(texts)) throw new Error('embed: texts must be array');
    if (texts.length === 0) return [];
    const modelOverride = opts.model;
    const results = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const chunk = texts.slice(i, i + BATCH_SIZE);
      const vecs = await this._callWithFallback(chunk, modelOverride);
      for (const v of vecs) results.push(v);
    }
    return results;
  }

  /**
   * Batch embed helper — explicitly batched, returns vectors in order.
   * Alias/convenience for callers who want explicit batching intent.
   */
  async embedMany(texts, opts = {}) {
    return this.embed(texts, opts);
  }

  // =================== CRUD ===================

  /**
   * Upsert 1 item (embed + save).
   */
  async upsert({ id, text, metadata = {} }) {
    if (!id) throw new Error('upsert: id required');
    const [vec] = await this.embed([text || '']);
    this._upsertLocal({ id, text, vector: vec, metadata });
    this.save();
    return true;
  }

  /**
   * Upsert batch (chunks of 50). 1 HTTP call per chunk.
   */
  async upsertBatch(items) {
    if (!Array.isArray(items) || items.length === 0) return 0;
    let count = 0;
    for (let i = 0; i < items.length; i += UPSERT_CHUNK) {
      const chunk = items.slice(i, i + UPSERT_CHUNK);
      const texts = chunk.map(it => it.text || '');
      const vecs = await this.embed(texts);
      for (let j = 0; j < chunk.length; j++) {
        const it = chunk[j];
        this._upsertLocal({
          id: it.id,
          text: it.text,
          vector: vecs[j],
          metadata: it.metadata || {}
        });
        count++;
      }
    }
    this.save();
    return count;
  }

  /**
   * In-memory upsert (no HTTP). Normalize vector before store.
   */
  _upsertLocal({ id, text, vector, metadata }) {
    const data = this.load();
    const normed = normalize(vector.slice()); // clone to avoid mutating caller
    const now = nowIso();
    const idx = data.items.findIndex(it => it.id === id);
    const item = { id, text, vector: normed, metadata: metadata || {}, updated: now };
    if (idx >= 0) data.items[idx] = item;
    else data.items.push(item);
  }

  /**
   * Query by text (embed + cosine similarity).
   * @param {{text, top_k, filter}} args
   *   filter: optional (item) => boolean
   * @returns {Array<{id, score, text, metadata}>}
   */
  async query({ text, top_k = 5, filter = null }) {
    const data = this.load();
    if (!data.items.length) return [];
    const [qvec] = await this.embed([text || '']);
    const qn = normalize(qvec.slice());

    const scored = [];
    for (const item of data.items) {
      if (filter && !filter(item)) continue;
      // Vectors stored normalized → dot product = cosine
      const score = this._cosine(qn, item.vector);
      scored.push({
        id: item.id,
        score,
        text: item.text,
        metadata: item.metadata
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, top_k);
  }

  /**
   * Remove by id.
   */
  async remove(id) {
    const data = this.load();
    const before = data.items.length;
    data.items = data.items.filter(it => it.id !== id);
    if (data.items.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  /**
   * Clear entire store (reset items to []).
   */
  async clear() {
    this._data = { model: this.model, dim: this.dim, items: [] };
    this._loaded = true;
    this.save();
    return true;
  }

  /**
   * Stats snapshot.
   */
  stats() {
    const data = this.load();
    let sizeKb = 0;
    try {
      if (fs.existsSync(this.storeFile)) {
        sizeKb = Math.round(fs.statSync(this.storeFile).size / 1024);
      }
    } catch { /* ignore */ }
    let lastUpdated = null;
    for (const it of data.items) {
      if (!lastUpdated || (it.updated && it.updated > lastUpdated)) {
        lastUpdated = it.updated;
      }
    }
    return {
      count: data.items.length,
      model: this.model,
      dim: this.dim,
      last_updated: lastUpdated,
      size_kb: sizeKb,
      fail_count: this._failCount,
      endpoint: this.endpoint,
      store_file: this.storeFile
    };
  }

  // =================== Cross-Project Index ===================

  /**
   * Resolve shared store path based on env or provided root.
   * Mac dinh: E:\DEVELOP\.claude-shared\embeddings\shared.index.json
   */
  _sharedStorePaths(rootOverride) {
    const root = rootOverride || process.env.CLAUDE_SHARED_ROOT || DEFAULT_SHARED_ROOT;
    const dir = path.join(root, 'embeddings');
    const file = path.join(dir, 'shared.index.json');
    return { root, dir, file };
  }

  _loadShared(file) {
    if (fs.existsSync(file)) {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const data = JSON.parse(raw);
        if (!data.items) data.items = [];
        if (!data.model) data.model = this.model;
        if (!data.dim) data.dim = this.dim;
        return data;
      } catch {
        return { model: this.model, dim: this.dim, items: [] };
      }
    }
    return { model: this.model, dim: this.dim, items: [] };
  }

  _saveShared(file, data) {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
  }

  /**
   * Cat noi dung thanh cac chunk co overlap (tinh theo ky tu).
   */
  _chunkText(text, size = CROSS_CHUNK_SIZE, overlap = CROSS_CHUNK_OVERLAP) {
    const out = [];
    if (!text) return out;
    const step = Math.max(1, size - overlap);
    for (let i = 0; i < text.length; i += step) {
      const slice = text.slice(i, i + size).trim();
      if (slice.length > 0) out.push(slice);
      if (i + size >= text.length) break;
    }
    return out;
  }

  _listMarkdownFiles(dir) {
    const out = [];
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
      catch { continue; }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) {
          // Bo qua build/cache dirs
          if (/^(node_modules|\.git|\.orcai|dist|build|coverage|\.next)$/i.test(e.name)) continue;
          stack.push(full);
        } else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase();
          if (!CROSS_EXT_ALLOW.has(ext)) continue;
          try {
            const st = fs.statSync(full);
            if (st.size > CROSS_MAX_FILE_BYTES) continue;
          } catch { continue; }
          out.push(full);
        }
      }
    }
    return out;
  }

  /**
   * Suy ra ten project tu path (basename cua project root).
   */
  _inferProjectName(projectRoot) {
    return path.basename(path.resolve(projectRoot));
  }

  /**
   * Index cross-project: quet memory markdown cua tat ca project trong
   * .claude-shared/projects/ (hoac roots custom), embed va luu vao shared index.
   *
   * @param {{ roots?: string[], sharedRoot?: string, filePattern?: RegExp }} opts
   * @returns {Promise<{ indexed: number, files: number, projects: string[], storeFile: string }>}
   */
  async indexCrossProject(opts = {}) {
    const { roots, sharedRoot, filePattern } = opts;
    const { file: storeFile } = this._sharedStorePaths(sharedRoot);

    // Resolve roots: neu user truyen, dung luon; neu khong, list cac project trong projects/
    let projectRoots = roots;
    if (!projectRoots || projectRoots.length === 0) {
      const base = path.join(sharedRoot || process.env.CLAUDE_SHARED_ROOT || DEFAULT_SHARED_ROOT, 'projects');
      if (fs.existsSync(base)) {
        projectRoots = fs.readdirSync(base, { withFileTypes: true })
          .filter(e => e.isDirectory())
          .map(e => path.join(base, e.name));
      } else {
        projectRoots = [];
      }
    }

    const data = this._loadShared(storeFile);
    // Reset items — re-index (simple, keeps store clean)
    data.items = [];
    data.model = this.model;
    data.dim = this.dim;

    const toUpsert = [];
    const projects = new Set();
    let fileCount = 0;

    for (const root of projectRoots) {
      if (!root || !fs.existsSync(root)) continue;
      const project = this._inferProjectName(root);
      projects.add(project);
      const files = this._listMarkdownFiles(root);
      for (const f of files) {
        if (filePattern && !filePattern.test(f)) continue;
        let text = '';
        try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
        if (!text || !text.trim()) continue;
        const chunks = this._chunkText(text);
        const rel = path.relative(root, f).replace(/\\/g, '/');
        for (let idx = 0; idx < chunks.length; idx++) {
          const chunk = chunks[idx];
          const id = sha256(`${project}|${rel}|${idx}`);
          toUpsert.push({
            id,
            text: chunk,
            metadata: { project, file: rel, chunkIndex: idx, absPath: f }
          });
        }
        fileCount++;
      }
    }

    if (toUpsert.length === 0) {
      this._saveShared(storeFile, data);
      return { indexed: 0, files: fileCount, projects: Array.from(projects), storeFile };
    }

    // Embed in batches
    let indexed = 0;
    for (let i = 0; i < toUpsert.length; i += UPSERT_CHUNK) {
      const chunk = toUpsert.slice(i, i + UPSERT_CHUNK);
      const vecs = await this.embed(chunk.map(c => c.text));
      for (let j = 0; j < chunk.length; j++) {
        const it = chunk[j];
        const normed = normalize(vecs[j].slice());
        data.items.push({
          id: it.id,
          text: it.text,
          vector: normed,
          metadata: it.metadata,
          updated: nowIso()
        });
        indexed++;
      }
    }

    this._saveShared(storeFile, data);
    return { indexed, files: fileCount, projects: Array.from(projects), storeFile };
  }

  /**
   * Semantic search across all indexed projects.
   * @param {{ query: string, topK?: number, excludeProject?: string, projectFilter?: string[], sharedRoot?: string, minScore?: number }} args
   * @returns {Promise<Array<{ id, score, text, project, file, chunkIndex, metadata }>>}
   */
  async searchCrossProject(args = {}) {
    const {
      query,
      topK = 5,
      excludeProject,
      projectFilter,
      sharedRoot,
      minScore = 0
    } = args;
    if (!query) return [];

    const { file: storeFile } = this._sharedStorePaths(sharedRoot);
    const data = this._loadShared(storeFile);
    if (!data.items.length) return [];

    const [qvec] = await this.embed([query]);
    const qn = normalize(qvec.slice());

    const allowSet = Array.isArray(projectFilter) && projectFilter.length > 0
      ? new Set(projectFilter) : null;

    const scored = [];
    for (const item of data.items) {
      const project = item.metadata?.project;
      if (excludeProject && project === excludeProject) continue;
      if (allowSet && !allowSet.has(project)) continue;
      const score = this._cosine(qn, item.vector);
      if (score < minScore) continue;
      scored.push({
        id: item.id,
        score,
        text: item.text,
        project,
        file: item.metadata?.file,
        chunkIndex: item.metadata?.chunkIndex,
        metadata: item.metadata
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * Stats for shared cross-project index.
   */
  crossStats(sharedRoot) {
    const { file } = this._sharedStorePaths(sharedRoot);
    const data = this._loadShared(file);
    const byProject = {};
    for (const it of data.items) {
      const p = it.metadata?.project || '_unknown';
      byProject[p] = (byProject[p] || 0) + 1;
    }
    let sizeKb = 0;
    try { if (fs.existsSync(file)) sizeKb = Math.round(fs.statSync(file).size / 1024); } catch {}
    return {
      count: data.items.length,
      by_project: byProject,
      size_kb: sizeKb,
      store_file: file
    };
  }

  // Expose helpers for tests / tool layer
  static _sha256(s) { return sha256(s); }
  static _isBinary(buf) { return isBinary(buf); }
  static _normalize(v) { return normalize(v); }
}

module.exports = { EmbeddingStore, isBinary, normalize, sha256 };
