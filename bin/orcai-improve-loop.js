#!/usr/bin/env node
/**
 * Continuous improvement loop for LOCAL coding models.
 *
 * Muc tieu: lap di lap lai benchmark + tuning de day score cua local Qwen
 * den >=98%. Chay unattended qua dem.
 *
 * Exit conditions:
 *  - target reached (>=98%)
 *  - max iterations (default 20)
 *  - max wall time (default 8h)
 *  - plateau: 3 iter khong cai thien >0.5%
 *  - budget exceeded (enforceHardCap)
 *  - SIGTERM/SIGINT
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

const PROJECT_DIR = process.cwd();
const STATE_DIR = path.join(PROJECT_DIR, '.orcai', 'improve-loop');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOG_FILE = path.join(STATE_DIR, 'log.jsonl');
const PID_FILE = path.join(STATE_DIR, 'loop.pid');
const REPORT_FILE = path.join(STATE_DIR, 'final-report.md');

const TARGET = parseFloat(process.env.ORCAI_LOOP_TARGET || '98');
const MAX_ITER = parseInt(process.env.ORCAI_LOOP_MAX_ITER || '20', 10);
const MAX_HOURS = parseFloat(process.env.ORCAI_LOOP_MAX_HOURS || '8');
const COOLDOWN_MS = parseInt(process.env.ORCAI_LOOP_COOLDOWN_MS || '90000', 10);
const LITELLM_URL = process.env.LITELLM_URL || 'http://localhost:5002';
const LITELLM_KEY = process.env.LITELLM_KEY || process.env.LITELLM_API_KEY || '';
const QUIET_HOURS = process.env.ORCAI_LOOP_QUIET_HOURS || '';

// Levers
const TEMPLATES = [
  { id: 't1-strict', text: 'You are a senior engineer. Return only the code requested, no prose unless the prompt asks for it.' },
  { id: 't2-detailed', text: 'You are a senior engineer writing production-grade code. Output only the exact artifact asked for, using the stack conventions shown in context. Avoid placeholders and TODOs.' },
  { id: 't3-step', text: 'You are a senior engineer. Think silently, then output ONLY the final code, matching the user\'s stack and examples. No commentary.' },
  { id: 't4-examples', text: 'You are a senior engineer. Mimic the style of the RELEVANT EXAMPLES if provided. Output only code, no explanations.' },
  { id: 't5-verify', text: 'You are a senior engineer. Write code that compiles AND passes the implicit tests. Include a minimal test where the prompt asks. Output only code.' }
];
const SIMILARITY_GRID = [0.45, 0.55, 0.65, 0.75];
const FEWSHOT_GRID = [2, 3, 5, 7];
const MODELS = [
  { id: 'local-workhorse', tier: 'local', pricePer1kIn: 0, pricePer1kOut: 0 },
  { id: 'local-heavy',     tier: 'local', pricePer1kIn: 0, pricePer1kOut: 0 }
];

const MAX_SCORE_PER_PROBLEM = 5;

// ------------- utils -------------
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function atomicWriteJson(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
      // fall-through → fresh
    }
  }
  return {
    iteration: 0,
    startedAt: new Date().toISOString(),
    lastIterationAt: null,
    bestScore: 0,
    bestConfig: null,
    history: [],
    plateauCount: 0,
    target: TARGET,
    status: 'running',
    exitReason: null,
    configCursor: { template: 0, similarity: 0, fewShot: 0 },
    indexSize: null
  };
}

function saveState(state) {
  state.lastIterationAt = new Date().toISOString();
  atomicWriteJson(STATE_FILE, state);
}

// Ghi report tong ket cuoi phien — an toan, khong throw
function writeFinalReport(state) {
  try {
    const lines = [];
    lines.push(`# Orcai Improve Loop — Final Report`);
    lines.push(``);
    lines.push(`- **Started:** ${state.startedAt}`);
    lines.push(`- **Ended:** ${new Date().toISOString()}`);
    lines.push(`- **Status:** \`${state.status}\``);
    lines.push(`- **Exit reason:** \`${state.exitReason || '-'}\``);
    lines.push(`- **Total iterations:** ${state.iteration}`);
    lines.push(`- **Target:** ${state.target}% | **Best score:** ${state.bestScore}%`);
    lines.push(`- **Plateau count:** ${state.plateauCount}`);
    lines.push(`- **Final index size:** ${state.indexSize || 'n/a'}`);
    lines.push(``);
    if (state.bestConfig) {
      lines.push(`## Best Config Found`);
      lines.push('```json');
      lines.push(JSON.stringify(state.bestConfig, null, 2));
      lines.push('```');
      lines.push(``);
    }
    if (Array.isArray(state.history) && state.history.length) {
      lines.push(`## Iteration Scores`);
      lines.push(`| # | Score | Delta | Wall(s) | Template | Similarity | FewShot |`);
      lines.push(`|---|---|---|---|---|---|---|`);
      for (const h of state.history) {
        const cfg = h.config || {};
        lines.push(`| ${h.iter} | ${h.score}% | ${h.deltaVsBaseline != null ? h.deltaVsBaseline : '-'} | ${h.wallTimeMs ? (h.wallTimeMs/1000).toFixed(1) : '-'} | ${cfg.template ?? '-'} | ${cfg.similarityThreshold ?? '-'} | ${cfg.fewShotCount ?? '-'} |`);
      }
      lines.push(``);
      const lastHistory = state.history[state.history.length - 1];
      if (lastHistory && lastHistory.byModel) {
        lines.push(`## Last Iteration Per-Model`);
        lines.push('```json');
        lines.push(JSON.stringify(lastHistory.byModel, null, 2));
        lines.push('```');
        lines.push(``);
      }
    }
    lines.push(`## Recommendation`);
    if (state.status === 'completed' && state.exitReason === 'target') {
      lines.push(`- ✅ Target reached. Commit best config to \`.orcai/rag-config.json\`.`);
    } else if (state.exitReason === 'plateau') {
      lines.push(`- ⚠️ RAG tuning plateau reached at ${state.bestScore}%. Next step: fine-tune Qwen 2.5 Coder 1.5B/3B using extracted dataset at \`.orcai/training/\`.`);
    } else if (state.exitReason === 'budget') {
      lines.push(`- ⛔ Budget exceeded. Increase \`.orcai/budget.json\` daily cap or route more problems to local.`);
    } else if (state.exitReason === 'max-iter' || state.exitReason === 'max-wall-time') {
      lines.push(`- ⏱ Stopped by safety limit. Best score ${state.bestScore}% — consider increasing max-iter or running another night.`);
    } else {
      lines.push(`- Review \`.orcai/improve-loop/log.jsonl\` for iteration details.`);
    }
    fs.writeFileSync(REPORT_FILE, lines.join('\n'), 'utf8');
  } catch (e) { /* report is best-effort */ }
}

