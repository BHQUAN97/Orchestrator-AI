#!/usr/bin/env node
'use strict';
/**
 * test-verify.js — smoke test cho verify.js (khong can LLM)
 * Chay: node benchmark/test-verify.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runVerify } = require('./verify');
const TASKS = require('./tasks.json');

let pass = 0, fail = 0;
function assert(ok, msg) {
  if (ok) { pass++; console.log(`  OK  ${msg}`); }
  else { fail++; console.log(`  FAIL ${msg}`); }
}

// T01 — stdout_match with numeric range
const t01 = TASKS.find(t => t.id === 'T01');
assert(
  runVerify(t01, { stdout: 'There are 12 async functions', workDir: '' }).pass === true,
  'T01 pass when "12 async" in stdout'
);
assert(
  runVerify(t01, { stdout: 'nothing here', workDir: '' }).pass === false,
  'T01 fail when no match'
);
assert(
  runVerify(t01, { stdout: 'count: 200 async things', workDir: '' }).pass === false,
  'T01 fail when number out of range'
);

// T02 — file_content_regex
const t02 = TASKS.find(t => t.id === 'T02');
const tmpDir = path.join(os.tmpdir(), 'bench-verify-test-' + Date.now());
fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
fs.writeFileSync(path.join(tmpDir, 'lib/plan-mode.js'), `
/**
 * Run plan flow
 * @param {string} originalPrompt - prompt
 * @returns {Promise<object>} result
 */
async function runPlanFlow(originalPrompt) { return {}; }
`);
assert(
  runVerify(t02, { stdout: '', workDir: tmpDir }).pass === true,
  'T02 pass when JSDoc with @param + @returns above runPlanFlow'
);

fs.writeFileSync(path.join(tmpDir, 'lib/plan-mode.js'), `
async function runPlanFlow(originalPrompt) { return {}; }
`);
assert(
  runVerify(t02, { stdout: '', workDir: tmpDir }).pass === false,
  'T02 fail when no JSDoc'
);

// T03 — file_content_regex with must_not_pattern
const t03 = TASKS.find(t => t.id === 'T03');
fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });
fs.writeFileSync(path.join(tmpDir, 'test/parity.test.js'), `let passCount = 0;\npassCount++;`);
assert(
  runVerify(t03, { stdout: '', workDir: tmpDir }).pass === true,
  'T03 pass when `passCount++` present AND no `let passed =`'
);
fs.writeFileSync(path.join(tmpDir, 'test/parity.test.js'), `let passed = 0;\npassCount++;`);
assert(
  runVerify(t03, { stdout: '', workDir: tmpDir }).pass === false,
  'T03 fail when forbidden pattern `let passed =` still present'
);

// T04 — stdout_match
const t04 = TASKS.find(t => t.id === 'T04');
assert(
  runVerify(t04, { stdout: 'TYPO: trien -> triển', workDir: '' }).pass === true,
  'T04 pass when TYPO format matched'
);

// T05 — chained pattern
const t05 = TASKS.find(t => t.id === 'T05');
assert(
  runVerify(t05, {
    stdout: 'read_file\nwrite_file\nedit_file\nexecute_command\n',
    workDir: ''
  }).pass === true,
  'T05 pass when read_file + write_file + execute_command all present'
);

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
