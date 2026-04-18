#!/usr/bin/env node
/**
 * CLI: Build RAG embedding index for .orcai/knowledge corpus.
 *
 * Scan md files → chunk 500 words / 100 overlap → embed batch (LM Studio local
 * primary, OpenAI fallback) → write JSON index + JSONL chunks.
 *
 * Zero deps. CommonJS. Native fetch (Node 18+).
 *
 * Usage:
 *   node bin/orcai-build-index.js \
 *     --source .orcai/knowledge/tier1-finetune \
 *     --include .orcai/knowledge/graphs \
 *     --include .orcai/knowledge/playbooks \
 *     --include .orcai/knowledge/vps-gold \
 *     --output .orcai/rag-index.json \
 *     --chunks-output .orcai/rag-chunks.jsonl \
 *     --embedding-model local
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ===================== Defaults =====================

const DEFAULT_CHUNK_SIZE = 500;
const DEFAULT_CHUNK_OVERLAP = 100;
const DEFAULT_OUTPUT = '.orcai/rag-index.json';
const DEFAULT_CHUNKS_OUTPUT = '.orcai/rag-chunks.jsonl';
const DEFAULT_SOURCE = '.orcai/knowledge/tier1-finetune';
const DEFAULT_EMBED_MODEL_MODE = 'local';

const LMSTUDIO_URL = 'http://localhost:1234/v1/embeddings';
const LMSTUDIO_MODEL = 'text-embedding-nomic-embed-text-v1.5@q4_k_m';
const OPENAI_URL = 'https://api.openai.com/v1/embeddings';
const OPENAI_MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 32;
const MAX_RETRIES = 2;
const INDEX_VERSION = 'v1.1-phase4-complete';

// ===================== CLI parsing =====================

function parseArgs(argv) {
  const args = {
    sources: [],
    chunkSize: DEFAULT_CHUNK_SIZE,
    chunkOverlap: DEFAULT_CHUNK_OVERLAP,
    output: DEFAULT_OUTPUT,
    chunksOutput: DEFAULT_CHUNKS_OUTPUT,
    embeddingModel: DEFAULT_EMBED_MODEL_MODE,
    dryRun: false,
    help: false
  };
  let sourceSet = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source' && argv[i + 1]) {
      args.sources.unshift(argv[++i]);
      sourceSet = true;
    } else if (a === '--include' && argv[i + 1]) {
      args.sources.push(argv[++i]);
    } else if (a === '--chunk-size' && argv[i + 1]) {
      args.chunkSize = parseInt(argv[++i], 10);
    } else if (a === '--chunk-overlap' && argv[i + 1]) {
      args.chunkOverlap = parseInt(argv[++i], 10);
    } else if (a === '--output' && argv[i + 1]) {
      args.output = argv[++i];
    } else if (a === '--chunks-output' && argv[i + 1]) {
      args.chunksOutput = argv[++i];
    } else if (a === '--embedding-model' && argv[i + 1]) {
      args.embeddingModel = argv[++i];
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    }
  }
  if (!sourceSet && args.sources.length === 0) {
    args.sources = [DEFAULT_SOURCE];
  }
  return args;
}

function printHelp() {
  console.log(`Usage: orcai-build-index [options]

Options:
  --source <dir>             Primary source directory (default: ${DEFAULT_SOURCE})
  --include <dir>            Additional source dir (repeatable)
  --chunk-size <N>           Words per chunk (default: ${DEFAULT_CHUNK_SIZE})
  --chunk-overlap <N>        Overlap words between chunks (default: ${DEFAULT_CHUNK_OVERLAP})
  --output <file>            Main index JSON (default: ${DEFAULT_OUTPUT})
  --chunks-output <file>     Per-chunk JSONL (default: ${DEFAULT_CHUNKS_OUTPUT})
  --embedding-model <mode>   'local' (LM Studio) or 'openai' (default: ${DEFAULT_EMBED_MODEL_MODE})
  --dry-run                  Scan + chunk only, skip embedding
  --help                     Show this help
`);
}

// ===================== Helpers =====================

function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i] / norm;
  return vec;
}

function formatMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function formatElapsed(ms) {
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${m}m${rem}s`;
}

// ===================== File walking / filtering =====================

/**
 * Walk dir recursively, return .md files. Skip audit-suffixed artifacts.
 */
