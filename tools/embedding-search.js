#!/usr/bin/env node
/**
 * Embedding Search Tools — 4 tool handlers + factory createEmbeddingStore.
 *
 * Plug vao executor.js:
 *   const { createEmbeddingStore, embedIndex, embedSearch, embedStats, embedClear }
 *     = require('./embedding-search');
 *   const embeddingStore = createEmbeddingStore({ projectDir });
 *
 * Business logic (tieng Viet):
 *   - Index: quet file, chunk ~800 ky tu overlap 100, embed, upsert
 *   - Search: embed query, cosine similarity
 *   - Giu ID format `path#N` de dedupe va filter theo path
 */

const fs = require('fs');
const path = require('path');
const { EmbeddingStore, isBinary } = require('../lib/embeddings');

const MAX_FILES_PER_CALL = 200;
const SNIFF_BYTES = 512;

/**
 * Factory — init 1 lan trong executor.
 */
function createEmbeddingStore(options = {}) {
  return new EmbeddingStore(options);
}

// =================== Helpers ===================

function readFileSafe(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    // Sniff first bytes
    const sniff = buf.slice(0, SNIFF_BYTES);
    if (isBinary(sniff)) return { binary: true };
    return { binary: false, text: buf.toString('utf8') };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Chunk text into overlapping windows by character count.
 * Return array of {text, start_line, chunk_idx}.
 */
function chunkText(text, chunkSize = 800, overlap = 100) {
  if (!text) return [];
  const chunks = [];
  if (overlap >= chunkSize) overlap = Math.floor(chunkSize / 4);
  const step = Math.max(1, chunkSize - overlap);

  // Precompute line offsets de tinh start_line nhanh
  const lineOffsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') lineOffsets.push(i + 1);
  }
  function lineAt(offset) {
    // Binary search
    let lo = 0, hi = lineOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineOffsets[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1; // 1-based
  }

  let idx = 0;
  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(text.length, start + chunkSize);
    const slice = text.slice(start, end);
    if (slice.trim().length === 0) { idx++; continue; }
    chunks.push({
      text: slice,
      start_line: lineAt(start),
      chunk_idx: idx
    });
    idx++;
    if (end >= text.length) break;
  }
  return chunks;
}

// =================== Tool handlers ===================

/**
 * embedIndex — quet paths, chunk, embed, upsert.
 *
 * @param {Object} args
 * @param {string[]} args.paths — list file paths (absolute or relative)
 * @param {number} [args.chunk_size=800]
 * @param {number} [args.chunk_overlap=100]
 * @param {EmbeddingStore} ctx.embeddingStore
 * @param {string} [ctx.projectDir]
 */
async function embedIndex(args = {}, ctx = {}) {
  const started = Date.now();
  const {
    paths = [],
    chunk_size = 800,
    chunk_overlap = 100
  } = args;
  const store = ctx.embeddingStore;
  const projectDir = ctx.projectDir || process.cwd();

  if (!store) {
    return { success: false, error: 'embeddingStore not initialized' };
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    return { success: false, error: 'paths must be non-empty array' };
  }
  if (paths.length > MAX_FILES_PER_CALL) {
    return {
      success: false,
      error: `Too many files (${paths.length}); limit ${MAX_FILES_PER_CALL}/call`
    };
  }

  let filesIndexed = 0;
  let chunksCreated = 0;
  const skipped = [];
  const itemsBuffer = [];

  for (const p of paths) {
    const abs = path.isAbsolute(p) ? p : path.join(projectDir, p);
    const rel = path.relative(projectDir, abs).replace(/\\/g, '/');
    if (!fs.existsSync(abs)) {
      skipped.push({ path: rel, reason: 'not_found' });
      continue;
    }
    const stat = fs.statSync(abs);
    if (!stat.isFile()) {
      skipped.push({ path: rel, reason: 'not_a_file' });
      continue;
    }
    const read = readFileSafe(abs);
    if (read.error) {
      skipped.push({ path: rel, reason: `read_error: ${read.error}` });
      continue;
    }
    if (read.binary) {
      skipped.push({ path: rel, reason: 'binary' });
      continue;
    }
    const chunks = chunkText(read.text, chunk_size, chunk_overlap);
    if (chunks.length === 0) {
      skipped.push({ path: rel, reason: 'empty' });
      continue;
    }
    for (const c of chunks) {
      itemsBuffer.push({
        id: `${rel}#${c.chunk_idx}`,
        text: c.text,
        metadata: {
          path: rel,
          chunk_idx: c.chunk_idx,
          start_line: c.start_line
        }
      });
      chunksCreated++;
    }
    filesIndexed++;
  }

  if (itemsBuffer.length > 0) {
    try {
      await store.upsertBatch(itemsBuffer);
    } catch (e) {
      return {
        success: false,
        error: `embed failed: ${e.message}`,
        files_indexed: 0,
        chunks_created: 0,
        skipped,
        elapsed_ms: Date.now() - started
      };
    }
  }

  return {
    success: true,
    files_indexed: filesIndexed,
    chunks_created: chunksCreated,
    skipped,
    elapsed_ms: Date.now() - started
  };
}

