#!/usr/bin/env node
/**
 * Trust Graph Watcher (Docker version)
 * Projects mounted at /projects/{name}
 */

const { TrustGraph } = require('./trust-graph');
const fs = require('fs');
const path = require('path');

const PROJECTS = {
  FashionEcom: '/projects/FashionEcom',
  VietNet2026: '/projects/VietNet2026',
  LeQuyDon: '/projects/LeQuyDon',
  WebPhoto: '/projects/WebPhoto',
  RemoteTerminal: '/projects/RemoteTerminal',
};

const OUTPUT_DIR = '/app/data/graphs';
const WATCH_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.vue'];
const IGNORE_DIRS = ['node_modules', '.next', 'dist', '.git'];
const DEBOUNCE_MS = 5000;
const CRON_INTERVAL = 30 * 60 * 1000;

const pendingReindex = new Map();
const graphs = new Map();

function watchProject(name, dir) {
  console.log(`👁️  Watching ${name}`);
  try {
    fs.watch(dir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const ext = path.extname(filename);
      if (!WATCH_EXTENSIONS.includes(ext)) return;
      if (IGNORE_DIRS.some(d => filename.includes(d))) return;

      if (pendingReindex.has(name)) clearTimeout(pendingReindex.get(name));
      pendingReindex.set(name, setTimeout(() => {
        pendingReindex.delete(name);
        reindexProject(name, dir);
      }, DEBOUNCE_MS));
    });
  } catch (err) {
    console.log(`⚠️  Cannot watch ${name}: ${err.message}`);
  }
}

async function reindexProject(name, dir) {
  const start = Date.now();
  try {
    const graph = new TrustGraph(dir);
    await graph.index();
    graphs.set(name, graph);

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(OUTPUT_DIR, `${name}.json`),
      JSON.stringify(graph.toJSON(), null, 2)
    );

    const stats = graph.getStats();
    console.log(`✅ ${name}: ${stats.totalFiles} files, ${stats.totalEdges} edges (${Date.now() - start}ms)`);
  } catch (err) {
    console.log(`❌ ${name}: ${err.message}`);
  }
}

async function main() {
  console.log('=== Trust Graph Watcher (Docker) ===\n');

  for (const [name, dir] of Object.entries(PROJECTS)) {
    if (fs.existsSync(dir)) {
      await reindexProject(name, dir);
      watchProject(name, dir);
    } else {
      console.log(`⏭️  ${name}: not mounted`);
    }
  }

  setInterval(async () => {
    console.log(`\n⏰ Cron re-index: ${new Date().toISOString()}`);
    for (const [name, dir] of Object.entries(PROJECTS)) {
      if (fs.existsSync(dir)) await reindexProject(name, dir);
    }
  }, CRON_INTERVAL);

  console.log(`\n✅ Watcher running. Re-index: on file change + every 30min.`);
}

main().catch(console.error);
