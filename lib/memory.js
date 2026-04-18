#!/usr/bin/env node
/**
 * Memory — Tich luy kinh nghiem giua cac session
 *
 * Store: .orcai/memory/lessons.jsonl — append-only JSONL
 * Entry structure:
 *   { ts, type, prompt_summary, keywords[], outcome, summary, files_changed, iterations }
 *
 * type:
 *   'lesson' — tu dong ghi khi task_complete thanh cong
 *   'gotcha' — ghi khi task fail, de rut kinh nghiem
 *   'manual' — user hoac agent chu dong save
 *   'fact' — project fact (database schema, API contract...)
 *
 * Retrieval: keyword-based scoring (don gian, khong can vector DB).
 * Khi agent chuan bi lam task moi → search top-K relevant entries → inject vao system prompt.
 */

const fs = require('fs');
const path = require('path');
const { searchCorpus } = require('./semantic-search');

// Worker pool — lazy init, fallback gracefully neu khong khoi tao duoc
let _workerPool = null;
let _workerPoolFailed = false;
let _WorkerPoolCtor = null;
function _getWorkerPool() {
  if (_workerPoolFailed) return null;
  if (_workerPool) return _workerPool;
  try {
    if (!_WorkerPoolCtor) {
      _WorkerPoolCtor = require('./worker-pool').WorkerPool;
    }
    const scriptPath = require.resolve('./worker-tasks/tfidf-worker');
    _workerPool = new _WorkerPoolCtor({ scriptPath });
    return _workerPool;
  } catch (err) {
    _workerPoolFailed = true;
    // Log mot lan roi khong spam
    if (process.env.ORCAI_DEBUG) {
      console.warn('[memory] WorkerPool init failed, fallback single-thread:', err.message);
    }
    return null;
  }
}

// Threshold: <100 docs → inline nhanh hon vi overhead postMessage
const WORKER_THRESHOLD = 100;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'or', 'the', 'to', 'of', 'for', 'in', 'on', 'at', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'should', 'could', 'can', 'may',
  'that', 'this', 'these', 'those', 'which', 'what', 'who', 'when', 'where',
  'why', 'how', 'all', 'some', 'any', 'no', 'not', 'very', 'just',
  'va', 'hoac', 'trong', 'cho', 've', 'de', 'cua', 'la', 'co', 'khong',
  'duoc', 'nay', 'do', 'the', 'nay'
]);

function extractKeywords(text, maxKeywords = 15) {
  if (!text) return [];
  const tokens = String(text).toLowerCase()
    .replace(/[^\w\s\-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));

  // Frequency map
  const freq = {};
  for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([w]) => w);
}

class MemoryStore {
  constructor(projectDir, options = {}) {
    this.projectDir = projectDir;
    this.memoryDir = path.join(projectDir, '.orcai', 'memory');
    this.lessonsFile = path.join(this.memoryDir, 'lessons.jsonl');
    this.maxEntries = options.maxEntries || 500;
    this.enabled = options.enabled !== false;
    // Cho phep tat worker qua option (test / debug)
    this.useWorkers = options.useWorkers !== false;

    if (this.enabled) {
      try { fs.mkdirSync(this.memoryDir, { recursive: true }); } catch { this.enabled = false; }
    }
  }

  /**
   * Append entry. Returns the entry with generated id.
   */
  append(entry) {
    if (!this.enabled) return null;
    const record = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: new Date().toISOString(),
      type: entry.type || 'manual',
      keywords: entry.keywords || extractKeywords((entry.prompt_summary || '') + ' ' + (entry.summary || '')),
      ...entry
    };

