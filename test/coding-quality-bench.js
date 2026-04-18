#!/usr/bin/env node
// Standalone coding-quality benchmark (NOT picked up by `npm test`).
// Usage:
//   node test/coding-quality-bench.js
//   node test/coding-quality-bench.js --models smart,fast --problems 1-3,5
//   node test/coding-quality-bench.js --mock
//   node test/coding-quality-bench.js --out .orcai/bench-results.json

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ---- Config ----
const LITELLM_URL = process.env.LITELLM_URL || 'http://localhost:4001';
const LITELLM_KEY = process.env.LITELLM_KEY || process.env.LITELLM_API_KEY || '';
const TIMEOUT_MS = 60_000;

const ALL_MODELS = [
  { id: 'local-workhorse', tier: 'local',   pricePer1kIn: 0,       pricePer1kOut: 0 },
  { id: 'local-heavy',     tier: 'local',   pricePer1kIn: 0,       pricePer1kOut: 0 },
  { id: 'qwen2.5-coder-7b-instruct', tier: 'local', pricePer1kIn: 0, pricePer1kOut: 0 },
  { id: 'qwen2.5-coder-3b-instruct', tier: 'local', pricePer1kIn: 0, pricePer1kOut: 0 },
  { id: 'cheap',           tier: 'cheap',   pricePer1kIn: 0.00015, pricePer1kOut: 0.0006 },
  { id: 'fast',            tier: 'fast',    pricePer1kIn: 0.00030, pricePer1kOut: 0.0025 },
  { id: 'smart',           tier: 'smart',   pricePer1kIn: 0.003,   pricePer1kOut: 0.015 },
  { id: 'architect',       tier: 'architect', pricePer1kIn: 0.015, pricePer1kOut: 0.075 },
];