/**
 * embedSearch — semantic search.
 *
 * @param {Object} args
 * @param {string} args.query
 * @param {number} [args.top_k=5]
 * @param {string} [args.path_filter] — regex string
 */
async function embedSearch(args = {}, ctx = {}) {
  const { query, top_k = 5, path_filter } = args;
  const store = ctx.embeddingStore;
  if (!store) return { success: false, error: 'embeddingStore not initialized' };
  if (!query || typeof query !== 'string') {
    return { success: false, error: 'query required (string)' };
  }

  let filter = null;
  if (path_filter) {
    try {
      const re = new RegExp(path_filter);
      filter = (item) => re.test(item.metadata?.path || '');
    } catch (e) {
      return { success: false, error: `invalid path_filter regex: ${e.message}` };
    }
  }

  try {
    const hits = await store.query({ text: query, top_k, filter });
    const results = hits.map(h => ({
      path: h.metadata?.path || '',
      line_start: h.metadata?.start_line || 1,
      chunk_idx: h.metadata?.chunk_idx || 0,
      text: h.text,
      score: Number(h.score.toFixed(4))
    }));
    return { success: true, results };
  } catch (e) {
    return { success: false, error: `search failed: ${e.message}` };
  }
}

/**
 * embedStats — wrapper.
 */
function embedStats(_args = {}, ctx = {}) {
  const store = ctx.embeddingStore;
  if (!store) return { success: false, error: 'embeddingStore not initialized' };
  return { success: true, ...store.stats() };
}

/**
 * embedClear — xoa store. Phai co confirm:true.
 */
async function embedClear(args = {}, ctx = {}) {
  const { confirm = false } = args;
  const store = ctx.embeddingStore;
  if (!store) return { success: false, error: 'embeddingStore not initialized' };
  if (!confirm) {
    return { success: false, error: 'refused: pass confirm:true to clear store' };
  }
  await store.clear();
  return { success: true, cleared: true };
}

// =================== Tool schemas (for definitions.js) ===================

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'embed_index',
      description: 'Quet va index file vao embedding store (semantic search). Chunk ~800 ky tu overlap 100. Skip binary. Max 200 file/call.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'List duong dan file (tuyet doi hoac tuong doi tu project root)'
          },
          chunk_size: { type: 'integer', default: 800 },
          chunk_overlap: { type: 'integer', default: 100 }
        },
        required: ['paths']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'embed_search',
      description: 'Semantic search tren embedding store. Tra ve top-K chunk co cosine similarity cao nhat.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Truy van ngu nghia' },
          top_k: { type: 'integer', default: 5 },
          path_filter: {
            type: 'string',
            description: 'Regex optional — chi tra ve chunk co path match'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'embed_stats',
      description: 'Thong ke embedding store: so luong chunk, model, dim, size.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'embed_clear',
      description: 'Xoa toan bo embedding store. Phai pass confirm:true de xac nhan.',
      parameters: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', default: false }
        },
        required: ['confirm']
      }
    }
  }
];

module.exports = {
  createEmbeddingStore,
  embedIndex,
  embedSearch,
  embedStats,
  embedClear,
  TOOL_SCHEMAS,
  // internals exported for testing
  _chunkText: chunkText,
  _readFileSafe: readFileSafe
};