function appendLog(entry) {
  ensureDir(path.dirname(LOG_FILE));
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
}

function log(msg, ...rest) {
  const line = `[improve-loop] ${new Date().toISOString()} ${msg}`;
  console.log(line, ...rest);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function inQuietHours() {
  if (!QUIET_HOURS) return false;
  const m = QUIET_HOURS.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return false;
  const from = parseInt(m[1], 10);
  const to = parseInt(m[2], 10);
  const hr = new Date().getHours();
  if (from <= to) return hr >= from && hr < to;
  return hr >= from || hr < to;
}

// ------------- Problems loader -------------
function loadProblems() {
  const realistic = path.join(PROJECT_DIR, 'test', 'problems-realistic.js');
  const generic = path.join(PROJECT_DIR, 'test', 'coding-quality-bench.js');
  try {
    if (fs.existsSync(realistic)) {
      const mod = require(realistic);
      const arr = Array.isArray(mod) ? mod : (mod.PROBLEMS || mod.problems || mod.default);
      if (Array.isArray(arr) && arr.length) return { source: 'realistic', problems: arr };
    }
  } catch (e) {
    log(`realistic problems load failed: ${e.message} — fallback to generic`);
  }
  // Fallback: import the generic bench via internal require trick
  // coding-quality-bench.js is an IIFE CLI; we mirror its PROBLEMS by re-eval
  const src = fs.readFileSync(generic, 'utf8');
  const m = src.match(/const PROBLEMS = (\[[\s\S]*?\n\]);/);
  if (!m) throw new Error('cannot extract PROBLEMS from generic bench');
  // eslint-disable-next-line no-new-func
  const PROBLEMS = Function('"use strict"; return ' + m[1])();
  return { source: 'generic', problems: PROBLEMS };
}

// ------------- RAG (optional) -------------
function tryLoadRag() {
  try {
    const { RagPromptBuilder } = require(path.join(PROJECT_DIR, 'lib', 'rag-prompt-builder'));
    const { EmbeddingStore } = require(path.join(PROJECT_DIR, 'lib', 'embeddings'));
    return { RagPromptBuilder, EmbeddingStore };
  } catch {
    return null;
  }
}

function makeRagBuilder({ similarity, fewShot }) {
  const mods = tryLoadRag();
  if (!mods) return null;
  try {
    const emb = new mods.EmbeddingStore({ projectDir: PROJECT_DIR });
    // Index path: use examples.index.json if present, else fall back to main store
    const examplesFile = path.join(PROJECT_DIR, '.orcai', 'embeddings', 'examples.index.json');
    if (fs.existsSync(examplesFile)) {
      // Wrap: return items via query() using the examples index
      const raw = JSON.parse(fs.readFileSync(examplesFile, 'utf8'));
      const items = raw.items || [];
      emb.query = async function ({ text, top_k = 5 }) {
        const [qvec] = await this.embed([text]);
        const q = qvec.slice();
        let norm = 0; for (const v of q) norm += v * v; norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < q.length; i++) q[i] /= norm;
        const scored = items.map(it => {
          let s = 0; const v = it.vector;
          const n = Math.min(q.length, v.length);
          for (let i = 0; i < n; i++) s += q[i] * v[i];
          return { id: it.id, score: s, text: it.text, metadata: it.metadata };
        });
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, top_k);
      };
    }
    return new mods.RagPromptBuilder({
      projectDir: PROJECT_DIR,
      embeddings: emb,
      maxExamples: fewShot,
      minSimilarity: similarity
    });
  } catch (e) {
    log(`RAG builder init failed: ${e.message}`);
    return null;
  }
}