function walkMd(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkMd(full, out);
    } else if (e.isFile()) {
      const name = e.name.toLowerCase();
      if (!name.endsWith('.md')) continue;
      // EXCLUDE audit artifacts
      if (name.endsWith('.audit.md')) continue;
      out.push(full);
    }
  }
  return out;
}

// ===================== YAML frontmatter parser (minimal) =====================

/**
 * Parse YAML frontmatter between leading --- fences. Supports scalars, inline
 * arrays [a, b], multi-line lists (- item), nested mappings one level deep.
 * Intentionally forgiving — unknown syntax falls back to raw string.
 */
function parseFrontmatter(content) {
  if (!content.startsWith('---')) {
    return { frontmatter: null, body: content };
  }
  const rest = content.slice(3);
  const endIdx = rest.indexOf('\n---');
  if (endIdx < 0) return { frontmatter: null, body: content };
  const fmRaw = rest.slice(0, endIdx);
  const afterFm = rest.slice(endIdx + 4);
  const body = afterFm.replace(/^\r?\n/, '');

  const obj = {};
  const lines = fmRaw.split(/\r?\n/);
  let currentKey = null;
  let currentList = null;
  let currentMap = null;

  for (const rawLn of lines) {
    const ln = rawLn.replace(/\s+$/, '');
    if (ln.trim() === '') continue;

    // List item continuation: "  - value"
    const listMatch = ln.match(/^\s+-\s+(.*)$/);
    if (listMatch && currentList !== null) {
      currentList.push(parseScalar(listMatch[1]));
      continue;
    }

    // Nested map continuation: "  key: value"
    const nestedMatch = ln.match(/^\s+([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (nestedMatch && currentMap !== null && !ln.match(/^[A-Za-z0-9_\-]+:/)) {
      currentMap[nestedMatch[1]] = parseScalar(nestedMatch[2]);
      continue;
    }

    // Top-level key
    const kvMatch = ln.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const val = kvMatch[2];
      currentKey = key;
      currentList = null;
      currentMap = null;
      if (val === '') {
        // Potentially list or map follows. Default to array; switch to map if
        // next non-list line is nested map — but keep it simple: start empty array.
        obj[key] = [];
        currentList = obj[key];
      } else if (val.startsWith('[') && val.endsWith(']')) {
        // Inline array
        const inner = val.slice(1, -1).trim();
        if (inner === '') {
          obj[key] = [];
        } else {
          obj[key] = inner.split(',').map(s => parseScalar(s.trim()));
        }
      } else {
        obj[key] = parseScalar(val);
      }
    }
  }

  // Normalize: empty arrays that got no children → keep as []
  return { frontmatter: obj, body };
}

function parseScalar(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  // Quoted string
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  // Number (but preserve date-like strings)
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

// ===================== Doc chunking =====================

/**
 * Split body into 500-word chunks with 100-word overlap. Track heading_path
 * by scanning # ## ### as we slide the window.
 *
 * Approach: tokenize the body into (word, heading_path_at_word) pairs by
 * walking line-by-line. Then slide windows over the token array; each chunk's
 * heading_path is the heading_path at the start-of-chunk token.
 */
function chunkDoc(body, chunkSize, overlap) {
  const lines = body.split(/\r?\n/);
  const tokens = []; // array of { word, headingPath }
  const headingStack = []; // [{level, text}, ...]

  for (const ln of lines) {
    const hm = ln.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      const level = hm[1].length;
      const text = hm[2].trim();
      // Pop deeper or equal levels
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, text });
      // Do not emit heading as tokens here; include heading text as tokens too
      // so chunks that cover heading lines keep the heading words for recall.
      const words = ln.trim().split(/\s+/).filter(Boolean);
      const pathSnapshot = headingStack.map(h => h.text);
      for (const w of words) tokens.push({ word: w, headingPath: pathSnapshot });
      continue;
    }
    const words = ln.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const pathSnapshot = headingStack.map(h => h.text);
    for (const w of words) tokens.push({ word: w, headingPath: pathSnapshot });
  }

  if (tokens.length === 0) return [];

  const chunks = [];
  const step = Math.max(1, chunkSize - overlap);
  let idx = 0;
  let chunkIndex = 0;
  while (idx < tokens.length) {
    const end = Math.min(idx + chunkSize, tokens.length);
    const slice = tokens.slice(idx, end);
    const text = slice.map(t => t.word).join(' ');
    const headingPath = slice[0].headingPath.slice();
    chunks.push({
      chunkIndex,
      text,
      headingPath,
      wordCount: slice.length
    });
    chunkIndex++;
    if (end >= tokens.length) break;
    idx += step;
  }
  return chunks;
}

