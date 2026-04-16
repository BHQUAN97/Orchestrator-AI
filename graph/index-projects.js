#!/usr/bin/env node
/**
 * Index tat ca projects vao Trust Graph
 * Chay: node index-projects.js
 *
 * Output: data/graphs/{project}.json
 */

const { TrustGraph } = require('./trust-graph');
const fs = require('fs');
const path = require('path');

const PROJECTS = [
  { name: 'FashionEcom', dir: 'E:/DEVELOP/FashionEcom' },
  { name: 'VietNet2026', dir: 'E:/DEVELOP/VietNet2026' },
  { name: 'LeQuyDon', dir: 'E:/DEVELOP/LeQuyDon' },
  { name: 'WebPhoto', dir: 'E:/DEVELOP/WebPhoto' },
  { name: 'RemoteTerminal', dir: 'E:/DEVELOP/RemoteTerminal' },
];

const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'graphs');

async function main() {
  // Tao output directory
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('=== Trust Graph Indexer ===\n');

  for (const project of PROJECTS) {
    if (!fs.existsSync(project.dir)) {
      console.log(`⏭️  ${project.name}: directory not found, skip`);
      continue;
    }

    console.log(`📊 Indexing ${project.name}...`);
    const graph = new TrustGraph(project.dir);
    await graph.index();

    const stats = graph.getStats();
    console.log(`   Files: ${stats.totalFiles}, Edges: ${stats.totalEdges}, Size: ${stats.totalSizeKB}KB`);

    // Save graph JSON
    const outputPath = path.join(OUTPUT_DIR, `${project.name}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(graph.toJSON(), null, 2));
    console.log(`   Saved: ${outputPath}\n`);
  }

  console.log('=== Done ===');
}

main().catch(console.error);