function countIndexSize() {
  const f = path.join(PROJECT_DIR, '.orcai', 'embeddings', 'examples.index.json');
  if (!fs.existsSync(f)) return 0;
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    return (raw.items || []).length;
  } catch { return 0; }
}

// ------------- LiteLLM call -------------
async function callLLM({ model, systemPrompt, userMessage }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    temperature: 0.2,
    max_tokens: 1500
  };
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 90_000);
  const started = Date.now();
  try {
    const r = await fetch(`${LITELLM_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(LITELLM_KEY ? { authorization: `Bearer ${LITELLM_KEY}` } : {})
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    clearTimeout(to);
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return { skipped: true, reason: `HTTP ${r.status}: ${text.slice(0, 180)}`, latencyMs: Date.now() - started };
    }
    const j = await r.json();
    const content = j?.choices?.[0]?.message?.content || '';
    const usage = j?.usage || {};
    return {
      content,
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      latencyMs: Date.now() - started
    };
  } catch (e) {
    clearTimeout(to);
    return { skipped: true, reason: String(e.message || e), latencyMs: Date.now() - started };
  }
}

// ------------- Scoring (mirrored from coding-quality-bench.js) -------------
function extractCode(content) {
  if (!content) return '';
  const blocks = [...content.matchAll(/```(?:\w+)?\s*\n([\s\S]*?)```/g)].map(m => m[1]);
  return blocks.length ? blocks.join('\n') : content;
}

function bracesBalanced(s) {
  let c = 0, p = 0, b = 0;
  for (const ch of s) {
    if (ch === '{') c++; else if (ch === '}') c--;
    else if (ch === '(') p++; else if (ch === ')') p--;
    else if (ch === '[') b++; else if (ch === ']') b--;
  }
  return c === 0 && p === 0 && b === 0;
}

function syntaxCheck(code, lang) {
  if (!code || !code.trim()) return { ok: false, reason: 'empty' };
  const tmp = path.join(os.tmpdir(), `iloop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    if (lang === 'js') {
      fs.writeFileSync(tmp + '.js', code);
      const r = spawnSync(process.execPath, ['--check', tmp + '.js'], { encoding: 'utf8' });
      if (r.status === 0) return { ok: true };
      fs.writeFileSync(tmp + '.js', `(async()=>{${code}})();`);
      const r2 = spawnSync(process.execPath, ['--check', tmp + '.js'], { encoding: 'utf8' });
      return r2.status === 0 ? { ok: true } : { ok: false, reason: (r.stderr || '').slice(0, 160) };
    }
    if (lang === 'ts') return { ok: bracesBalanced(code), reason: 'ts-soft' };
    if (lang === 'py') return { ok: bracesBalanced(code), reason: 'py-soft' };
    if (lang === 'yaml') return { ok: /services\s*:/.test(code) && !/\t/.test(code), reason: 'yaml-soft' };
    return { ok: true };
  } finally {
    try { fs.unlinkSync(tmp + '.js'); } catch {}
    try { fs.unlinkSync(tmp + '.py'); } catch {}
  }
}

