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

/**
 * multi_file: kiem tra nhieu file dong thoi (mang checks)
 * Format task.verify:
 *   { type: 'multi_file', checks: [
 *     { kind: 'file_exists', path: 'utils.js' },
 *     { kind: 'regex', path: 'math.js', pattern: 'require.*utils' },
 *     { kind: 'not_regex', path: 'stats.js', pattern: 'function\\s+sum' },
 *     { kind: 'pattern_count', path: 'b.js', pattern: 'fs\\.existsSync', op: 'eq', value: 0 },
 *     { kind: 'json_path', path: 'schema.json', pointer: 'tools.0.parameters.properties.description.type', value: 'string' }
 *   ]}
 * Tat ca check phai pass.
 */
function multiFile(task, { workDir }) {
  const checks = Array.isArray(task.verify.checks) ? task.verify.checks : [];
  if (!checks.length) return { pass: false, reason: 'no checks in multi_file verify' };

  const failed = [];
  for (const c of checks) {
    const r = _runCheck(c, workDir);
    if (!r.pass) failed.push(`[${c.kind}${c.path ? ' ' + c.path : ''}] ${r.reason}`);
  }
  if (failed.length) return { pass: false, reason: failed.join(' | ') };
  return { pass: true };
}

function _runCheck(c, workDir) {
  const filePath = c.path ? path.join(workDir, c.path) : null;
  switch (c.kind) {
    case 'file_exists': {
      if (!fs.existsSync(filePath)) return { pass: false, reason: 'file missing' };
      const content = fs.readFileSync(filePath, 'utf8');
      if (typeof c.min_length === 'number' && content.length < c.min_length) {
        return { pass: false, reason: `content length ${content.length} < min ${c.min_length}` };
      }
      return { pass: true };
    }
    case 'regex': {
      if (!fs.existsSync(filePath)) return { pass: false, reason: 'file missing' };
      const content = fs.readFileSync(filePath, 'utf8');
      const re = new RegExp(c.pattern, c.flags || 'm');
      if (!re.test(content)) return { pass: false, reason: `pattern not found: ${c.pattern}` };
      return { pass: true };
    }
    case 'not_regex': {
      if (!fs.existsSync(filePath)) return { pass: false, reason: 'file missing' };
      const content = fs.readFileSync(filePath, 'utf8');
      const re = new RegExp(c.pattern, c.flags || 'm');
      if (re.test(content)) return { pass: false, reason: `forbidden pattern still present: ${c.pattern}` };
      return { pass: true };
    }
    case 'pattern_count': {
      if (!fs.existsSync(filePath)) return { pass: false, reason: 'file missing' };
      const content = fs.readFileSync(filePath, 'utf8');
      const re = new RegExp(c.pattern, 'g');
      const matches = content.match(re) || [];
      const n = matches.length;
      const target = c.value;
      const op = c.op || 'eq';
      const ok =
        (op === 'eq' && n === target) ||
        (op === 'gte' && n >= target) ||
        (op === 'lte' && n <= target) ||
        (op === 'gt' && n > target) ||
        (op === 'lt' && n < target);
      if (!ok) return { pass: false, reason: `count ${n} !${op} ${target} for /${c.pattern}/` };
      return { pass: true };
    }
    case 'json_path': {
      if (!fs.existsSync(filePath)) return { pass: false, reason: 'file missing' };
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
      catch (e) { return { pass: false, reason: `invalid JSON: ${e.message}` }; }
      const segments = String(c.pointer || '').split('.').filter(Boolean);
      let cur = data;
      for (const seg of segments) {
        if (cur == null) return { pass: false, reason: `path broken at ${seg}` };
        cur = Array.isArray(cur) ? cur[parseInt(seg, 10)] : cur[seg];
      }
      if (c.value !== undefined && cur !== c.value) {
        return { pass: false, reason: `value at ${c.pointer}: ${JSON.stringify(cur)} !== ${JSON.stringify(c.value)}` };
      }
      if (c.exists === true && cur === undefined) return { pass: false, reason: `${c.pointer} missing` };
      return { pass: true };
    }
    default:
      return { pass: false, reason: `unknown check kind: ${c.kind}` };
  }
}

function runVerify(task, context) {
  const type = task.verify && task.verify.type;
  switch (type) {
    case 'stdout_match': return stdoutMatch(task, context);
    case 'file_content_regex': return fileContentRegex(task, context);
    case 'multi_file': return multiFile(task, context);
    default: return { pass: false, reason: `unknown verify type: ${type}` };
  }
}

module.exports = { runVerify };