function extractDocTitle(body, fallbackStem) {
  const lines = body.split(/\r?\n/);
  for (const ln of lines) {
    const m = ln.match(/^#\s+(.*)$/);
    if (m) return m[1].trim();
  }
  return fallbackStem;
}

// ===================== Embedding client =====================

async function callLMStudio(inputs) {
  const body = JSON.stringify({ model: LMSTUDIO_MODEL, input: inputs });
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(LMSTUDIO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        lastErr = new Error(`LM Studio HTTP ${res.status}: ${txt.slice(0, 200)}`);
        if (attempt < MAX_RETRIES) {
          await sleep(1000 * Math.pow(2, attempt));
          continue;
        }
        throw lastErr;
      }
      const json = await res.json();
      if (!json.data || !Array.isArray(json.data)) {
        throw new Error('LM Studio response missing data[]');
      }
      return json.data.map(d => d.embedding);
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr || new Error('LM Studio failed');
}

async function callOpenAI(inputs, apiKey) {
  const body = JSON.stringify({ model: OPENAI_MODEL, input: inputs });
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        lastErr = new Error(`OpenAI HTTP ${res.status}: ${txt.slice(0, 200)}`);
        if (attempt < MAX_RETRIES && (res.status === 429 || res.status >= 500)) {
          await sleep(1000 * Math.pow(2, attempt));
          continue;
        }
        throw lastErr;
      }
      const json = await res.json();
      return json.data.map(d => d.embedding);
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr || new Error('OpenAI failed');
}

