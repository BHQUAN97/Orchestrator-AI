#!/usr/bin/env node
'use strict';
/**
 * runner.js — chay benchmark cho 1 hoac nhieu task x model
 *
 * Usage:
 *   node benchmark/runner.js --task T01,T02 --model default
 *   node benchmark/runner.js --tier A --model default,cheap,smart
 *   node benchmark/runner.js --all --model default
 *
 * Output:
 *   benchmark/results/YYYY-MM-DD-<runId>.jsonl  (raw per-run records)
 *   console stdout: progress + summary
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const { runVerify } = require('./verify');

const REPO_ROOT = path.resolve(__dirname, '..');
const ORCAI_BIN = path.join(REPO_ROOT, 'bin', 'orcai.js');
const TASKS = require('./tasks.json');
const RESULTS_DIR = path.join(__dirname, 'results');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { tasks: [], models: [], all: false, tier: null, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--task') opts.tasks = args[++i].split(',');
    else if (args[i] === '--model') opts.models = args[++i].split(',');
    else if (args[i] === '--tier') opts.tier = args[++i];
    else if (args[i] === '--all') opts.all = true;
    else if (args[i] === '--dry-run') opts.dryRun = true;
  }
  if (opts.models.length === 0) opts.models = ['default'];
  return opts;
}

function selectTasks(opts) {
  if (opts.all) return TASKS;
  if (opts.tier) return TASKS.filter(t => t.tier === opts.tier);
  if (opts.tasks.length) return TASKS.filter(t => opts.tasks.includes(t.id));
  return [];
}

function setupFixture(task) {
  if (task.fixture === 'repo-snapshot') {
    const dir = path.join(os.tmpdir(), `orcai-bench-${task.id}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    // Chi copy cac file can thiet — tu prompt infer
    // A-tier: chi doc, chi can copy file tham chieu
    const filesToCopy = [
      'README.md',
      'lib/agent-loop.js',
      'lib/plan-mode.js',
      'tools/definitions.js',
      'test/parity.test.js'
    ];
    for (const f of filesToCopy) {
      const src = path.join(REPO_ROOT, f);
      const dst = path.join(dir, f);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    }
    return dir;
  }
  if (task.fixture === 'b-tier') {
    // Copy toan bo thu muc fixtures/b-tier/<taskId>/ vao tmp dir
    const srcDir = path.join(__dirname, 'fixtures', 'b-tier', task.id);
    if (!fs.existsSync(srcDir)) {
      throw new Error(`B-tier fixture missing: ${srcDir}`);
    }
    const dstDir = path.join(os.tmpdir(), `orcai-bench-${task.id}-${Date.now()}`);
    _copyRecursive(srcDir, dstDir);
    return dstDir;
  }
  if (task.fixture === 'external-readonly') {
    // Tro thang den repo ngoai — read-only tasks (audit/trace/reasoning)
    // Khong copy vi repo lon. Agent khong duoc sua (prompt enforce).
    if (!task.external_path) {
      throw new Error(`external-readonly fixture requires external_path`);
    }
    const p = path.resolve(task.external_path);
    if (!fs.existsSync(p)) {
      throw new Error(`External path missing: ${p}`);
    }
    return p;
  }
  throw new Error(`Unknown fixture: ${task.fixture}`);
}

function _copyRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) _copyRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

function cleanupFixture(dir, task) {
  // Khong xoa fixture external (la repo user, read-only)
  if (task && task.fixture === 'external-readonly') return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function runOrcai(task, model, workDir) {
  return new Promise((resolve) => {
    const start = Date.now();
    const args = [
      ORCAI_BIN,
      '-p', workDir,
      '--model', model,
      '--direct',
      '--no-confirm',
      '--budget', String(task.budget_usd || 0.10),
      '--max-iterations', String(task.max_iterations || 15),
      task.prompt
    ];
    const child = spawn(process.execPath, args, {
      cwd: workDir,
      env: { ...process.env, ORCAI_BENCHMARK: '1', NO_COLOR: '1', ORCAI_MAX_OUTPUT_TOKENS: process.env.ORCAI_MAX_OUTPUT_TOKENS || '2000' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    const killer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, (task.timeout_s || 180) * 1000);
    child.on('exit', (code) => {
      clearTimeout(killer);
      const wall_ms = Date.now() - start;
      resolve({ code, stdout, stderr, wall_ms });
    });
  });
}

function parseMetrics(stdout) {
  // Format thuc te tu orcai:
  //   "3 iterations | 3 tool calls | 0 errors"
  //   "Tokens: 29444 in, 122 out | cache hit: 0% | cost: $0.0081"
  const metrics = { iterations: null, tokens_in: null, tokens_out: null, cost_usd: null };
  const itMatch = stdout.match(/(\d+)\s+iterations?\b/i);
  if (itMatch) metrics.iterations = parseInt(itMatch[1], 10);
  const costMatch = stdout.match(/cost:\s*\$([\d.]+)/i) || stdout.match(/\$([\d.]+)\s*(total|cost|usd)/i);
  if (costMatch) metrics.cost_usd = parseFloat(costMatch[1]);
  const tokMatch = stdout.match(/Tokens?:\s*(\d+)\s*in,?\s*(\d+)\s*out/i)
    || stdout.match(/(\d+)\s*tokens?\s*\(in\).*?(\d+)\s*tokens?\s*\(out\)/i);
  if (tokMatch) { metrics.tokens_in = parseInt(tokMatch[1]); metrics.tokens_out = parseInt(tokMatch[2]); }
  return metrics;
}

async function runOne(task, model) {
  const workDir = setupFixture(task);
  console.log(`\n[${task.id}][${model}] RUN  ${task.title}`);
  console.log(`  fixture: ${workDir}`);
  const { code, stdout, stderr, wall_ms } = await runOrcai(task, model, workDir);
  const metrics = parseMetrics(stdout);
  const verdict = runVerify(task, { stdout, stderr, workDir, task });
  // save stdout/stderr for debug
  const logFile = path.join(RESULTS_DIR, `${task.id}-${model}-${Date.now()}.log`);
  fs.writeFileSync(logFile, `=== STDOUT ===\n${stdout}\n=== STDERR ===\n${stderr}\n`);
  const record = {
    ts: new Date().toISOString(),
    task: task.id,
    title: task.title,
    tier: task.tier,
    model,
    exit_code: code,
    correct: verdict.pass,
    reason: verdict.reason || null,
    value: verdict.value ?? null,
    wall_ms,
    ...metrics,
    stdout_len: stdout.length,
    stderr_len: stderr.length,
    log_file: path.basename(logFile)
  };
  console.log(`  -> ${verdict.pass ? 'PASS' : 'FAIL'} ${verdict.reason ? `(${verdict.reason})` : ''} [${wall_ms}ms]`);
  cleanupFixture(workDir, task);
  return record;
}

async function main() {
  const opts = parseArgs();
  const tasks = selectTasks(opts);
  if (!tasks.length) { console.error('No tasks selected. Use --task ID or --tier A or --all'); process.exit(2); }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const runId = `${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`;
  const outFile = path.join(RESULTS_DIR, `${runId}.jsonl`);

  console.log(`\n=== Benchmark Run ${runId} ===`);
  console.log(`Tasks: ${tasks.map(t => t.id).join(',')}`);
  console.log(`Models: ${opts.models.join(',')}`);
  console.log(`Output: ${outFile}`);
  if (opts.dryRun) { console.log('\n[DRY RUN] — not executing'); return; }

  const results = [];
  for (const task of tasks) {
    for (const model of opts.models) {
      const rec = await runOne(task, model);
      fs.appendFileSync(outFile, JSON.stringify(rec) + '\n');
      results.push(rec);
    }
  }

  console.log(`\n=== Summary ===`);
  const pass = results.filter(r => r.correct).length;
  console.log(`  ${pass}/${results.length} passed`);
  for (const model of opts.models) {
    const mres = results.filter(r => r.model === model);
    const mpass = mres.filter(r => r.correct).length;
    console.log(`  [${model}] ${mpass}/${mres.length} (${(mpass / mres.length * 100).toFixed(0)}%)`);
  }
  console.log(`\nResults: ${outFile}`);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { runOne, selectTasks };
