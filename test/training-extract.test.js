#!/usr/bin/env node
/**
 * Test cho orcai-extract-training-data:
 *  - tao fake project trong tmp (3 commits + 1 transcript + 1 JSDoc function)
 *  - chay extractor -> check classifier/style/metadata
 *  - check dedupe
 *  - check validate subcommand
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const mod = require('../bin/orcai-extract-training-data');

let passed = 0, failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { console.log(`  [OK] ${name}`); passed++; }
  else { console.log(`  [FAIL] ${name}${detail ? ' - ' + detail : ''}`); failed++; }
}

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
}

function setupFakeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orcai-train-'));
  const proj = path.join(root, 'FakeProj');
  fs.mkdirSync(proj, { recursive: true });

  // git init
  sh(proj, ['init', '-q']);
  sh(proj, ['config', 'user.email', 'test@test']);
  sh(proj, ['config', 'user.name', 'Test']);
  sh(proj, ['config', 'commit.gpgsign', 'false']);

  // file 1 + commit 1 (build)
  fs.writeFileSync(path.join(proj, 'app.js'), `
/**
 * Greet a user by name.
 */
function greet(name) {
  return 'Hello ' + name;
}
module.exports = { greet };
`);
  sh(proj, ['add', '-A']);
  sh(proj, ['commit', '-q', '-m', 'feat(app): add greet function']);

  // commit 2 (fix)
  fs.writeFileSync(path.join(proj, 'app.js'), `
/**
 * Greet a user by name safely.
 */
function greet(name) {
  if (!name) return 'Hello stranger';
  return 'Hello ' + String(name);
}
module.exports = { greet };
`);
  sh(proj, ['add', '-A']);
  sh(proj, ['commit', '-q', '-m', 'fix(app): handle empty name']);

  // commit 3 (refactor)
  fs.writeFileSync(path.join(proj, 'app.js'), `
/**
 * Greet a user by name safely.
 */
const greet = (name) => {
  const n = name ? String(name) : 'stranger';
  return 'Hello ' + n;
};
module.exports = { greet };
`);
  sh(proj, ['add', '-A']);
  sh(proj, ['commit', '-q', '-m', 'refactor(app): use arrow function']);

  // transcript under .claude-shared/projects/FakeProj/
  const transDir = path.join(root, '.claude-shared', 'projects', 'FakeProj');
  fs.mkdirSync(transDir, { recursive: true });
  fs.writeFileSync(path.join(transDir, 'chat.md'), `
## User
fix bug in greet returning undefined

## Assistant
\`\`\`js
function greet(name) {
  if (!name) return 'Hello stranger';
  return 'Hello ' + name;
}
\`\`\`

## User
add logging support

## Assistant
\`\`\`js
const log = (msg) => console.log('[app]', msg);
module.exports = { log };
\`\`\`
`);

  return { root, proj };
}

(async () => {
  const { root, proj } = setupFakeRoot();
  const out = path.join(root, '_out');

  console.log('\n=== extract on fake project ===');
  const r = mod.runExtract({ root, outDir: out, kind: 'both', limit: 100 });
  assert('metadata.totalPairs > 0', r.metadata.totalPairs > 0, String(r.metadata.totalPairs));
  assert('classifier file exists', fs.existsSync(r.classPath));
  assert('style file exists', fs.existsSync(r.stylePath));
  assert('metadata.json exists', fs.existsSync(r.metaPath));

  const classLines = fs.readFileSync(r.classPath, 'utf8').split('\n').filter(Boolean);
  const styleLines = fs.readFileSync(r.stylePath, 'utf8').split('\n').filter(Boolean);
  assert('>= 3 classifier pairs', classLines.length >= 3, 'got ' + classLines.length);
  assert('>= 1 style pair', styleLines.length >= 1, 'got ' + styleLines.length);

  // check labels
  const labels = classLines.map(l => JSON.parse(l).messages[1].content);
  assert('has build label', labels.includes('build'));
  assert('has fix label', labels.includes('fix'));
  assert('has refactor label', labels.includes('refactor'));

  // check style completion non-empty + looks like code
  const firstStyle = JSON.parse(styleLines[0]);
  assert('style completion non-empty', firstStyle.messages[1].content.length >= 20);

  // check metadata fields
  const meta = JSON.parse(fs.readFileSync(r.metaPath, 'utf8'));
  const needKeys = ['totalPairs', 'byCategory', 'bySource', 'bySize', 'generatedAt'];
  assert('metadata has all fields', needKeys.every(k => k in meta), Object.keys(meta).join(','));

  // === dedupe ===
  console.log('\n=== dedupe ===');
  const input = [
    { prompt: 'add greet', completion: 'function greet(){}', source: 'git' },
    { prompt: 'add greet', completion: 'function greet(){}', source: 'git' },
    { prompt: 'fix bug', completion: 'return null;', source: 'git' },
  ];
  const deduped = mod.dedupe(input);
  assert('dedupe collapses duplicate', deduped.length === 2, 'got ' + deduped.length);

  // === validate subcommand ===
  console.log('\n=== validate ===');
  const res = mod.runValidate({ file: r.classPath });
  assert('validate returns valid>0', res.valid > 0);
  assert('validate zero errors', res.errors === 0);

  // === label heuristic spot checks ===
  console.log('\n=== label heuristic ===');
  assert('fix: ... -> fix', mod.labelFromSubject('fix: X') === 'fix');
  assert('feat: ... -> build', mod.labelFromSubject('feat: add X') === 'build');
  assert('refactor: ... -> refactor', mod.labelFromSubject('refactor: rename') === 'refactor');
  assert('merge commit skipped', mod.isMergeCommit('Merge branch main'));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