// ---- Problems ----
const PROBLEMS = [
  {
    id: 1, key: 'debounce', lang: 'js',
    prompt: "Viet function `debounce(fn, wait)` trong JS, khong dung lib, kem 1 test Jest. Chi tra code, khong giai thich.",
    hint: "Dam bao clearTimeout truoc moi lan goi; test phai co describe/it va dung jest.useFakeTimers.",
    keywords: [/setTimeout/, /clearTimeout/, /\.apply|\.call|\.\.\.args/],
    testMarker: /describe\s*\(|test\s*\(|it\s*\(|expect\s*\(/,
    badPractices: [/console\.log/],
  },
  {
    id: 2, key: 'deep-partial', lang: 'ts',
    prompt: "Viet type `DeepPartial<T>` trong TypeScript, xu ly array + union. Chi tra code TS.",
    hint: "Can xu ly T extends Array<infer U>, union types qua distributive conditional, va object recursion.",
    keywords: [/infer\s+\w+/, /extends/, /\?\s*:/],
    testMarker: /\/\/.*example|\/\*.*example|type\s+\w+\s*=/i,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 3, key: 'next-action', lang: 'ts',
    prompt: "Viet Server Action trong Next.js 15 nhan form FormData, validate voi zod, return `{ok, errors}`. Chi viet file action, khong can component.",
    hint: "Nho 'use server' directive, z.object schema, safeParse, return shape on error.",
    keywords: [/['"]use server['"]/, /zod|z\.(object|string|number)/, /safeParse|parse\(/],
    testMarker: /ok\s*:|errors\s*:/,
    badPractices: [/:\s*any\b/],
  },
  {
    id: 4, key: 'rate-limit', lang: 'js',
    prompt: "Viet Express middleware rate-limit sliding window, giu trong Map, 60 req/phut/IP. Chi tra code JS.",
    hint: "Dung Date.now(), filter timestamps trong window 60s, response 429 khi vuot.",
    keywords: [/Map\(/, /Date\.now|performance\.now/, /429/, /req\.ip|x-forwarded-for/i],
    testMarker: /module\.exports|export\s+(default|const|function)/,
    badPractices: [/console\.log/],
  },
  {
    id: 5, key: 'compose', lang: 'yaml',
    prompt: "Viet docker-compose.yml co: 1 Node app port 3000, 1 Postgres 16 co healthcheck, mount volume db-data. Format v2.30+. Chi tra YAML.",
    hint: "Healthcheck dung pg_isready, depends_on voi condition: service_healthy, volumes: db-data: {}.",
    keywords: [/postgres:16/i, /healthcheck/, /pg_isready|pg_is_ready/i, /volumes\s*:/],
    testMarker: /services\s*:/,
    badPractices: [/version\s*:\s*['"]?2\.[0-9]['"]?/],
  },
  {
    id: 6, key: 'retry', lang: 'py',
    prompt: "Viet decorator `@retry(max=3, backoff=2)` cho function async trong Python, log moi lan fail. Chi tra code Python.",
    hint: "functools.wraps, asyncio.sleep(backoff ** attempt), raise cuoi cung neu het retry, dung logging.",
    keywords: [/async\s+def|asyncio/, /functools\.wraps|@wraps/, /logging|logger|print/, /sleep/],
    testMarker: /def\s+retry|@retry/,
    badPractices: [/time\.sleep/],
  },
  {
    id: 7, key: 'debug-stale', lang: 'js',
    prompt:
      "Bug trong React component sau — tim va fix. Giai thich 1 dong, roi viet ban da sua:\n" +
      "```jsx\nfunction Counter(){\n  const [n,setN]=useState(0);\n  useEffect(()=>{\n    const id=setInterval(()=>setN(n+1),1000);\n    return ()=>clearInterval(id);\n  },[]);\n  return <div>{n}</div>;\n}\n```",
    hint: "Stale closure — n bi capture luc mount. Dung functional update setN(v=>v+1) hoac dep array [n].",
    keywords: [/setN\s*\(\s*\w+\s*=>|setN\(\s*prev|setN\(\s*n\s*=>/, /stale|closure|functional/i],
    testMarker: /useEffect|clearInterval/,
    badPractices: [/console\.log/],
  },
  {
    id: 8, key: 'refactor', lang: 'js',
    prompt:
      "Refactor function sau thanh 3 pure function nho, giu behavior. Chi tra code:\n" +
      "```js\nfunction processOrders(orders){\n  let total=0; const out=[];\n  for(const o of orders){\n    if(!o.active) continue;\n    const tax=o.price*0.1;\n    const net=o.price+tax;\n    total+=net;\n    out.push({id:o.id, net, tax, label:`#${o.id} - $${net.toFixed(2)}`});\n  }\n  return {items:out, total};\n}\n```",
    hint: "Tach: filterActive(orders), calcLine(order), sumTotal(lines). Moi ham pure, no side effects.",
    keywords: [/filter|Active/, /calc|line|tax/i, /sum|total|reduce/i],
    testMarker: /function\s+\w+|const\s+\w+\s*=\s*\(/,
    badPractices: [/let\s+total\s*=/],
  },
];

// ---- CLI parse ----
function parseArgs(argv) {
  const args = { models: null, problems: null, out: '.orcai/bench-results.json', mock: false, problemSet: 'generic' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') args.mock = true;
    else if (a === '--models') args.models = argv[++i].split(',').map(s => s.trim());
    else if (a === '--problems') args.problems = expandRange(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--problem-set') args.problemSet = argv[++i];
  }
  return args;
}

// Load alternate problem set — tries test/problems/<name>.js then test/problems-<name>.js.
// Realistic set (derived from patterns across E:\DEVELOP\* projects) lives at test/problems-realistic.js.
function loadProblemSet(name) {
  if (!name || name === 'generic') return PROBLEMS;
  const candidates = [
    path.join(__dirname, 'problems', `${name}.js`),
    path.join(__dirname, `problems-${name}.js`),
  ];
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    try {
      const mod = require(c);
      const arr = Array.isArray(mod)
        ? mod
        : (mod.PROBLEMS || mod.problems || mod.PROBLEMS_REALISTIC || mod.default);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (e) {
      console.warn(`[bench] could not load problem-set '${name}' at ${c}: ${e.message}`);
    }
  }
  console.warn(`[bench] problem-set '${name}' not found — falling back to generic`);
  return PROBLEMS;
}
function expandRange(spec) {
  const set = new Set();
  for (const part of spec.split(',')) {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      for (let i = a; i <= b; i++) set.add(i);
    } else set.add(Number(part));
  }
  return [...set];
}

// ---- LLM call ----
async function callModel(model, prompt, mock) {
  const started = Date.now();
  if (mock) return mockResponse(model, prompt, started);

  const body = {
    model: model.id,
    messages: [
      { role: 'system', content: 'You are a senior engineer. Return only the code requested, no prose unless the prompt asks for it.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
    max_tokens: 1500,
  };

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${LITELLM_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(LITELLM_KEY ? { authorization: `Bearer ${LITELLM_KEY}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
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
      latencyMs: Date.now() - started,
    };
  } catch (e) {
    clearTimeout(to);
    return { skipped: true, reason: String(e.message || e), latencyMs: Date.now() - started };
  }
}

// ---- Mock ----
function mockResponse(model, prompt, started) {
  const q = prompt.toLowerCase();
  const canned =
    q.includes('debounce')
      ? "```js\nfunction debounce(fn, wait){let t;return function(...args){clearTimeout(t);t=setTimeout(()=>fn.apply(this,args),wait);};}\nmodule.exports={debounce};\n// test\ndescribe('debounce',()=>{jest.useFakeTimers();it('delays',()=>{const s=jest.fn();const d=debounce(s,100);d();d();jest.runAllTimers();expect(s).toHaveBeenCalledTimes(1);});});\n```"
    : q.includes('deeppartial')
      ? "```ts\ntype DeepPartial<T> = T extends (infer U)[] ? DeepPartial<U>[] : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;\n// example\ntype X = DeepPartial<{a:{b:number[]}}>;\n```"
    : q.includes('server action')
      ? "```ts\n'use server';\nimport { z } from 'zod';\nconst Schema = z.object({ email: z.string().email() });\nexport async function submit(formData: FormData){\n  const data = Object.fromEntries(formData);\n  const res = Schema.safeParse(data);\n  if(!res.success) return { ok:false, errors: res.error.flatten().fieldErrors };\n  return { ok:true, errors:{} };\n}\n```"
    : q.includes('rate-limit') || q.includes('sliding')
      ? "```js\nconst hits = new Map();\nmodule.exports = function rateLimit(req,res,next){\n  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';\n  const now = Date.now();\n  const arr = (hits.get(ip)||[]).filter(t => now - t < 60000);\n  if(arr.length >= 60) return res.status(429).json({error:'Too many requests'});\n  arr.push(now); hits.set(ip, arr); next();\n};\n```"
    : q.includes('docker-compose')
      ? "```yaml\nservices:\n  app:\n    image: node:20\n    ports: [\"3000:3000\"]\n    depends_on:\n      db:\n        condition: service_healthy\n  db:\n    image: postgres:16\n    volumes: [db-data:/var/lib/postgresql/data]\n    healthcheck:\n      test: [\"CMD-SHELL\", \"pg_isready -U postgres\"]\n      interval: 5s\nvolumes:\n  db-data: {}\n```"
    : q.includes('retry') && q.includes('async')
      ? "```python\nimport asyncio, functools, logging\nlogger = logging.getLogger(__name__)\ndef retry(max=3, backoff=2):\n    def deco(fn):\n        @functools.wraps(fn)\n        async def wrap(*a, **kw):\n            last=None\n            for i in range(max):\n                try: return await fn(*a,**kw)\n                except Exception as e:\n                    last=e; logger.warning('attempt %d failed: %s', i+1, e)\n                    await asyncio.sleep(backoff ** i)\n            raise last\n        return wrap\n    return deco\n```"
    : q.includes('stale') || q.includes('counter')
      ? "Stale closure: `n` is captured at mount. Fix with functional update.\n```jsx\nfunction Counter(){\n  const [n,setN]=useState(0);\n  useEffect(()=>{\n    const id=setInterval(()=>setN(v=>v+1),1000);\n    return ()=>clearInterval(id);\n  },[]);\n  return <div>{n}</div>;\n}\n```"
    : q.includes('refactor')
      ? "```js\nconst filterActive = orders => orders.filter(o => o.active);\nconst calcLine = o => { const tax = o.price*0.1; const net = o.price+tax; return { id:o.id, net, tax, label:`#${o.id} - $${net.toFixed(2)}` }; };\nconst sumTotal = lines => lines.reduce((s,l)=>s+l.net,0);\nfunction processOrders(orders){ const items = filterActive(orders).map(calcLine); return { items, total: sumTotal(items) }; }\n```"
      : "```js\n// no match\n```";

  // Model tier affects quality in mock: local-workhorse drops snippets sometimes
  const content = model.id === 'local-workhorse' ? canned.replace(/describe[\s\S]*?;\}\);/, '') : canned;
  const promptTokens = Math.ceil(prompt.length / 4);
  const completionTokens = Math.ceil(content.length / 4);
  const latency = model.tier === 'local' ? 1200 + Math.random()*400
                 : model.tier === 'cheap' ? 800 + Math.random()*300
                 : model.tier === 'fast'  ? 600 + Math.random()*200
                 : model.tier === 'smart' ? 1800 + Math.random()*500
                 : 3000 + Math.random()*800;
  return { content, promptTokens, completionTokens, latencyMs: Math.round(Date.now() - started + latency) };
}

// ---- Extract code from response ----
function extractCode(content) {
  if (!content) return '';
  const blocks = [...content.matchAll(/```(?:\w+)?\s*\n([\s\S]*?)```/g)].map(m => m[1]);
  return blocks.length ? blocks.join('\n') : content;
}

// ---- Syntax check ----
function syntaxCheck(code, lang) {
  if (!code || !code.trim()) return { ok: false, reason: 'empty' };
  const tmp = path.join(os.tmpdir(), `bench-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    if (lang === 'js') {
      fs.writeFileSync(tmp + '.js', code);
      // Strip JSX-ish top-level return tags by wrapping in a dummy if we detect JSX
      const r = spawnSync(process.execPath, ['--check', tmp + '.js'], { encoding: 'utf8' });
      if (r.status === 0) return { ok: true };
      // retry: wrap in function body
      fs.writeFileSync(tmp + '.js', `(async()=>{${code}})();`);
      const r2 = spawnSync(process.execPath, ['--check', tmp + '.js'], { encoding: 'utf8' });
      return r2.status === 0 ? { ok: true } : { ok: false, reason: (r.stderr || '').slice(0, 160) };
    }
    if (lang === 'ts') {
      // Best-effort: TS compile optional — accept as parse-ok if it looks like TS and braces balance
      return { ok: bracesBalanced(code), reason: 'ts-soft-check' };
    }
    if (lang === 'py') {
      fs.writeFileSync(tmp + '.py', code);
      const candidates = ['py', 'python', 'python3'];
      for (const c of candidates) {
        const r = spawnSync(c, ['-m', 'py_compile', tmp + '.py'], { encoding: 'utf8' });
        if (r.status === 0) return { ok: true };
        if (r.status !== null) return { ok: false, reason: (r.stderr || '').slice(0, 160) };
      }
      // Python not installed — soft check
      return { ok: bracesBalanced(code, 'py'), reason: 'py-soft-check' };
    }
    if (lang === 'yaml') {
      try {
        // Try js-yaml if available
        const yaml = (() => { try { return require('js-yaml'); } catch { return null; } })();
        if (yaml) { yaml.load(code); return { ok: true }; }
        // Soft: indentation-based heuristic
        return { ok: /services\s*:/.test(code) && !/\t/.test(code), reason: 'yaml-soft-check' };
      } catch (e) { return { ok: false, reason: String(e.message).slice(0, 160) }; }
    }
    return { ok: true };
  } finally {
    try { fs.unlinkSync(tmp + '.js'); } catch {}
    try { fs.unlinkSync(tmp + '.py'); } catch {}
  }
}
function bracesBalanced(s, lang) {
  if (lang === 'py') return !/^\s+\t/m.test(s); // mixed indent check
  let c = 0, p = 0, b = 0;
  for (const ch of s) { if (ch === '{') c++; else if (ch === '}') c--; else if (ch === '(') p++; else if (ch === ')') p--; else if (ch === '[') b++; else if (ch === ']') b--; }
  return c === 0 && p === 0 && b === 0;
}

// ---- Scoring ----
function scoreResult(problem, content) {
  const code = extractCode(content);
  const breakdown = { compiles: 0, hasTest: 0, edgeCases: 0, goodPractices: 0 };
  const chk = syntaxCheck(code, problem.lang);
  if (chk.ok) breakdown.compiles = 1;

  if (problem.testMarker.test(code)) breakdown.hasTest = 1;

  const kwHits = problem.keywords.filter(re => re.test(code)).length;
  breakdown.edgeCases = Math.min(2, kwHits >= problem.keywords.length ? 2 : kwHits >= Math.ceil(problem.keywords.length/2) ? 1 : 0);

  const badHits = problem.badPractices.filter(re => re.test(code)).length;
  breakdown.goodPractices = badHits === 0 ? 1 : 0;

  const score = breakdown.compiles + breakdown.hasTest + breakdown.edgeCases + breakdown.goodPractices;
  return { score, breakdown, codeLen: code.length, syntaxReason: chk.reason || null };
}

// ---- Cost ----
function computeCost(model, promptTokens, completionTokens) {
  return (promptTokens / 1000) * model.pricePer1kIn + (completionTokens / 1000) * model.pricePer1kOut;
}

// ---- Run one problem against one model (with retry) ----
async function runProblemForModel(problem, model, mock) {
  const p1 = await callModel(model, problem.prompt, mock);
  if (p1.skipped) return { skipped: true, reason: p1.reason, latencyMs: p1.latencyMs };

  const s1 = scoreResult(problem, p1.content);
  let retry = null;
  if (s1.score < 3) {
    const expanded = problem.prompt + `\n\nGOI Y: ${problem.hint}`;
    const p2 = await callModel(model, expanded, mock);
    if (!p2.skipped) {
      const s2 = scoreResult(problem, p2.content);
      retry = { ...s2, latencyMs: p2.latencyMs, promptTokens: p2.promptTokens, completionTokens: p2.completionTokens };
    }
  }

  return {
    first: { ...s1, latencyMs: p1.latencyMs, promptTokens: p1.promptTokens, completionTokens: p1.completionTokens },
    retry,
  };
}

// ---- Main ----
(async () => {
  const args = parseArgs(process.argv);
  const selectedModels = args.models
    ? ALL_MODELS.filter(m => args.models.includes(m.id))
    : ALL_MODELS;
  const ACTIVE_PROBLEMS = loadProblemSet(args.problemSet);
  const selectedProblems = args.problems
    ? ACTIVE_PROBLEMS.filter(p => args.problems.includes(p.id))
    : ACTIVE_PROBLEMS;

  console.log(`[bench] models=${selectedModels.map(m=>m.id).join(',')} problems=${selectedProblems.map(p=>p.id).join(',')} mock=${args.mock}`);

  const results = {
    startedAt: new Date().toISOString(),
    mock: args.mock,
    endpoint: LITELLM_URL,
    perModel: {},
  };

  for (const m of selectedModels) {
    results.perModel[m.id] = { tier: m.tier, score: 0, maxScore: selectedProblems.length * 5, costUSD: 0, latencyMs: 0, rework: 0, problems: {}, skipped: false };
  }

  for (const problem of selectedProblems) {
    console.log(`\n[problem ${problem.id}] ${problem.key}`);
    const runs = await Promise.all(selectedModels.map(m => runProblemForModel(problem, m, args.mock).then(r => ({ m, r }))));
    for (const { m, r } of runs) {
      const bucket = results.perModel[m.id];
      if (r.skipped) {
        bucket.problems[problem.id] = { skipped: true, reason: r.reason };
        bucket.latencyMs += r.latencyMs || 0;
        if (!bucket.skippedCount) bucket.skippedCount = 0;
        bucket.skippedCount++;
        console.log(`  ${m.id.padEnd(16)} SKIP (${r.reason})`);
        continue;
      }
      const first = r.first;
      const retry = r.retry;
      const finalScore = retry ? Math.max(first.score, retry.score) : first.score;
      const reworkImproved = retry && first.score < 3 && retry.score > first.score ? 1 : 0;
      bucket.score += finalScore;
      bucket.rework += reworkImproved;
      bucket.latencyMs += first.latencyMs + (retry?.latencyMs || 0);
      bucket.costUSD += computeCost(m, first.promptTokens, first.completionTokens);
      if (retry) bucket.costUSD += computeCost(m, retry.promptTokens, retry.completionTokens);
      bucket.problems[problem.id] = { first, retry, finalScore, reworkImproved };
      console.log(`  ${m.id.padEnd(16)} score=${finalScore}/5 ${retry ? `(retry ${first.score}->${retry.score})` : ''} ${first.latencyMs}ms`);
    }
  }

  results.finishedAt = new Date().toISOString();

  // Ensure out dir
  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n[bench] wrote ${outPath}`);

  // Markdown table
  const maxScore = selectedProblems.length * 5;
  const rows = Object.entries(results.perModel)
    .map(([id, b]) => ({ id, ...b }))
    .sort((a, b) => b.score - a.score);

  const lines = [];
  lines.push('| model | score | cost (USD) | latency (s) | rework |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const r of rows) {
    const s = r.skippedCount ? `${r.score}/${maxScore} (${r.skippedCount} skip)` : `${r.score}/${maxScore}`;
    lines.push(`| ${r.id} | ${s} | ${r.costUSD.toFixed(4)} | ${(r.latencyMs/1000).toFixed(2)} | ${r.rework} |`);
  }
  const table = lines.join('\n');
  console.log('\n' + table);

  // Markdown report
  const reportPath = path.resolve(path.dirname(outPath), 'bench-report.md');
  const reportLines = [
    `# Coding Quality Benchmark`,
    ``,
    `- Run: ${results.startedAt}`,
    `- Mock: ${results.mock}`,
    `- Problems: ${selectedProblems.map(p => `${p.id}.${p.key}`).join(', ')}`,
    ``,
    `## Ranked`,
    ``,
    table,
    ``,
    `## Per-problem breakdown`,
    ``,
  ];
  for (const p of selectedProblems) {
    reportLines.push(`### ${p.id}. ${p.key} (${p.lang})`);
    reportLines.push('');
    reportLines.push('| model | first | retry | final | latency ms |');
    reportLines.push('|---|---:|---:|---:|---:|');
    for (const m of selectedModels) {
      const pr = results.perModel[m.id].problems[p.id];
      if (!pr) { reportLines.push(`| ${m.id} | - | - | - | - |`); continue; }
      if (pr.skipped) { reportLines.push(`| ${m.id} | SKIP | - | - | - |`); continue; }
      reportLines.push(`| ${m.id} | ${pr.first.score} | ${pr.retry ? pr.retry.score : '-'} | ${pr.finalScore} | ${pr.first.latencyMs + (pr.retry?.latencyMs || 0)} |`);
    }
    reportLines.push('');
  }
  fs.writeFileSync(reportPath, reportLines.join('\n'));
  console.log(`[bench] wrote ${reportPath}`);
})().catch(e => {
  console.error('[bench] fatal:', e);
  process.exit(1);
});
