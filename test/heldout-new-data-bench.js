#!/usr/bin/env node
// Held-out eval: sample pairs NOT in R7 training (R8 new data),
// run target model (default local-heavy = R7), score with Gemini judge.
//
// Usage:
//   node test/heldout-new-data-bench.js                              # R7 baseline
//   TARGET_MODEL=local-heavy-r8 node test/heldout-new-data-bench.js  # when R8 loaded
//
// Output: .orcai/ft-output-v2/bench-heldout-<TAG>.json
// Sample is deterministic (seed=2604) so R7 and R8 see identical problems.

'use strict';

const fs = require('fs');
const path = require('path');

const LMS_URL = 'http://localhost:1234/v1/chat/completions';
const LITELLM_URL = 'http://localhost:5002/v1/chat/completions';
const LITELLM_KEY = 'sk-master-change-me';
const TARGET_MODEL = process.env.TARGET_MODEL || 'local-heavy';
const TAG = process.env.TAG || 'r7-baseline';
const SAMPLE_N = Number(process.env.SAMPLE_N || 20);
const SEED = 2604;

const OUT_DIR = '.orcai/ft-output-v2';
const OUT_FILE = path.join(OUT_DIR, `bench-heldout-${TAG}.json`);

// Mulberry32 deterministic RNG
function mkRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function loadJsonl(p) {
  return fs.readFileSync(p, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}

function sampleDeterministic(arr, n, rng) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

async function callChat(url, key, model, messages, timeoutMs = 120000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 2048 }),
      signal: ctl.signal,
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    return j.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(t);
  }
}

async function judge(userPrompt, refAnswer, modelOutput) {
  const judgePrompt = [
    { role: 'system', content: 'You are a strict senior code reviewer. Score responses 0-5 on correctness + completeness vs the reference.' },
    { role: 'user', content:
`Score the MODEL RESPONSE against the REFERENCE ANSWER for the USER PROMPT.

Scoring:
0 = irrelevant/nonsense
1 = attempts, mostly wrong
2 = partial, major gaps
3 = acceptable, minor issues
4 = good, small differences vs reference
5 = equivalent or better than reference

Return ONLY a JSON object on a single line: {"score": N, "reason": "<short>"}

USER PROMPT:
${userPrompt.slice(0, 2000)}

REFERENCE ANSWER:
${refAnswer.slice(0, 3000)}

MODEL RESPONSE:
${modelOutput.slice(0, 3000)}`,
    },
  ];
  const raw = await callChat(LITELLM_URL, LITELLM_KEY, 'gemini', judgePrompt, 90000);
  const m = raw.match(/\{[^}]*"score"[^}]*\}/);
  if (!m) return { score: 0, reason: `judge-parse-fail: ${raw.slice(0, 120)}` };
  try {
    const o = JSON.parse(m[0]);
    return { score: Number(o.score) || 0, reason: String(o.reason || '').slice(0, 200) };
  } catch {
    return { score: 0, reason: `judge-json-fail: ${m[0].slice(0, 120)}` };
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Load new-data pairs (NOT in R7 training). R7 trained on original/* only.
  // New = scraped-pairs + agent-gen/*
  const scraped = loadJsonl('.orcai/training/scraped-pairs.jsonl')
    .map(p => ({ ...p, _origin: 'scraped' }));
  const agentFiles = fs.readdirSync('.orcai/training/agent-gen')
    .filter(f => f.endsWith('.jsonl'));
  const agentGen = [];
  for (const f of agentFiles) {
    const pairs = loadJsonl(path.join('.orcai/training/agent-gen', f))
      .map(p => ({ ...p, _origin: `agent-gen/${f.replace('.jsonl','')}` }));
    agentGen.push(...pairs);
  }

  // Filter: only pairs with reasonable size (user < 1500, assistant < 2500 chars)
  const usable = [...scraped, ...agentGen].filter(p => {
    const u = p.messages?.find(m => m.role === 'user')?.content ?? '';
    const a = p.messages?.find(m => m.role === 'assistant')?.content ?? '';
    return u.length >= 20 && u.length <= 1500 && a.length >= 50 && a.length <= 2500;
  });
  console.log(`[load] scraped=${scraped.length} agent-gen=${agentGen.length} usable=${usable.length}`);

  const rng = mkRng(SEED);
  const sample = sampleDeterministic(usable, SAMPLE_N, rng);

  console.log(`[sample] ${sample.length} problems, seed=${SEED}, target=${TARGET_MODEL}, tag=${TAG}`);
  console.log(`[sample] origins: ${Object.entries(sample.reduce((a,p)=>((a[p._origin]=(a[p._origin]||0)+1),a),{})).map(([k,v])=>`${k}=${v}`).join(', ')}`);

  const results = [];
  let totalScore = 0;
  const t0 = Date.now();

  for (let i = 0; i < sample.length; i++) {
    const p = sample[i];
    const user = p.messages.find(m => m.role === 'user').content;
    const ref = p.messages.find(m => m.role === 'assistant').content;
    const t1 = Date.now();
    let modelOut = '';
    let err = null;
    try {
      modelOut = await callChat(LMS_URL, '', TARGET_MODEL, [
        { role: 'system', content: 'You are a senior engineer. Return the requested code/answer concisely.' },
        { role: 'user', content: user },
      ], 120000);
    } catch (e) {
      err = e.message;
    }
    const dur = Date.now() - t1;

    let judgeResult = { score: 0, reason: 'no-model-output' };
    if (modelOut && !err) {
      try {
        judgeResult = await judge(user, ref, modelOut);
      } catch (e) {
        judgeResult = { score: 0, reason: `judge-err: ${e.message.slice(0,100)}` };
      }
    }
    totalScore += judgeResult.score;
    const rec = {
      idx: i + 1,
      origin: p._origin,
      meta: p.meta || {},
      user_len: user.length,
      ref_len: ref.length,
      out_len: modelOut.length,
      duration_ms: dur,
      err,
      score: judgeResult.score,
      reason: judgeResult.reason,
      user_snip: user.slice(0, 160),
      out_snip: modelOut.slice(0, 240),
    };
    results.push(rec);
    console.log(`[${i+1}/${sample.length}] ${p._origin} score=${judgeResult.score}/5 (${dur}ms) ${err ? `ERR: ${err.slice(0,80)}` : judgeResult.reason.slice(0,80)}`);
  }

  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  const max = sample.length * 5;
  const pct = ((totalScore / max) * 100).toFixed(1);
  const summary = {
    tag: TAG,
    target_model: TARGET_MODEL,
    seed: SEED,
    n: sample.length,
    total_score: totalScore,
    max_score: max,
    percent: Number(pct),
    duration_sec: Number(dur),
    generated_at: new Date().toISOString(),
    per_origin: results.reduce((a, r) => {
      const k = r.origin;
      a[k] ??= { n: 0, score: 0 };
      a[k].n += 1; a[k].score += r.score;
      return a;
    }, {}),
    results,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(summary, null, 2));
  console.log(`\n=== DONE ===\n${TAG}: ${totalScore}/${max} (${pct}%) in ${dur}s\n→ ${OUT_FILE}`);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
