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
const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIM = 1536;
const BATCH_SIZE = 100;          // embed() batch per HTTP call
const UPSERT_CHUNK = 50;         // upsertBatch chunk size
const MAX_RETRIES = 2;           // retry on 429/5xx

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
      endpoint = process.env.LITELLM_URL || DEFAULT_ENDPOINT,
      apiKey = process.env.LITELLM_KEY,
      dim = DEFAULT_DIM
    } = options;

    this.projectDir = projectDir;
    this.model = model;
    this.endpoint = String(endpoint).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.dim = dim;

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
   */
  async _callEmbedAPI(inputs) {
    const url = `${this.endpoint}/v1/embeddings`;
    const headers = {
      'Content-Type': 'application/json'
    };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const body = JSON.stringify({
      model: this.model,
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
   * Public embed — batch into 100 items/req.
   * @param {string[]} texts
   * @returns {Promise<number[][]>}
   */
  async embed(texts) {
    if (!Array.isArray(texts)) throw new Error('embed: texts must be array');
    if (texts.length === 0) return [];
    const results = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const chunk = texts.slice(i, i + BATCH_SIZE);
      const vecs = await this._callEmbedAPI(chunk);
      for (const v of vecs) results.push(v);
    }
    return results;
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

  // Expose helpers for tests / tool layer
  static _sha256(s) { return sha256(s); }
  static _isBinary(buf) { return isBinary(buf); }
  static _normalize(v) { return normalize(v); }
}

module.exports = { EmbeddingStore, isBinary, normalize, sha256 };
