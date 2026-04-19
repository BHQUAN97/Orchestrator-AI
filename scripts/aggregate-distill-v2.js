#!/usr/bin/env node
// Aggregate + validate + dedupe all distill-v2/*.jsonl → single training file.
// Output: .orcai/training/distill-v2-merged.jsonl
// Report: .orcai/training/distill-v2-stats.md

'use strict';

const fs = require('fs');
const path = require('path');

const INPUT_DIR = path.join(__dirname, '..', '.orcai', 'training', 'distill-v2');
const OUTPUT_FILE = path.join(__dirname, '..', '.orcai', 'training', 'distill-v2-merged.jsonl');
const STATS_FILE = path.join(__dirname, '..', '.orcai', 'training', 'distill-v2-stats.md');

const files = fs.readdirSync(INPUT_DIR).filter((f) => f.endsWith('.jsonl'));

const pairs = [];
const errors = [];
const seenKeys = new Map(); // problem_key -> {file, line}
const filePairs = {}; // file -> count

for (const file of files) {
  const fullPath = path.join(INPUT_DIR, file);
  const lines = fs.readFileSync(fullPath, 'utf8').split('\n').filter((l) => l.trim());
  filePairs[file] = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    try {
      const obj = JSON.parse(lines[i]);

      // Validate required fields
      if (!obj.messages || !Array.isArray(obj.messages) || obj.messages.length < 2) {
        errors.push(`${file}:${lineNum} — missing/invalid messages`);
        continue;
      }
      if (!obj.meta || !obj.meta.problem_key) {
        errors.push(`${file}:${lineNum} — missing meta.problem_key`);
        continue;
      }

      // Check duplicate problem_key
      const key = obj.meta.problem_key;
      if (seenKeys.has(key)) {
        const first = seenKeys.get(key);
        errors.push(`DUPLICATE ${key}: ${first.file}:${first.line} vs ${file}:${lineNum} (skipping 2nd)`);
        continue;
      }
      seenKeys.set(key, { file, line: lineNum });

      // Ensure messages are user/assistant pair
      const user = obj.messages.find((m) => m.role === 'user');
      const asst = obj.messages.find((m) => m.role === 'assistant');
      if (!user || !asst || !user.content || !asst.content) {
        errors.push(`${file}:${lineNum} — missing user or assistant message content`);
        continue;
      }

      pairs.push(obj);
      filePairs[file]++;
    } catch (e) {
      errors.push(`${file}:${lineNum} — JSON parse error: ${e.message}`);
    }
  }
}

// Shuffle for train mixing (stable-ish with fixed seed via sort key)
// Simple shuffle: interleave sources to avoid all one category first
pairs.sort(() => Math.random() - 0.5);

// Write merged
fs.writeFileSync(OUTPUT_FILE, pairs.map((p) => JSON.stringify(p)).join('\n') + '\n');

// Stats
const byCategory = {};
const byDifficulty = { easy: 0, med: 0, hard: 0, other: 0 };
const byLang = {};
const bySource = {};
const byProject = {};

for (const p of pairs) {
  const m = p.meta;
  byCategory[m.category || 'unknown'] = (byCategory[m.category || 'unknown'] || 0) + 1;
  const d = m.difficulty || 'other';
  if (d === 'easy' || d === 'med' || d === 'medium' || d === 'hard') {
    byDifficulty[d === 'medium' ? 'med' : d]++;
  } else byDifficulty.other++;
  byLang[m.lang || 'unknown'] = (byLang[m.lang || 'unknown'] || 0) + 1;
  bySource[m.source || 'unknown'] = (bySource[m.source || 'unknown'] || 0) + 1;
  if (m.project) byProject[m.project] = (byProject[m.project] || 0) + 1;
}

// Also count existing v1 data
const v1Files = ['style.jsonl', 'classifier.jsonl', 'distill.jsonl'];
const v1Counts = {};
let v1Total = 0;
for (const f of v1Files) {
  const fp = path.join(__dirname, '..', '.orcai', 'training', f);
  if (fs.existsSync(fp)) {
    const n = fs.readFileSync(fp, 'utf8').split('\n').filter((l) => l.trim()).length;
    v1Counts[f] = n;
    v1Total += n;
  }
}

const md = `# Distill v2 — Aggregation Stats

Generated: ${new Date().toISOString()}
Source: 13 files in \`.orcai/training/distill-v2/\`
Output: \`.orcai/training/distill-v2-merged.jsonl\`

## Totals
- **Pairs after dedup + validate: ${pairs.length}**
- Errors/skipped: ${errors.length}
- Input files: ${files.length}

## Comparison vs Round 5 data
| Data | Count |
|---|---|
${v1Files.map((f) => `| v1 ${f} | ${v1Counts[f] || 0} |`).join('\n')}
| v1 total | ${v1Total} |
| **v2 merged** | **${pairs.length}** |
| Combined v1+v2 | ${v1Total + pairs.length} |

## By source file
| File | Kept | (Input) |
|---|---|---|
${files.map((f) => `| ${f} | ${filePairs[f]} | |`).join('\n')}

## By category
| Category | Count |
|---|---|
${Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}

## By difficulty
| Level | Count | % |
|---|---|---|
| easy | ${byDifficulty.easy} | ${((byDifficulty.easy / pairs.length) * 100).toFixed(1)}% |
| medium | ${byDifficulty.med} | ${((byDifficulty.med / pairs.length) * 100).toFixed(1)}% |
| hard | ${byDifficulty.hard} | ${((byDifficulty.hard / pairs.length) * 100).toFixed(1)}% |
| other | ${byDifficulty.other} | ${((byDifficulty.other / pairs.length) * 100).toFixed(1)}% |

## By language
| Lang | Count |
|---|---|
${Object.entries(byLang).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}

## By source tag
| Source | Count |
|---|---|
${Object.entries(bySource).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}

## By project (real-project subset)
| Project | Count |
|---|---|
${Object.entries(byProject).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}

${errors.length > 0 ? `\n## Errors/Duplicates skipped\n${errors.slice(0, 30).map((e) => `- ${e}`).join('\n')}${errors.length > 30 ? `\n... (${errors.length - 30} more)` : ''}` : ''}
`;

fs.writeFileSync(STATS_FILE, md);

console.log(`\n=== DONE ===`);
console.log(`Pairs kept: ${pairs.length}`);
console.log(`Errors: ${errors.length}`);
console.log(`Output: ${OUTPUT_FILE}`);
console.log(`Stats: ${STATS_FILE}`);
console.log(`\n--- difficulty ---`);
console.log(`easy=${byDifficulty.easy} med=${byDifficulty.med} hard=${byDifficulty.hard} other=${byDifficulty.other}`);