    try {
      fs.appendFileSync(this.lessonsFile, JSON.stringify(record) + '\n');
      this._trim();
      return record;
    } catch {
      return null;
    }
  }

  /**
   * Read all entries (uses sync read; OK vi file nho ~500 entries max)
   */
  readAll() {
    if (!this.enabled || !fs.existsSync(this.lessonsFile)) return [];
    try {
      const raw = fs.readFileSync(this.lessonsFile, 'utf-8');
      const lines = raw.split('\n').filter(Boolean);
      const entries = [];
      for (const line of lines) {
        try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
      return entries;
    } catch {
      return [];
    }
  }

  /**
   * Search memory. Uses TF-IDF (semantic-search.js) — tot hon keyword overlap:
   *   - Trong so tu hiem (IDF)
   *   - Normalize theo do dai document
   *   - Fallback keyword overlap neu TF-IDF khong khop gi
   *
   * Sync API — giu backward compat. Dung single-thread.
   */
  search(query, limit = 5) {
    if (!query) return [];
    const entries = this.readAll();
    if (!entries.length) return [];

    const docs = this._buildDocs(entries);
    const results = searchCorpus(docs, query, limit);
    if (results.length) {
      return results.map(r => ({ ...r.entry, _score: r._score }));
    }
    return this._keywordFallback(entries, query, limit);
  }

  /**
   * Async variant — dung worker pool khi corpus lon.
   * Backward compat: caller cu khong can dung. Goi searchAsync khi muon tan dung CPU.
   */
  async searchAsync(query, limit = 5) {
    if (!query) return [];
    const entries = this.readAll();
    if (!entries.length) return [];

    const docs = this._buildDocs(entries);

    // Chi offload khi corpus du lon de bu overhead IPC
    if (this.useWorkers && docs.length >= WORKER_THRESHOLD) {
      const pool = _getWorkerPool();
      if (pool) {
        try {
          const rawDocs = docs.map(d => ({ id: d.id, text: d.text }));
          const results = await pool.run({ op: 'search', docs: rawDocs, query, limit });
          if (Array.isArray(results) && results.length) {
            // Map back entry tu id
            const byId = new Map(docs.map(d => [d.id, d.entry]));
            return results
              .map(r => {
                const entry = byId.get(r.id);
                return entry ? { ...entry, _score: r._score } : null;
              })
              .filter(Boolean);
          }
          // Empty tu worker → fallback keyword
          return this._keywordFallback(entries, query, limit);
        } catch (err) {
          // Worker loi → fallback inline, ghi warn mot lan
          if (process.env.ORCAI_DEBUG) {
            console.warn('[memory] worker search failed, fallback inline:', err.message);
          }
          // Fall through to inline
        }
      }
    }

    // Inline fallback
    const results = searchCorpus(docs, query, limit);
    if (results.length) {
      return results.map(r => ({ ...r.entry, _score: r._score }));
    }
    return this._keywordFallback(entries, query, limit);
  }

  /**
   * Xay dung docs array de TF-IDF
   */
  _buildDocs(entries) {
    return entries.map(e => ({
      id: e.id,
      text: [
        e.prompt_summary || '',
        e.summary || '',
        (e.keywords || []).join(' ')
      ].join(' '),
      entry: e
    }));
  }

  /**
   * Fallback keyword-overlap khi TF-IDF rong
   */
  _keywordFallback(entries, query, limit) {
    const queryKws = new Set(extractKeywords(query));
    if (queryKws.size === 0) return [];
    const scored = [];
    for (const e of entries) {
      const entryKws = new Set(e.keywords || []);
      if (entryKws.size === 0) continue;
      let matched = 0;
      for (const kw of queryKws) if (entryKws.has(kw)) matched++;
      if (matched === 0) continue;
      const score = matched / Math.sqrt(queryKws.size * entryKws.size);
      scored.push({ entry: e, score });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => ({ ...s.entry, _score: Number(s.score.toFixed(3)) }));
  }

  list({ limit = 20, type } = {}) {
    let entries = this.readAll();
    if (type) entries = entries.filter(e => e.type === type);
    return entries.slice(-limit).reverse();
  }

  getStats() {
    const entries = this.readAll();
    const byType = {};
    for (const e of entries) byType[e.type] = (byType[e.type] || 0) + 1;
    return { total: entries.length, byType, path: this.lessonsFile };
  }

  /**
   * Tu dong trim neu vuot maxEntries — giu entries moi nhat
   */
  _trim() {
    try {
      const entries = this.readAll();
      if (entries.length <= this.maxEntries) return;
      const kept = entries.slice(-this.maxEntries);
      fs.writeFileSync(this.lessonsFile, kept.map(e => JSON.stringify(e)).join('\n') + '\n');
    } catch { /* ignore */ }
  }

  clear() {
    try { fs.unlinkSync(this.lessonsFile); } catch {}
  }

  /**
   * Cross-project semantic search.
   * Uu tien embeddings (shared index), fallback TF-IDF tren markdown cua cac project khac.
   *
   * @param {string} query
   * @param {{ topK?: number, excludeCurrent?: boolean, sharedRoot?: string, minScore?: number, projectFilter?: string[] }} opts
   * @returns {Promise<Array<{ project, file, text, score, source }>>}
   */
  async crossProjectSearch(query, opts = {}) {
    const {
      topK = 5,
      excludeCurrent = true,
      sharedRoot = process.env.CLAUDE_SHARED_ROOT,
      minScore = 0,
      projectFilter
    } = opts;
    if (!query) return [];

    const currentProject = getCurrentProjectName(this.projectDir);
    const excludeProject = excludeCurrent ? currentProject : undefined;

    // Thu embeddings truoc
    try {
      const { EmbeddingStore } = require('./embeddings');
      const store = new EmbeddingStore({ projectDir: this.projectDir });
      const results = await store.searchCrossProject({
        query, topK, excludeProject, projectFilter, sharedRoot, minScore
      });
      if (results && results.length > 0) {
        return results.map(r => ({
          project: r.project,
          file: r.file,
          chunkIndex: r.chunkIndex,
          text: r.text,
          score: Number((r.score || 0).toFixed(4)),
          source: 'embeddings'
        }));
      }
    } catch (err) {
      if (process.env.ORCAI_DEBUG) {
        console.warn('[memory] crossProjectSearch embeddings failed, fallback TF-IDF:', err.message);
      }
    }

    // Fallback: scan markdown across project folders + TF-IDF
    return _crossProjectTfIdfSearch(query, {
      topK, excludeProject, sharedRoot, projectFilter
    });
  }
}

