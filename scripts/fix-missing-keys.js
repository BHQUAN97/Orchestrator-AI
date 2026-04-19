#!/usr/bin/env node
// Patch project-04 + project-05 JSONL: auto-add problem_key (content-hash based) + source/lang/score defaults.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', '.orcai', 'training', 'distill-v2');

function slugHash(text) {
  const h = crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);
  return `auto-${h}`;
}

const FILES = [
  { file: 'project-04-web.jsonl', defaultLang: 'ts' },
  { file: 'project-05-orchestrator.jsonl', defaultLang: 'js' },
];

for (const { file, defaultLang } of FILES) {
  const fp = path.join(DIR, file);
  const lines = fs.readFileSync(fp, 'utf8').split('\n').filter((l) => l.trim());
  const out = [];
  let patched = 0;

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj.meta) obj.meta = {};
    const m = obj.meta;

    if (!m.problem_key) {
      const userMsg = (obj.messages || []).find((x) => x.role === 'user');
      m.problem_key = slugHash(userMsg ? userMsg.content : JSON.stringify(obj));
      patched++;
    }
    if (!m.source) m.source = 'claude-code-agent-project';
    if (!m.lang) m.lang = defaultLang;
    if (!m.score) m.score = 5;

    out.push(JSON.stringify(obj));
  }

  fs.writeFileSync(fp, out.join('\n') + '\n');
  console.log(`${file}: ${out.length} lines, ${patched} patched`);
}
