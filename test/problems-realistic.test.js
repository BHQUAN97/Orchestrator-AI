#!/usr/bin/env node
// Kiem tra tinh hop le cua PROBLEMS_REALISTIC — shape, regex valid, id unique, coverage.
'use strict';

const path = require('path');
const { PROBLEMS_REALISTIC, PROBLEM_SET_STATS } = require('./problems-realistic');

let passed = 0;
let failed = 0;
const fails = [];

function assert(name, cond, detail = '') {
  if (cond) { console.log(`  ok ${name}`); passed++; }
  else { console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); failed++; fails.push(name); }
}

// ── shape ────────────────────────────────────────────────────────
console.log('\n=== Shape validation ===');
const REQUIRED = ['id', 'key', 'category', 'difficulty', 'lang', 'prompt', 'hint', 'keywords', 'testMarker', 'badPractices'];
const ALLOWED_CAT = new Set(['express', 'nextjs', 'node-util', 'python', 'devops', 'auth', 'db', 'validation', 'refactor', 'debug', 'ts-type']);
const ALLOWED_DIFF = new Set(['trivial', 'easy', 'medium', 'hard']);
const ALLOWED_LANG = new Set(['js', 'ts', 'py', 'yaml', 'dockerfile', 'sh']);

for (const p of PROBLEMS_REALISTIC) {
  const label = `#${p.id} ${p.key}`;
  for (const k of REQUIRED) {
    assert(`${label} has ${k}`, p[k] !== undefined && p[k] !== null, `missing ${k}`);
  }
  assert(`${label} category valid`, ALLOWED_CAT.has(p.category), `got ${p.category}`);
  assert(`${label} difficulty valid`, ALLOWED_DIFF.has(p.difficulty), `got ${p.difficulty}`);
  assert(`${label} lang valid`, ALLOWED_LANG.has(p.lang), `got ${p.lang}`);
  assert(`${label} prompt non-trivial`, typeof p.prompt === 'string' && p.prompt.length > 40);
  assert(`${label} hint non-empty`, typeof p.hint === 'string' && p.hint.length > 10);
}

// ── regex validity ───────────────────────────────────────────────
console.log('\n=== Regex validity ===');
for (const p of PROBLEMS_REALISTIC) {
  const label = `#${p.id} ${p.key}`;
  assert(`${label} keywords is non-empty array`, Array.isArray(p.keywords) && p.keywords.length > 0);
  for (const re of p.keywords || []) {
    assert(`${label} keyword is RegExp`, re instanceof RegExp, `got ${typeof re}`);
  }
  assert(`${label} testMarker is RegExp`, p.testMarker instanceof RegExp);
  assert(`${label} badPractices is array`, Array.isArray(p.badPractices));
  for (const re of p.badPractices || []) {
    assert(`${label} badPractice is RegExp`, re instanceof RegExp);
  }
}

// ── uniqueness ───────────────────────────────────────────────────
console.log('\n=== Uniqueness ===');
const ids = PROBLEMS_REALISTIC.map(p => p.id);
const keys = PROBLEMS_REALISTIC.map(p => p.key);
assert('all ids unique', new Set(ids).size === ids.length);
assert('all keys unique', new Set(keys).size === keys.length);

// ── coverage ─────────────────────────────────────────────────────
console.log('\n=== Coverage ===');
const stats = PROBLEM_SET_STATS();
assert('total >= 25', stats.total >= 25, `got ${stats.total}`);
assert('total <= 35', stats.total <= 35, `got ${stats.total}`);
for (const cat of ALLOWED_CAT) {
  const n = stats.byCategory[cat] || 0;
  assert(`category '${cat}' has >=3 problems`, n >= 3, `got ${n}`);
}
assert('>= 5 trivial+easy', (stats.byDifficulty.trivial || 0) + (stats.byDifficulty.easy || 0) >= 5, JSON.stringify(stats.byDifficulty));
assert('>= 8 medium', (stats.byDifficulty.medium || 0) >= 8, JSON.stringify(stats.byDifficulty));
assert('>= 5 hard (or medium+hard >=13)', (stats.byDifficulty.hard || 0) >= 5 || ((stats.byDifficulty.medium || 0) + (stats.byDifficulty.hard || 0)) >= 13, JSON.stringify(stats.byDifficulty));

// ── bench integration ────────────────────────────────────────────
console.log('\n=== Bench integration ===');
// Make sure coding-quality-bench.js can load via --problem-set realistic path resolution
const benchPath = path.join(__dirname, 'coding-quality-bench.js');
const fs = require('fs');
const benchSrc = fs.readFileSync(benchPath, 'utf8');
assert('bench supports --problem-set flag', /--problem-set/.test(benchSrc));
assert('bench has loadProblemSet', /loadProblemSet/.test(benchSrc));
assert('bench calls loadProblemSet with args.problemSet', /loadProblemSet\(args\.problemSet\)/.test(benchSrc));

// ── summary ──────────────────────────────────────────────────────
console.log('\n=== STATS ===');
console.log(JSON.stringify(stats, null, 2));
console.log(`\n[result] passed=${passed} failed=${failed}`);
if (failed > 0) {
  console.log(`[failures] ${fails.slice(0, 10).join(', ')}${fails.length > 10 ? '…' : ''}`);
  process.exit(1);
}
process.exit(0);
