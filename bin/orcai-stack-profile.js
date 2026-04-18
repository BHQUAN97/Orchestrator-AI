#!/usr/bin/env node
/**
 * CLI: quet E:\DEVELOP (hoac root tuy chon), sinh .orcai/stack-profile.md
 *
 * Usage:
 *   node bin/orcai-stack-profile.js [--root <dir>] [--out <file>]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  scanProjectsRoot,
  aggregateProfiles,
  formatAsMarkdown
} = require('../lib/stack-profile');

function parseArgs(argv) {
  const args = { root: null, out: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' && argv[i + 1]) { args.root = argv[++i]; }
    else if (a === '--out' && argv[i + 1]) { args.out = argv[++i]; }
    else if (a === '--help' || a === '-h') { args.help = true; }
  }
  return args;
}

function defaultRoot() {
  if (process.platform === 'win32') return 'E:\\DEVELOP';
  return path.join(os.homedir(), 'dev');
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: orcai-stack-profile [--root <dir>] [--out <file>]');
    process.exit(0);
  }

  const root = args.root || defaultRoot();
  const cwd = process.cwd();
  const outMd = args.out || path.join(cwd, '.orcai', 'stack-profile.md');
  const outJson = path.join(path.dirname(outMd), 'stack-profile.json');

  if (!fs.existsSync(root)) {
    console.error(`[stack-profile] Root not found: ${root}`);
    process.exit(2);
  }

  console.log(`[stack-profile] Scanning: ${root}`);
  const t0 = Date.now();
  const profiles = scanProjectsRoot(root);
  const agg = aggregateProfiles(profiles);
  const md = formatAsMarkdown(agg);
  const ms = Date.now() - t0;

  fs.mkdirSync(path.dirname(outMd), { recursive: true });
  fs.writeFileSync(outMd, md, 'utf-8');
  fs.writeFileSync(outJson, JSON.stringify({
    generatedAt: new Date().toISOString(),
    root,
    profiles,
    aggregated: agg
  }, null, 2), 'utf-8');

  console.log(`[stack-profile] Done in ${ms}ms`);
  console.log(`[stack-profile] Projects: ${profiles.length}`);
  console.log(`[stack-profile] Markdown: ${outMd} (${md.length} chars)`);
  console.log(`[stack-profile] JSON:     ${outJson}`);
  const majority = agg.majority || {};
  console.log(`[stack-profile] Majority: lang=${majority.language} fw=${majority.framework} pm=${majority.packageManager} test=${majority.testing}`);
}

if (require.main === module) {
  try { main(); }
  catch (e) {
    console.error('[stack-profile] Error:', e.message);
    process.exit(1);
  }
}

module.exports = { main };
