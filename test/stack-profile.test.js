#!/usr/bin/env node
/**
 * Test stack-profile.js — scanProject, aggregate, markdown size
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  scanProject,
  aggregateProfiles,
  formatAsMarkdown
} = require('../lib/stack-profile');

let passed = 0;
let failed = 0;

function assert(name, cond, detail = '') {
  if (cond) { console.log(`  OK  ${name}`); passed++; }
  else { console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`); failed++; }
}

console.log('=== stack-profile tests ===\n');

// === 1. scanProject on ai-orchestrator itself ===
console.log('Test 1: scanProject(ai-orchestrator)');
const selfDir = path.resolve(__dirname, '..');
const self = scanProject(selfDir);

assert('languages includes javascript', self.languages.includes('javascript'));
assert('frameworks excludes react', !self.frameworks.includes('react'));
assert('frameworks excludes nextjs', !self.frameworks.includes('nextjs'));
assert('packageManager is npm (package-lock.json present)',
  self.packageManager === 'npm',
  `got ${self.packageManager}`);
// testing: repo co test script custom -> 'node' hoac null
assert('testing detected (some runner or node)',
  self.testing === null || typeof self.testing === 'string',
  `got ${self.testing}`);
assert('dockerUse true (has docker-compose.yaml)',
  self.dockerUse === true,
  `got ${self.dockerUse}`);

// === 2. aggregateProfiles — majority wins ===
console.log('\nTest 2: aggregateProfiles majority wins');
const fake1 = {
  languages: ['javascript', 'typescript'],
  frameworks: ['nextjs', 'tailwind'],
  testing: 'jest',
  packageManager: 'pnpm',
  tsJs: 'ts',
  nextRouter: 'app',
  ormOrDriver: ['prisma'],
  lintFormatter: ['eslint', 'prettier'],
  dockerUse: true,
  pm2Use: false,
  customRules: true
};
const fake2 = {
  languages: ['javascript'],
  frameworks: ['nextjs'],
  testing: 'jest',
  packageManager: 'pnpm',
  tsJs: 'ts',
  nextRouter: 'app',
  ormOrDriver: ['prisma', 'redis'],
  lintFormatter: ['eslint'],
  dockerUse: true,
  pm2Use: true,
  customRules: true
};
const fake3 = {
  languages: ['python'],
  frameworks: ['fastapi'],
  testing: 'pytest',
  packageManager: null,
  tsJs: null,
  nextRouter: null,
  ormOrDriver: ['sqlalchemy'],
  lintFormatter: ['ruff'],
  dockerUse: false,
  pm2Use: false,
  customRules: false
};

const agg = aggregateProfiles([fake1, fake2, fake3]);
assert('totalProjects = 3', agg.totalProjects === 3, `got ${agg.totalProjects}`);
assert('majority.language = javascript',
  agg.majority.language === 'javascript',
  `got ${agg.majority.language}`);
assert('majority.framework = nextjs',
  agg.majority.framework === 'nextjs',
  `got ${agg.majority.framework}`);
assert('majority.testing = jest',
  agg.majority.testing === 'jest',
  `got ${agg.majority.testing}`);
assert('majority.orm = prisma',
  agg.majority.orm === 'prisma',
  `got ${agg.majority.orm}`);
assert('dockerUse count = 2', agg.dockerUse === 2, `got ${agg.dockerUse}`);
assert('pm2Use count = 1', agg.pm2Use === 1, `got ${agg.pm2Use}`);

// === 3. formatAsMarkdown size ===
console.log('\nTest 3: formatAsMarkdown size under budget');
const md = formatAsMarkdown(agg);
assert('markdown is string', typeof md === 'string');
assert('markdown non-empty', md.length > 100, `len=${md.length}`);
assert('markdown <= 8000 chars (~2000 tokens)',
  md.length <= 8000,
  `len=${md.length}`);
assert('markdown contains "Typical Stack"',
  md.includes('Typical Stack'),
  'section missing');
assert('markdown mentions nextjs', /nextjs/i.test(md));
assert('markdown mentions commit style', /type\(scope\)/.test(md));

// === 4. scanProject on empty temp dir ===
console.log('\nTest 4: scanProject on empty dir');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-test-'));
const empty = scanProject(tmp);
assert('empty dir: no languages', empty.languages.length === 0);
assert('empty dir: no frameworks', empty.frameworks.length === 0);
assert('empty dir: testing null', empty.testing === null);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

// === Summary ===
console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
