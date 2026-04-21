#!/usr/bin/env node
/**
 * CLI: index cac file code chat luong tot trong project → few-shot cho local model
 *
 * Chien luoc chunking:
 * - Scan .js .ts .py (skip test, node_modules, dist, build, .git, .orcai)
 * - Bo file > 500 lines (thuong la generated/bundle)
 * - Chunk theo top-level function/class declaration, max 50 lines/chunk
 * - Embed batch qua embedMany(), luu shape tuong thich EmbeddingStore
 *
 * Output: .orcai/embeddings/examples.index.json
 *
 * Usage:
 *   node bin/orcai-index-examples.js [--root <dir>] [--out <file>]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EmbeddingStore } = require('../lib/embeddings');

const DEFAULT_EXTS = new Set(['.js', '.ts', '.py']);
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.orcai', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '__pycache__', '.venv', 'venv', 'out', '.turbo', '.cache'
]);
const MAX_LINES_FILE = 500;
const MAX_LINES_CHUNK = 50;

function parseArgs(argv) {
  const out = { root: null, out: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' && argv[i + 1]) out.root = argv[++i];
    else if (a === '--out' && argv[i + 1]) out.out = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function isTestFile(file) {
  const lower = file.toLowerCase();
  return /\.(test|spec|e2e)\.(js|ts|py)$/.test(lower) ||
         /\/tests?\//.test(lower.replace(/\\/g, '/'));
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (!DEFAULT_EXTS.has(ext)) continue;
      if (isTestFile(full)) continue;
      out.push(full);
    }
  }
  return out;
}

/**
 * Phan doan theo declaration top-level. Moi khi gap function/class moi o
 * cot 0 → flush chunk cu (neu dat min size) va bat dau chunk moi.
 * Chunks khong vuot qua MAX_LINES_CHUNK.
 */
function chunkCode(content, ext) {
  const lines = content.split(/\r?\n/);
  const chunks = [];
  let current = [];
  let currentStart = 0;

  const isDecl = (ln) => {
    if (ext === '.py') {
      return /^(def |class |async def )/.test(ln);
    }
    // JS/TS top-level
    return /^(export\s+)?(async\s+)?(function|class)\s+\w/.test(ln) ||
           /^(export\s+)?const\s+\w+\s*=\s*(async\s*)?\(/.test(ln) ||
           /^(export\s+)?(default\s+)?(async\s+)?function/.test(ln);
  };

  const flush = (endLine) => {
    if (current.length === 0) return;
    // Bo chunk qua nho (< 3 dong co y nghia)
    const nonEmpty = current.filter(l => l.trim().length > 0).length;
    if (nonEmpty >= 3) {
      chunks.push({
        code: current.join('\n'),
        startLine: currentStart + 1,
        endLine: endLine + 1
      });
    }
    current = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (isDecl(ln) && current.length > 0) {
      flush(i - 1);
      currentStart = i;
    }
    if (current.length === 0) currentStart = i;
    current.push(ln);
    if (current.length >= MAX_LINES_CHUNK) {
      flush(i);
      currentStart = i + 1;
    }
  }
  flush(lines.length - 1);
  return chunks;
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i] / norm;
  return vec;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: orcai-index-examples [--root <dir>] [--out <file>]');
    process.exit(0);
  }

  const root = args.root || process.cwd();
  const outFile = args.out || path.join(root, '.orcai', 'embeddings', 'examples.index.json');

  if (!fs.existsSync(root)) {
    console.error(`[index-examples] root not found: ${root}`);
    process.exit(2);
  }

  console.log(`[index-examples] scanning: ${root}`);
  const t0 = Date.now();
  const files = walk(root);
  console.log(`[index-examples] candidate files: ${files.length}`);

  const chunks = [];
  let skippedLarge = 0;
  for (const f of files) {
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const lineCount = content.split(/\r?\n/).length;
    if (lineCount > MAX_LINES_FILE) { skippedLarge++; continue; }
    const rel = path.relative(root, f).replace(/\\/g, '/');
    const ext = path.extname(f).toLowerCase();
    const fchunks = chunkCode(content, ext);
    for (let i = 0; i < fchunks.length; i++) {
      const c = fchunks[i];
      chunks.push({
        id: sha256(`${rel}|${i}|${c.startLine}`),
        text: c.code,
        metadata: {
          file: rel,
          chunkIndex: i,
          startLine: c.startLine,
          endLine: c.endLine,
          lang: ext.slice(1)
        }
      });
    }
  }

  console.log(`[index-examples] chunks extracted: ${chunks.length} (skipped ${skippedLarge} large files)`);

  if (chunks.length === 0) {
    console.log('[index-examples] nothing to index');
    process.exit(0);
  }

  const storeOpts = { projectDir: root };
  // Khi goi tu LocalAssistant: dung LM Studio truc tiep thay vi LiteLLM
  if (process.env.LMSTUDIO_EMBED_ENDPOINT) storeOpts.endpoint = process.env.LMSTUDIO_EMBED_ENDPOINT;
  if (process.env.EMBED_MODEL) storeOpts.model = process.env.EMBED_MODEL;
  const store = new EmbeddingStore(storeOpts);
  console.log(`[index-examples] embedding via ${store.model} @ ${store.endpoint}`);

  const items = [];
  const BATCH = 50;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const vecs = await store.embedMany(batch.map(c => c.text));
    for (let j = 0; j < batch.length; j++) {
      const c = batch[j];
      items.push({
        id: c.id,
        text: c.text,
        vector: normalize(vecs[j].slice()),
        metadata: c.metadata,
        updated: new Date().toISOString()
      });
    }
    process.stdout.write(`\r[index-examples] embedded ${Math.min(i + BATCH, chunks.length)}/${chunks.length}`);
  }
  process.stdout.write('\n');

  const outDir = path.dirname(outFile);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const data = {
    model: store.model,
    dim: items[0]?.vector?.length || store.dim,
    items,
    generatedAt: new Date().toISOString(),
    root
  };
  const tmp = `${outFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, outFile);

  const ms = Date.now() - t0;
  const sizeKb = Math.round(fs.statSync(outFile).size / 1024);
  console.log(`[index-examples] done: ${items.length} chunks in ${ms}ms (${sizeKb} KB)`);
  console.log(`[index-examples] out: ${outFile}`);
}

if (require.main === module) {
  main().catch(e => {
    console.error('[index-examples] error:', e.message);
    process.exit(1);
  });
}

module.exports = { main, chunkCode, walk };
