#!/usr/bin/env node
'use strict';
/**
 * scorer.js — aggregate JSONL results into markdown report
 *
 * Usage:
 *   node benchmark/scorer.js results/2026-04-18-abc.jsonl
 */

const fs = require('fs');
const path = require('path');

function loadJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function group(records, key) {
  const m = new Map();
  for (const r of records) {
    const k = r[key];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

function pct(n, d) { return d === 0 ? '—' : `${(n / d * 100).toFixed(0)}%`; }

function report(records) {
  const byModel = group(records, 'model');
  const byTier = group(records, 'tier');

  let out = `# Benchmark Report\n\n`;
  out += `- Generated: ${new Date().toISOString()}\n`;
  out += `- Total runs: ${records.length}\n`;
  out += `- Unique tasks: ${new Set(records.map(r => r.task)).size}\n`;
  out += `- Models tested: ${[...byModel.keys()].join(', ')}\n\n`;

  out += `## Pass rate + P/P (Price/Performance) by model\n\n`;
  out += `P/P score = pass_rate / avg_cost — cao hon = hieu qua hon (pass nhieu voi gia re).\n\n`;
  out += `| Model | Pass | Total | % | Avg wall_ms | Avg cost_usd | Cost-per-Pass | P/P score |\n|---|---|---|---|---|---|---|---|\n`;
  const modelRows = [];
  for (const [model, rs] of byModel) {
    const pass = rs.filter(r => r.correct).length;
    const avgMs = rs.reduce((a, r) => a + (r.wall_ms || 0), 0) / rs.length;
    const costs = rs.map(r => r.cost_usd).filter(c => c != null);
    const avgCost = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null;
    const passRate = pass / rs.length;
    const costPerPass = (avgCost != null && pass > 0)
      ? (rs.reduce((a, r) => a + (r.cost_usd || 0), 0) / pass) : null;
    const pp = (avgCost != null && avgCost > 0) ? (passRate / avgCost) : null;
    modelRows.push({ model, pass, total: rs.length, passRate, avgMs, avgCost, costPerPass, pp });
  }
  modelRows.sort((a, b) => (b.pp || 0) - (a.pp || 0));
  for (const r of modelRows) {
    out += `| ${r.model} | ${r.pass} | ${r.total} | ${pct(r.pass, r.total)} | ${r.avgMs.toFixed(0)} | `
      + `${r.avgCost != null ? '$' + r.avgCost.toFixed(4) : '—'} | `
      + `${r.costPerPass != null ? '$' + r.costPerPass.toFixed(4) : '—'} | `
      + `${r.pp != null ? r.pp.toFixed(1) : '—'} |\n`;
  }
  out += `\n**Cost-per-Pass** = tong cost / so task pass (cang thap cang re). **P/P score** = pass_rate / avg_cost (cao = hieu qua).\n`;

  out += `\n## Pass rate by tier\n\n`;
  out += `| Tier | Pass | Total | % |\n|---|---|---|---|\n`;
  for (const [tier, rs] of [...byTier.entries()].sort()) {
    const pass = rs.filter(r => r.correct).length;
    out += `| ${tier} | ${pass} | ${rs.length} | ${pct(pass, rs.length)} |\n`;
  }

  out += `\n## Detail per task\n\n`;
  out += `| Task | Title | Model | Result | Wall ms | Reason |\n|---|---|---|---|---|---|\n`;
  for (const r of records) {
    const status = r.correct ? 'PASS' : 'FAIL';
    const reason = (r.reason || '').replace(/\|/g, '\\|').slice(0, 80);
    out += `| ${r.task} | ${r.title} | ${r.model} | ${status} | ${r.wall_ms} | ${reason} |\n`;
  }

  return out;
}

function main() {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node scorer.js <results.jsonl>'); process.exit(2); }
  const records = loadJsonl(file);
  const md = report(records);
  const outFile = file.replace(/\.jsonl$/, '-report.md');
  fs.writeFileSync(outFile, md);
  console.log(md);
  console.log(`\nReport written: ${outFile}`);
}

if (require.main === module) main();