// ===================== Main =====================

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const t0 = Date.now();
  const repoRoot = process.cwd();

  // Validate sources
  const absSources = [];
  for (const s of args.sources) {
    const abs = path.isAbsolute(s) ? s : path.join(repoRoot, s);
    if (!fs.existsSync(abs)) {
      console.error(`[build-index] source not found: ${s}`);
      process.exit(2);
    }
    absSources.push({ rel: s, abs });
  }

  console.log(`[build-index] sources:`);
  for (const s of absSources) console.log(`  - ${s.rel}`);

  // Scan all md files
  const allFiles = [];
  for (const s of absSources) {
    const files = walkMd(s.abs);
    for (const f of files) allFiles.push(f);
  }
  console.log(`[build-index] scanned ${allFiles.length} .md files (audits excluded)`);

  // Parse + chunk each file
  const docs = [];
  const allChunks = [];
  const warnings = [];

  for (const f of allFiles) {
    let content;
    try {
      content = fs.readFileSync(f, 'utf8');
    } catch (e) {
      warnings.push(`read-fail: ${f} (${e.message})`);
      continue;
    }
    const rel = path.relative(repoRoot, f).replace(/\\/g, '/');
    const stem = path.basename(f, path.extname(f));
    const { frontmatter, body } = parseFrontmatter(content);
    const docTitle = extractDocTitle(body, stem);
    const fileChunks = chunkDoc(body, args.chunkSize, args.chunkOverlap);

    if (fileChunks.length === 0) {
      warnings.push(`empty-body: ${rel}`);
      continue;
    }

    docs.push({ path: rel, chunks: fileChunks.length });

    for (const ch of fileChunks) {
      const id = sha1(`${rel}|${ch.chunkIndex}|${ch.text.slice(0, 64)}`);
      allChunks.push({
        id,
        source_path: rel,
        chunk_index: ch.chunkIndex,
        text: ch.text,
        metadata: {
          source_path: rel,
          doc_title: docTitle,
          heading_path: ch.headingPath,
          chunk_index: ch.chunkIndex,
          word_count: ch.wordCount,
          frontmatter: frontmatter || null
        }
      });
    }
  }

  console.log(`[build-index] docs indexed: ${docs.length}, total chunks: ${allChunks.length}`);

  if (args.dryRun) {
    const approxTokens = allChunks.reduce((s, c) => s + c.metadata.word_count, 0) / 0.75;
    console.log(`[build-index] DRY RUN — skipping embedding`);
    console.log(`[build-index] approx tokens: ${Math.round(approxTokens).toLocaleString()}`);
    if (warnings.length) {
      console.log(`[build-index] warnings (${warnings.length}):`);
      for (const w of warnings.slice(0, 10)) console.log(`  ! ${w}`);
    }
    return;
  }

  if (allChunks.length === 0) {
    console.error(`[build-index] no chunks — aborting`);
    process.exit(2);
  }

  // Embedding
  let embedModelName = LMSTUDIO_MODEL;
  let embedBackend = 'local';
  let fallbackTriggered = false;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (args.embeddingModel === 'openai') {
    if (!openaiKey) {
      console.error(`[build-index] --embedding-model openai requires OPENAI_API_KEY`);
      process.exit(2);
    }
    embedBackend = 'openai';
    embedModelName = OPENAI_MODEL;
  }

  // Probe the chosen backend with a 1-input call to decide fallback early.
  const vectors = new Array(allChunks.length);
  let embedded = 0;
  const tEmbed0 = Date.now();

  async function embedBatch(inputs) {
    if (embedBackend === 'local') {
      try {
        return await callLMStudio(inputs);
      } catch (e) {
        console.warn(`[build-index] LM Studio failed: ${e.message}`);
        if (openaiKey) {
          console.warn(`[build-index] falling back to OpenAI text-embedding-3-small`);
          embedBackend = 'openai';
          embedModelName = OPENAI_MODEL;
          fallbackTriggered = true;
          return await callOpenAI(inputs, openaiKey);
        }
        throw new Error(
          `LM Studio unreachable and OPENAI_API_KEY not set. ` +
            `Start LM Studio server with ${LMSTUDIO_MODEL} loaded, ` +
            `or export OPENAI_API_KEY=sk-... to use cloud fallback.`
        );
      }
    } else {
      return await callOpenAI(inputs, openaiKey);
    }
  }

  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const inputs = batch.map(c => c.text);
    const embs = await embedBatch(inputs);
    if (embs.length !== batch.length) {
      throw new Error(`batch size mismatch: expected ${batch.length} got ${embs.length}`);
    }
    for (let j = 0; j < batch.length; j++) {
      vectors[i + j] = normalize(embs[j].slice());
    }
    embedded += batch.length;
    if (embedded % 50 < BATCH_SIZE || embedded === allChunks.length) {
      const elapsed = ((Date.now() - tEmbed0) / 1000).toFixed(1);
      console.log(
        `[embed] ${embedded}/${allChunks.length} chunks done (model=${embedModelName}, elapsed=${elapsed}s)`
      );
    }
  }

  const embeddingDim = vectors[0].length;

  // Write index JSON
  const outAbs = path.isAbsolute(args.output) ? args.output : path.join(repoRoot, args.output);
  const chunksOutAbs = path.isAbsolute(args.chunksOutput)
    ? args.chunksOutput
    : path.join(repoRoot, args.chunksOutput);

  const outDir = path.dirname(outAbs);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const chunksDir = path.dirname(chunksOutAbs);
  if (!fs.existsSync(chunksDir)) fs.mkdirSync(chunksDir, { recursive: true });

  const indexObj = {
    version: INDEX_VERSION,
    built_at: new Date().toISOString(),
    embedding_model: embedModelName,
    embedding_backend: embedBackend,
    embedding_dim: embeddingDim,
    total_chunks: allChunks.length,
    total_docs: docs.length,
    chunk_size_words: args.chunkSize,
    chunk_overlap_words: args.chunkOverlap,
    sources: absSources.map(s => s.rel),
    fallback_triggered: fallbackTriggered,
    chunks: allChunks.map((c, i) => ({
      id: c.id,
      source_path: c.source_path,
      chunk_index: c.chunk_index,
      embedding: Array.from(vectors[i]),
      metadata: c.metadata
    }))
  };

  const tmpIdx = `${outAbs}.tmp.${process.pid}`;
  fs.writeFileSync(tmpIdx, JSON.stringify(indexObj), 'utf8');
  fs.renameSync(tmpIdx, outAbs);

  // Write JSONL chunks (no embeddings)
  const tmpChunks = `${chunksOutAbs}.tmp.${process.pid}`;
  const ws = fs.createWriteStream(tmpChunks, { encoding: 'utf8' });
  for (const c of allChunks) {
    const line = JSON.stringify({
      id: c.id,
      text: c.text,
      metadata: c.metadata,
      embedding_ref: c.id
    });
    ws.write(line + '\n');
  }
  await new Promise((resolve, reject) => {
    ws.end(err => (err ? reject(err) : resolve()));
  });
  fs.renameSync(tmpChunks, chunksOutAbs);

  // Report
  const totalWords = allChunks.reduce((s, c) => s + c.metadata.word_count, 0);
  const approxTokens = Math.round(totalWords / 0.75);
  const idxSize = fs.statSync(outAbs).size;
  const chunksSize = fs.statSync(chunksOutAbs).size;
  const wall = Date.now() - t0;

  console.log('');
  console.log('============================================================');
  console.log('[build-index] DONE');
  console.log('============================================================');
  console.log(`  docs scanned:         ${docs.length}`);
  console.log(`  chunks emitted:       ${allChunks.length}`);
  console.log(`  total words:          ${totalWords.toLocaleString()}`);
  console.log(`  approx tokens:        ${approxTokens.toLocaleString()} (1 tok ~ 0.75 words)`);
  console.log(`  embedding model:      ${embedModelName}`);
  console.log(`  embedding backend:    ${embedBackend}${fallbackTriggered ? ' (fallback!)' : ''}`);
  console.log(`  embedding dim:        ${embeddingDim}`);
  console.log(`  chunk size / overlap: ${args.chunkSize} / ${args.chunkOverlap} words`);
  console.log(`  index file:           ${path.relative(repoRoot, outAbs).replace(/\\/g, '/')} (${formatMB(idxSize)})`);
  console.log(`  chunks file:          ${path.relative(repoRoot, chunksOutAbs).replace(/\\/g, '/')} (${formatMB(chunksSize)})`);
  console.log(`  wall time:            ${formatElapsed(wall)}`);
  if (warnings.length) {
    console.log(`  warnings:             ${warnings.length}`);
    for (const w of warnings.slice(0, 10)) console.log(`    ! ${w}`);
  }
  console.log('============================================================');

  // Sample random chunk for sanity check
  const sampleIdx = Math.floor(Math.random() * allChunks.length);
  const sample = allChunks[sampleIdx];
  console.log('');
  console.log(`[build-index] Sample chunk (index=${sampleIdx}):`);
  console.log(`  id:            ${sample.id}`);
  console.log(`  source_path:   ${sample.source_path}`);
  console.log(`  chunk_index:   ${sample.chunk_index}`);
  console.log(`  doc_title:     ${sample.metadata.doc_title}`);
  console.log(`  heading_path:  ${JSON.stringify(sample.metadata.heading_path)}`);
  console.log(`  word_count:    ${sample.metadata.word_count}`);
  console.log(`  frontmatter:   ${JSON.stringify(sample.metadata.frontmatter, null, 2).split('\n').map((l, i) => i === 0 ? l : '                 ' + l).join('\n')}`);
  console.log(`  text (first 200 chars): ${sample.text.slice(0, 200)}${sample.text.length > 200 ? '...' : ''}`);
}

if (require.main === module) {
  main().catch(e => {
    console.error('[build-index] error:', e.message);
    console.error(e.stack);
    process.exit(1);
  });
}

module.exports = { main, chunkDoc, parseFrontmatter, walkMd };
