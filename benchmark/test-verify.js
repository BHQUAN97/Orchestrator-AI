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
  runVerify(t01, { stdout: 'ASYNC_COUNT=12', workDir: '' }).pass === true,
  'T01 pass when "ASYNC_COUNT=12" in stdout'
);
assert(
  runVerify(t01, { stdout: 'nothing here', workDir: '' }).pass === false,
  'T01 fail when no match'
);
assert(
  runVerify(t01, { stdout: 'ASYNC_COUNT=200', workDir: '' }).pass === false,
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

// === B-tier smoke tests — simulate ket qua dung va sai cho tung task ===

// T06 — extract helper
const t06 = TASKS.find(t => t.id === 'T06');
const d06 = path.join(os.tmpdir(), 'bench-verify-t06-' + Date.now());
fs.mkdirSync(d06, { recursive: true });
// Correct: utils.js + math/stats require it
fs.writeFileSync(path.join(d06, 'utils.js'), `function sum(a){let s=0;for(const x of a)s+=x;return s}\nmodule.exports={sum};`);
fs.writeFileSync(path.join(d06, 'math.js'), `const {sum}=require('./utils');\nfunction mean(a){return sum(a)/a.length}\nmodule.exports={mean};`);
fs.writeFileSync(path.join(d06, 'stats.js'), `const {sum}=require('./utils');\nmodule.exports={sum};`);
assert(runVerify(t06, { workDir: d06 }).pass === true, 'T06 pass when helper extracted and required');
// Wrong: math still has its own sum
fs.writeFileSync(path.join(d06, 'math.js'), `function sum(a){let s=0;for(const x of a)s+=x;return s}\nmodule.exports={sum};`);
assert(runVerify(t06, { workDir: d06 }).pass === false, 'T06 fail when math.js still defines sum');

// T07 — add --dry flag
const t07 = TASKS.find(t => t.id === 'T07');
const d07 = path.join(os.tmpdir(), 'bench-verify-t07-' + Date.now());
fs.mkdirSync(d07, { recursive: true });
fs.writeFileSync(path.join(d07, 'cli.js'), `
const args = process.argv.slice(2);
if (args.includes('--dry')) { console.log('DRY RUN'); process.exit(0); }
console.log('Hello');
`);
assert(runVerify(t07, { workDir: d07 }).pass === true, 'T07 pass when --dry + DRY RUN + Hello all present');
fs.writeFileSync(path.join(d07, 'cli.js'), `console.log('Hello');`);
assert(runVerify(t07, { workDir: d07 }).pass === false, 'T07 fail when --dry not added');

// T08 — update schema JSON
const t08 = TASKS.find(t => t.id === 'T08');
const d08 = path.join(os.tmpdir(), 'bench-verify-t08-' + Date.now());
fs.mkdirSync(d08, { recursive: true });
const schemaOK = {
  tools: [
    { name: 'memory_save', parameters: { type: 'object', properties: {
      type: { type: 'string' }, content: { type: 'string' },
      description: { type: 'string' }
    }, required: ['type', 'content'] } }
  ]
};
fs.writeFileSync(path.join(d08, 'schema.json'), JSON.stringify(schemaOK, null, 2));
assert(runVerify(t08, { workDir: d08 }).pass === true, 'T08 pass when description added as optional string');
// Wrong: description added but also pushed into required
const schemaWrong = JSON.parse(JSON.stringify(schemaOK));
schemaWrong.tools[0].parameters.required.push('description');
fs.writeFileSync(path.join(d08, 'schema.json'), JSON.stringify(schemaWrong, null, 2));
assert(runVerify(t08, { workDir: d08 }).pass === false, 'T08 fail when description listed as required');

// T09 — migrate deprecated
const t09 = TASKS.find(t => t.id === 'T09');
const d09 = path.join(os.tmpdir(), 'bench-verify-t09-' + Date.now());
fs.mkdirSync(d09, { recursive: true });
for (const f of ['a.js', 'b.js', 'c.js']) {
  fs.writeFileSync(path.join(d09, f), `const fsp=require('fs').promises;\nasync function go(p){await fsp.access(p);}`);
}
assert(runVerify(t09, { workDir: d09 }).pass === true, 'T09 pass when all 3 files migrated to fs.promises.access');
fs.writeFileSync(path.join(d09, 'a.js'), `const fs=require('fs');\nfs.existsSync('x');`);
assert(runVerify(t09, { workDir: d09 }).pass === false, 'T09 fail when a.js still uses fs.existsSync');

// T10 — standardize error
const t10 = TASKS.find(t => t.id === 'T10');
const d10 = path.join(os.tmpdir(), 'bench-verify-t10-' + Date.now());
fs.mkdirSync(d10, { recursive: true });
fs.writeFileSync(path.join(d10, 'errors.js'), `class ToolError extends Error { constructor(m,c){super(m);this.code=c;} }\nmodule.exports={ToolError};`);
fs.writeFileSync(path.join(d10, 'mod1.js'), `const {ToolError}=require('./errors');\nfunction p(){throw new ToolError('x','EMPTY');}`);
fs.writeFileSync(path.join(d10, 'mod2.js'), `const {ToolError}=require('./errors');\nfunction l(){throw new ToolError('x','BAD');}`);
assert(runVerify(t10, { workDir: d10 }).pass === true, 'T10 pass when ToolError used across files');
fs.writeFileSync(path.join(d10, 'mod1.js'), `function p(){throw new Error('x');}`);
assert(runVerify(t10, { workDir: d10 }).pass === false, 'T10 fail when mod1.js still uses throw new Error');

fs.rmSync(tmpDir, { recursive: true, force: true });
for (const d of [d06, d07, d08, d09, d10]) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