function scoreResult(problem, content) {
  const code = extractCode(content);
  const breakdown = { compiles: 0, hasTest: 0, edgeCases: 0, goodPractices: 0 };
  const chk = syntaxCheck(code, problem.lang);
  if (chk.ok) breakdown.compiles = 1;
  if (problem.testMarker && problem.testMarker.test(code)) breakdown.hasTest = 1;
  const keywords = problem.keywords || [];
  const kwHits = keywords.filter(re => re.test(code)).length;
  breakdown.edgeCases = Math.min(2, kwHits >= keywords.length ? 2 : kwHits >= Math.ceil(keywords.length/2) ? 1 : 0);
  const bad = problem.badPractices || [];
  const badHits = bad.filter(re => re.test(code)).length;
  breakdown.goodPractices = badHits === 0 ? 1 : 0;
  const score = breakdown.compiles + breakdown.hasTest + breakdown.edgeCases + breakdown.goodPractices;
  return { score, breakdown };
}

// ------------- bench harness (fallback) -------------
async function runBench({ problems, template, similarity, fewShot }) {
  const rag = makeRagBuilder({ similarity, fewShot });
  const systemBase = template.text;

  const perModel = {};
  for (const m of MODELS) perModel[m.id] = { total: 0, max: 0, byProblem: {}, skipped: 0 };

  for (const problem of problems) {
    const lang = problem.lang || 'js';
    let systemPrompt = systemBase;
    if (rag) {
      try {
        systemPrompt = await rag.build({
          basePrompt: systemBase,
          userMessage: problem.prompt,
          modelId: 'local-workhorse'
        });
      } catch (e) {
        // silent; fall back to base
      }
    }

    const calls = MODELS.map(m => callLLM({
      model: m.id,
      systemPrompt,
      userMessage: problem.prompt
    }).then(r => ({ m, r, problem, lang })));

    const results = await Promise.all(calls);
    for (const { m, r, problem: p } of results) {
      const bucket = perModel[m.id];
      bucket.max += MAX_SCORE_PER_PROBLEM;
      if (r.skipped) {
        bucket.skipped++;
        bucket.byProblem[p.id] = { score: 0, skipped: true, reason: r.reason };
        continue;
      }
      const s = scoreResult(p, r.content);
      bucket.total += s.score;
      bucket.byProblem[p.id] = { score: s.score, breakdown: s.breakdown };
    }
  }

  const summary = {};
  for (const id of Object.keys(perModel)) {
    const b = perModel[id];
    summary[id] = {
      total: b.total,
      max: b.max,
      avgPct: b.max > 0 ? (b.total / b.max) * 100 : 0,
      skipped: b.skipped,
      byProblem: b.byProblem
    };
  }
  return summary;
}

// ------------- Weak-problem detection + index expansion -------------
function findWeakProblems(byModel, problems) {
  const weak = [];
  for (const p of problems) {
    let allLow = true;
    for (const id of Object.keys(byModel)) {
      const r = byModel[id].byProblem[p.id];
      if (!r) { allLow = false; break; }
      if (r.score >= 4) { allLow = false; break; }
    }
    if (allLow) weak.push(p);
  }
  return weak;
}

async function expandIndexForWeak(weakProblems) {
  const before = countIndexSize();
  const devRoot = process.env.ORCAI_LOOP_DEV_ROOT || 'E:\\DEVELOP';
  // Tri thức: re-index toàn dev root cho weak problems (bin/orcai-index-examples chạy trên root)
  // Để giữ an toàn: chạy 1 lần trên project root để đảm bảo ít nhất ai-orchestrator được index
  try {
    const script = path.join(PROJECT_DIR, 'bin', 'orcai-index-examples.js');
    if (!fs.existsSync(script)) return { added: 0, before, after: before };
    // Chạy với --root trỏ đến PROJECT_DIR để idempotent và nhanh
    const r = spawnSync(process.execPath, [script, '--root', PROJECT_DIR], {
      encoding: 'utf8',
      timeout: 10 * 60_000
    });
    if (r.status !== 0) {
      log(`index-examples failed status=${r.status}: ${(r.stderr || '').slice(0, 200)}`);
    }
  } catch (e) {
    log(`index expansion error: ${e.message}`);
  }
  const after = countIndexSize();
  return { added: after - before, before, after };
}

