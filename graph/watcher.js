#!/usr/bin/env node
/**
 * Trust Graph Watcher — Tu dong re-index khi files thay doi
 * Chay: node watcher.js
 *
 * Strategies:
 * 1. fs.watch — realtime, nhe
 * 2. Git diff — chi index files thay doi tu lan cuoi
 * 3. Cron — re-index toan bo moi 30 phut
 */

const { TrustGraph } = require('./trust-graph');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECTS = {
  FashionEcom: 'E:/DEVELOP/FashionEcom',
  VietNet2026: 'E:/DEVELOP/VietNet2026',
  LeQuyDon: 'E:/DEVELOP/LeQuyDon',
  WebPhoto: 'E:/DEVELOP/WebPhoto',
  RemoteTerminal: 'E:/DEVELOP/RemoteTerminal',
};

const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'graphs');
const WATCH_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.vue'];
const IGNORE_DIRS = ['node_modules', '.next', 'dist', '.git', '__pycache__'];

// Debounce re-index (khong index lien tuc khi nhieu file thay doi)
const DEBOUNCE_MS = 5000; // 5 giay
const pendingReindex = new Map(); // project → timeout

// Graphs cache
const graphs = new Map();

// === Strategy 1: File System Watch ===
function watchProject(name, dir) {
  console.log(`👁️  Watching ${name}: ${dir}`);

  try {
    fs.watch(dir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;

      // Chi quan tam source files
      const ext = path.extname(filename);
      if (!WATCH_EXTENSIONS.includes(ext)) return;

      // Skip ignored dirs
      if (IGNORE_DIRS.some(d => filename.includes(d))) return;

      // Debounce
      if (pendingReindex.has(name)) {
        clearTimeout(pendingReindex.get(name));
      }

      pendingReindex.set(name, setTimeout(async () => {
        pendingReindex.delete(name);
        await reindexProject(name, dir);
      }, DEBOUNCE_MS));
    });
  } catch (err) {
    console.log(`⚠️  Cannot watch ${name}: ${err.message}`);
  }
}

// === Strategy 2: Git-based diff index ===
function getChangedFiles(dir) {
  try {
    const result = execSync('git diff --name-only HEAD~1', {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 5000
    });
    return result.trim().split('\n').filter(f =>
      WATCH_EXTENSIONS.some(ext => f.endsWith(ext))
    );
  } catch {
    return [];
  }
}

// === Re-index ===
async function reindexProject(name, dir) {
  const start = Date.now();
  console.log(`🔄 Re-indexing ${name}...`);

  try {
    const graph = new TrustGraph(dir);
    await graph.index();
    graphs.set(name, graph);

    // Save
    const outputPath = path.join(OUTPUT_DIR, `${name}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(graph.toJSON(), null, 2));

    const stats = graph.getStats();
    const elapsed = Date.now() - start;
    console.log(`✅ ${name}: ${stats.totalFiles} files, ${stats.totalEdges} edges (${elapsed}ms)`);
  } catch (err) {
    console.log(`❌ ${name}: ${err.message}`);
  }
}

// === Cron: full re-index moi 30 phut ===
const CRON_INTERVAL = 30 * 60 * 1000;

async function cronReindex() {
  console.log(`\n⏰ Cron re-index: ${new Date().toLocaleTimeString()}`);
  for (const [name, dir] of Object.entries(PROJECTS)) {
    if (fs.existsSync(dir)) {
      await reindexProject(name, dir);
    }
  }
}

// === Query helper (cho external tools) ===
function queryRelevant(projectName, entryFile, maxFiles = 15) {
  const graph = graphs.get(projectName);
  if (!graph) {
    console.log(`Graph for ${projectName} not loaded. Run reindex first.`);
    return [];
  }
  return graph.getRelevantFiles(entryFile, maxFiles);
}

// === Main ===
async function main() {
  console.log('=== Trust Graph Watcher ===');
  console.log(`Projects: ${Object.keys(PROJECTS).join(', ')}`);
  console.log(`Debounce: ${DEBOUNCE_MS}ms`);
  console.log(`Cron: every ${CRON_INTERVAL / 1000 / 60} minutes\n`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Initial index
  for (const [name, dir] of Object.entries(PROJECTS)) {
    if (fs.existsSync(dir)) {
      await reindexProject(name, dir);
      watchProject(name, dir);
    } else {
      console.log(`⏭️  ${name}: not found`);
    }
  }

  // Start cron
  setInterval(cronReindex, CRON_INTERVAL);

  console.log(`\n✅ Watcher running. Press Ctrl+C to stop.`);
}

main().catch(console.error);

module.exports = { queryRelevant, graphs };
