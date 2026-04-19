#!/usr/bin/env node
/**
 * Merge captured cloud outputs (.orcai/distill-*.jsonl) into LoRA training format.
 *
 * Input:  .orcai/distill-<model>.jsonl  with rows {problemKey, prompt, code, score, ...}
 * Output: .orcai/training/distill.jsonl (chat-completion format matching style.jsonl)
 *
 * Filter: only include pairs with score >= 4 (high-quality).
 * Strip code fences from the assistant output so FT target is raw code.
 */

const fs = require('fs');
const path = require('path');

const INPUT_FILES = ['.orcai/distill-gpt-mini.jsonl', '.orcai/distill-deepseek.jsonl'];
const OUT_PATH = '.orcai/training/distill.jsonl';
const MIN_SCORE = 4;

function stripFences(s) {
  if (!s) return '';
  const m = [...s.matchAll(/```(?:\w+)?\s*\n([\s\S]*?)```/g)].map(x => x[1]);
  return (m.length ? m.join('\n\n') : s).trim();
}

const out = [];
const stats = { total: 0, kept: 0, perModel: {} };

for (const f of INPUT_FILES) {
  if (!fs.existsSync(f)) { console.warn('[merge] missing', f); continue; }
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim());
  for (const line of lines) {
    stats.total++;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const model = rec.model || path.basename(f).replace(/^distill-|\.jsonl$/g, '');
    stats.perModel[model] = (stats.perModel[model] || 0) + 1;
    if ((rec.score ?? 0) < MIN_SCORE) continue;
    const code = stripFences(rec.code || '');
    if (!code || code.length < 50) continue;
    out.push({
      messages: [
        { role: 'user', content: rec.prompt },
        { role: 'assistant', content: code },
      ],
      meta: {
        source: model,
        problem_key: rec.problemKey,
        category: rec.category,
        difficulty: rec.difficulty,
        lang: rec.lang,
        score: rec.score,
      },
    });
    stats.kept++;
  }
}

fs.writeFileSync(OUT_PATH, out.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');

console.log('=== distill merge ===');
console.log('input rows:   ', stats.total);
console.log('kept (>=4):   ', stats.kept);
console.log('per model:    ', JSON.stringify(stats.perModel));
console.log('output:       ', OUT_PATH, `(${out.length} pairs, ${fs.statSync(OUT_PATH).size} bytes)`);

// Sanity: category distribution
const byCat = {};
for (const r of out) byCat[r.meta.category] = (byCat[r.meta.category] || 0) + 1;
console.log('by category:  ', byCat);