// ------------- main loop -------------
async function mainLoop() {
  ensureDir(STATE_DIR);
  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}

  const state = loadState();
  state.status = 'running';
  state.target = TARGET;
  saveState(state);

  // Signal handlers — save state & exit gracefully
  let finalizing = false;
  const finalize = (reason, code = 0) => {
    if (finalizing) return;
    finalizing = true;
    state.status = code === 0 ? state.status : 'aborted';
    if (!state.exitReason) state.exitReason = reason;
    saveState(state);
    writeFinalReport(state);
    appendLog({ type: 'exit', at: new Date().toISOString(), reason, status: state.status });
    try { fs.unlinkSync(PID_FILE); } catch {}
    process.exit(code);
  };
  process.on('SIGTERM', () => { state.status = 'aborted'; finalize('signal-term', 0); });
  process.on('SIGINT', () => { state.status = 'aborted'; finalize('signal-int', 0); });
  process.on('uncaughtException', (err) => {
    log(`uncaughtException: ${err.stack || err.message}`);
    appendLog({ type: 'uncaught', at: new Date().toISOString(), error: String(err.message || err) });
    state.status = 'failed';
    finalize('uncaught', 1);
  });
  process.on('unhandledRejection', (err) => {
    log(`unhandledRejection: ${err && (err.stack || err.message)}`);
    appendLog({ type: 'unhandled', at: new Date().toISOString(), error: String(err && (err.message || err)) });
    state.status = 'failed';
    finalize('unhandled', 1);
  });

  const loopStart = Date.now();
  const maxWallMs = MAX_HOURS * 3600 * 1000;

  // Load problems
  let problemsSet;
  try {
    problemsSet = loadProblems();
    log(`loaded ${problemsSet.problems.length} problems (${problemsSet.source})`);
  } catch (e) {
    state.status = 'failed';
    state.exitReason = `problems-load: ${e.message}`;
    saveState(state);
    finalize(state.exitReason, 1);
    return;
  }

  state.indexSize = countIndexSize();

  while (true) {
    // Quiet hours
    if (inQuietHours()) {
      log(`quiet hours active (${QUIET_HOURS}) — sleeping 15 min`);
      await sleep(15 * 60_000);
      continue;
    }

    // Wall time
    if (Date.now() - loopStart > maxWallMs) {
      state.status = 'completed';
      state.exitReason = 'max-wall-time';
      saveState(state);
      finalize('max-wall-time', 0);
      return;
    }

    // Max iter
    if (state.iteration >= MAX_ITER) {
      state.status = 'completed';
      state.exitReason = 'max-iter';
      saveState(state);
      finalize('max-iter', 0);
      return;
    }

    // Budget check — tolerant: if unavailable, keep going
    try {
      const { enforceHardCap, BudgetExceededError } = require(path.join(PROJECT_DIR, 'lib', 'budget'));
      try {
        enforceHardCap('improve-loop', 0.02, PROJECT_DIR);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          state.status = 'aborted';
          state.exitReason = 'budget';
          saveState(state);
          appendLog({ type: 'budget-abort', at: new Date().toISOString(), message: err.message });
          finalize('budget', 0);
          return;
        }
        throw err;
      }
    } catch (e) {
      if (e && e.name === 'BudgetExceededError') {
        state.status = 'aborted';
        state.exitReason = 'budget';
        saveState(state);
        finalize('budget', 0);
        return;
      }
      // module missing or other → continue (logged once)
      if (state.iteration === 0) log(`budget check soft-fail: ${e.message}`);
    }

    // Pick config
    const template = TEMPLATES[state.configCursor.template];
    const similarity = SIMILARITY_GRID[state.configCursor.similarity];
    const fewShot = FEWSHOT_GRID[state.configCursor.fewShot];

    state.iteration++;
    const iterStart = Date.now();
    log(`iter=${state.iteration} template=${template.id} sim=${similarity} fewShot=${fewShot} idx=${state.indexSize}`);

    let byModel;
    try {
      byModel = await runBench({
        problems: problemsSet.problems,
        template,
        similarity,
        fewShot
      });
    } catch (e) {
      log(`bench error: ${e.message}`);
      appendLog({ type: 'bench-error', iter: state.iteration, error: e.message });
      byModel = {};
      for (const m of MODELS) byModel[m.id] = { total: 0, max: problemsSet.problems.length * MAX_SCORE_PER_PROBLEM, avgPct: 0, skipped: problemsSet.problems.length, byProblem: {} };
    }

    // Best model score
    let bestModelPct = 0;
    let bestModelId = null;
    for (const id of Object.keys(byModel)) {
      const pct = byModel[id].avgPct || 0;
      if (pct > bestModelPct) { bestModelPct = pct; bestModelId = id; }
    }

    const wallTimeMs = Date.now() - iterStart;
    const deltaVsBaseline = bestModelPct - (state.history[0]?.score || 0);
    const entry = {
      iter: state.iteration,
      at: new Date().toISOString(),
      score: bestModelPct,
      bestModelId,
      byModel,
      config: {
        template: template.id,
        similarityThreshold: similarity,
        fewShotCount: fewShot,
        indexSize: state.indexSize
      },
      deltaVsBaseline,
      wallTimeMs
    };
    state.history.push(entry);
    appendLog({ type: 'iter', ...entry });

    // Plateau
    const improvement = bestModelPct - state.bestScore;
    if (bestModelPct > state.bestScore + 0.0001) {
      state.bestScore = bestModelPct;
      state.bestConfig = { ...entry.config };
    }
    if (improvement <= 0.5) {
      state.plateauCount++;
    } else {
      state.plateauCount = 0;
    }

    // Target reached
    if (bestModelPct >= TARGET) {
      state.status = 'completed';
      state.exitReason = 'target';
      saveState(state);
      log(`TARGET reached: ${bestModelPct.toFixed(2)}% >= ${TARGET}%`);
      finalize('target', 0);
      return;
    }

    // Plateau exit
    if (state.plateauCount >= 3) {
      state.status = 'completed';
      state.exitReason = 'plateau';
      saveState(state);
      log(`plateau (3 iterations, no >0.5% improvement) — exiting`);
      finalize('plateau', 0);
      return;
    }

    // Weak-problem analysis → try to expand index
    const weak = findWeakProblems(byModel, problemsSet.problems);
    let indexGrew = false;
    if (weak.length > 0) {
      log(`weak problems: ${weak.map(p => p.id).join(',')} — attempting index expansion`);
      try {
        const res = await expandIndexForWeak(weak);
        if (res.added > 0) {
          state.indexSize = res.after;
          indexGrew = true;
          log(`index grew by ${res.added} chunks (total ${res.after})`);
        } else {
          log(`index stable at ${res.after}`);
        }
      } catch (e) {
        log(`index expansion error: ${e.message}`);
      }
    }

    // If index stable → advance config cursor
    if (!indexGrew) {
      const c = state.configCursor;
      if (c.template + 1 < TEMPLATES.length) c.template++;
      else if (c.similarity + 1 < SIMILARITY_GRID.length) { c.template = 0; c.similarity++; }
      else if (c.fewShot + 1 < FEWSHOT_GRID.length) { c.template = 0; c.similarity = 0; c.fewShot++; }
      // else: exhausted → plateauCount will push us out
    }

    saveState(state);

    log(`iter=${state.iteration} bestModel=${bestModelId} pct=${bestModelPct.toFixed(2)}% plateau=${state.plateauCount} ${wallTimeMs}ms`);

    // Cooldown (GPU thermal)
    if (COOLDOWN_MS > 0) await sleep(COOLDOWN_MS);
  }
}

if (require.main === module) {
  mainLoop().catch(err => {
    console.error('[improve-loop] fatal:', err && (err.stack || err.message));
    try {
      const st = loadState();
      st.status = 'failed';
      st.exitReason = `fatal: ${err.message}`;
      saveState(st);
    } catch {}
    process.exit(1);
  });
}

module.exports = {
  loadState, saveState, atomicWriteJson,
  findWeakProblems, TEMPLATES, SIMILARITY_GRID, FEWSHOT_GRID,
  STATE_FILE, LOG_FILE
};
