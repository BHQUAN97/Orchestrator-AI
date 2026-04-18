'use strict';
/**
 * verify.js — kiem tra pass/fail cho tung task sau khi agent chay xong
 *
 * Moi verify function nhan: { stdout, stderr, workDir, task }
 * Tra ve: { pass: boolean, reason?: string, value?: any }
 */

const fs = require('fs');
const path = require('path');

function stdoutMatch(task, { stdout }) {
  const pat = new RegExp(task.verify.pattern);
  const m = stdout.match(pat);
  if (!m) return { pass: false, reason: `no match for ${task.verify.pattern}` };
  if (task.verify.expected_min != null && task.verify.expected_max != null) {
    const n = parseInt(m[1], 10);
    if (isNaN(n)) return { pass: false, reason: 'captured group is not a number' };
    if (n < task.verify.expected_min || n > task.verify.expected_max) {
      return { pass: false, reason: `number ${n} out of range [${task.verify.expected_min}, ${task.verify.expected_max}]` };
    }
    return { pass: true, value: n };
  }
  return { pass: true };
}

function fileContentRegex(task, { workDir }) {
  const filePath = path.join(workDir, task.verify.path);
  if (!fs.existsSync(filePath)) return { pass: false, reason: `file missing: ${task.verify.path}` };
  const content = fs.readFileSync(filePath, 'utf8');
  const pat = new RegExp(task.verify.pattern, 'm');
  if (!pat.test(content)) return { pass: false, reason: `pattern not found in ${task.verify.path}` };
  if (task.verify.must_not_pattern) {
    const bad = new RegExp(task.verify.must_not_pattern, 'm');
    if (bad.test(content)) return { pass: false, reason: `forbidden pattern still present` };
  }
  return { pass: true };
}

function runVerify(task, context) {
  const type = task.verify && task.verify.type;
  switch (type) {
    case 'stdout_match': return stdoutMatch(task, context);
    case 'file_content_regex': return fileContentRegex(task, context);
    default: return { pass: false, reason: `unknown verify type: ${type}` };
  }
}

module.exports = { runVerify };