/**
 * Lay ten project hien tai tu CWD basename (hoac env ORCAI_PROJECT_NAME).
 */
function getCurrentProjectName(projectDir) {
  if (process.env.ORCAI_PROJECT_NAME) return process.env.ORCAI_PROJECT_NAME;
  const dir = projectDir || process.cwd();
  return path.basename(path.resolve(dir));
}

/**
 * Fallback TF-IDF search tren shared memory markdown.
 */
function _crossProjectTfIdfSearch(query, opts) {
  const {
    topK = 5,
    excludeProject,
    sharedRoot = process.env.CLAUDE_SHARED_ROOT || 'E:\\DEVELOP\\.claude-shared',
    projectFilter
  } = opts || {};

  const base = path.join(sharedRoot, 'projects');
  if (!fs.existsSync(base)) return [];

  const allowSet = Array.isArray(projectFilter) && projectFilter.length > 0
    ? new Set(projectFilter) : null;

  const docs = [];
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(base, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch { return []; }

  for (const project of projectDirs) {
    if (excludeProject && project === excludeProject) continue;
    if (allowSet && !allowSet.has(project)) continue;
    const root = path.join(base, project);
    const files = _listMdFilesFlat(root);
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      if (!text.trim()) continue;
      const rel = path.relative(root, f).replace(/\\/g, '/');
      docs.push({
        id: `${project}|${rel}`,
        text,
        entry: { project, file: rel, text }
      });
    }
  }

  if (docs.length === 0) return [];
  const results = searchCorpus(docs, query, topK);
  return results.map(r => ({
    project: r.entry.project,
    file: r.entry.file,
    text: String(r.entry.text || '').slice(0, 800),
    score: Number((r._score || 0).toFixed(4)),
    source: 'tfidf'
  }));
}

function _listMdFilesFlat(dir) {
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
        if (/^(node_modules|\.git|\.orcai|dist|build|coverage|\.next)$/i.test(e.name)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (ext !== '.md' && ext !== '.mdx' && ext !== '.txt') continue;
        try {
          const st = fs.statSync(full);
          if (st.size > 256 * 1024) continue;
        } catch { continue; }
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Format memory entries de inject vao system prompt
 */
function formatMemoryContext(entries, maxLen = 2000) {
  if (!entries?.length) return '';
  const lines = ['=== Relevant past experience ==='];
  for (const e of entries) {
    const prefix = e.type === 'gotcha' ? '⚠' : e.type === 'fact' ? 'ℹ' : '✓';
    const summary = (e.summary || e.prompt_summary || '').slice(0, 200).replace(/\n/g, ' ');
    lines.push(`${prefix} [${e.type}] ${summary}`);
  }
  lines.push('=== End past experience ===');
  const text = lines.join('\n');
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}

/**
 * Cleanup worker pool — goi khi shutdown toan cuc
 */
async function shutdownMemoryWorkers() {
  if (_workerPool) {
    try { await _workerPool.terminate(); } catch {}
    _workerPool = null;
  }
}

// Auto cleanup khi process exit
process.on('exit', () => {
  if (_workerPool) {
    try { _workerPool.terminate(); } catch {}
  }
});

module.exports = {
  MemoryStore,
  extractKeywords,
  formatMemoryContext,
  shutdownMemoryWorkers,
  getCurrentProjectName
};
