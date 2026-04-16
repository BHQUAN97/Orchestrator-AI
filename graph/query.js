#!/usr/bin/env node
/**
 * Query Trust Graph — Tim files lien quan den 1 file
 * Chay: node query.js FashionEcom src/services/upload.service.ts
 */

const { TrustGraph } = require('./trust-graph');
const path = require('path');

const projectName = process.argv[2];
const entryFile = process.argv[3];
const maxFiles = parseInt(process.argv[4]) || 15;

if (!projectName || !entryFile) {
  console.log('Usage: node query.js <project> <file> [maxFiles]');
  console.log('Example: node query.js FashionEcom src/services/auth.service.ts 15');
  process.exit(1);
}

const PROJECTS = {
  FashionEcom: 'E:/DEVELOP/FashionEcom',
  VietNet2026: 'E:/DEVELOP/VietNet2026',
  LeQuyDon: 'E:/DEVELOP/LeQuyDon',
  WebPhoto: 'E:/DEVELOP/WebPhoto',
  RemoteTerminal: 'E:/DEVELOP/RemoteTerminal',
};

const projectDir = PROJECTS[projectName];
if (!projectDir) {
  console.log(`Project "${projectName}" not found. Available: ${Object.keys(PROJECTS).join(', ')}`);
  process.exit(1);
}

async function main() {
  console.log(`\nQuery Trust Graph: ${projectName} / ${entryFile}\n`);

  const graph = new TrustGraph(projectDir, { maxFiles });
  await graph.index();

  const relevant = graph.getRelevantFiles(entryFile, maxFiles);

  console.log(`Found ${relevant.length} relevant files (of ${graph.getStats().totalFiles} total):\n`);
  console.log('Score  Lines  File');
  console.log('─────  ─────  ────');

  for (const item of relevant) {
    const score = item.score.toFixed(2).padStart(5);
    const lines = String(item.lines || '?').padStart(5);
    console.log(`${score}  ${lines}  ${item.file}`);
  }

  // Build context
  const ctx = graph.buildContext(entryFile, maxFiles);
  console.log(`\nContext: ${ctx.files} files, ${ctx.totalSizeKB}KB`);
  console.log(`Reduction: ${ctx.reduction}% (${ctx.files}/${ctx.totalFiles} files)`);
}

main().catch(console.error);
