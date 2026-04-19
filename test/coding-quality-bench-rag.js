#!/usr/bin/env node
// RAG-aware coding quality bench.
// Usage:
//   node test/coding-quality-bench-rag.js                     # RAG on (default)
//   node test/coding-quality-bench-rag.js --no-rag            # RAG off (baseline)
//   node test/coding-quality-bench-rag.js --compare           # run BOTH in same process
//   node test/coding-quality-bench-rag.js --problem-set realistic
//   node test/coding-quality-bench-rag.js --mock
//
// Outputs:
//   .orcai/bench-rag-results.json        (RAG on)
//   .orcai/bench-non-rag-results.json    (when --no-rag or --compare)
//   .orcai/bench-rag-delta.md            (khi ca 2 file cung ton tai)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { RagPromptBuilder } = require('../lib/rag-prompt-builder');

// ---- Config ----
const LITELLM_URL = process.env.LITELLM_URL || 'http://localhost:4001';
const LITELLM_KEY = process.env.LITELLM_KEY || process.env.LITELLM_API_KEY || '';
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS || 60_000);
const BASE_SYSTEM_PROMPT_PLAIN = 'You are a senior engineer. Return only the code requested, no prose unless the prompt asks for it.';
// CoT variant: explicit reasoning hint before code. Helps weak models surface edge cases.
const BASE_SYSTEM_PROMPT_COT = 'You are a senior engineer. Before writing code, silently think through: (1) the happy path signature, (2) 2-3 edge cases, (3) error handling needed. Then return ONLY the final runnable code — no prose, no markdown fences, no explanations.';
const BASE_SYSTEM_PROMPT = process.env.BENCH_COT === '1' ? BASE_SYSTEM_PROMPT_COT : BASE_SYSTEM_PROMPT_PLAIN;

const ALL_MODELS = [
  { id: 'local-workhorse', tier: 'local',   pricePer1kIn: 0,       pricePer1kOut: 0 },
  { id: 'local-heavy',     tier: 'local',   pricePer1kIn: 0,       pricePer1kOut: 0 },
  { id: 'qwen2.5-coder-7b-instruct', tier: 'local', pricePer1kIn: 0, pricePer1kOut: 0 },
  { id: 'qwen2.5-coder-3b-instruct', tier: 'local', pricePer1kIn: 0, pricePer1kOut: 0 },
  { id: 'cheap',           tier: 'cheap',   pricePer1kIn: 0.00015, pricePer1kOut: 0.0006 },
  { id: 'fast',            tier: 'fast',    pricePer1kIn: 0.00030, pricePer1kOut: 0.0025 },
  { id: 'smart',           tier: 'smart',   pricePer1kIn: 0.003,   pricePer1kOut: 0.015 },
  { id: 'architect',       tier: 'architect', pricePer1kIn: 0.015, pricePer1kOut: 0.075 },
  // OpenRouter routed cloud models — for head-to-head bench vs local RAG tiers
  { id: 'deepseek',        tier: 'cloud',   pricePer1kIn: 0.00027, pricePer1kOut: 0.00042 },
  { id: 'gpt-mini',        tier: 'cloud',   pricePer1kIn: 0.00015, pricePer1kOut: 0.00060 },
];

// ---- Default (generic) problem set — clone tu coding-quality-bench.js ----
const GENERIC_PROBLEMS = [
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
  const args = {
    models: null,
    problems: null,
    out: null,                 // resolved later per-mode
    mock: false,
    problemSet: 'generic',
    rag: true,
    compare: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') args.mock = true;
    else if (a === '--models') args.models = argv[++i].split(',').map(s => s.trim());
    else if (a === '--problems') args.problems = expandRange(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--problem-set') args.problemSet = argv[++i];
    else if (a === '--no-rag') args.rag = false;
    else if (a === '--rag') args.rag = true;
    else if (a === '--compare') args.compare = true;
  }
  return args;
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

function loadProblemSet(name) {
  if (!name || name === 'generic') return GENERIC_PROBLEMS;
  const candidates = [
    path.join(__dirname, 'problems', `${name}.js`),
    path.join(__dirname, `problems-${name}.js`),
  ];
  const found = candidates.find(p => fs.existsSync(p));
  if (found) {
    try {
      const mod = require(found);
      const upper = `PROBLEMS_${name.toUpperCase()}`;
      const arr = Array.isArray(mod) ? mod : (mod.PROBLEMS || mod.problems || mod[upper] || mod.default);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (e) {
      console.warn(`[bench-rag] could not load problem-set '${name}': ${e.message} — falling back to generic`);
    }
  } else {
    console.warn(`[bench-rag] problem-set '${name}' not found — falling back to generic`);
  }
  return GENERIC_PROBLEMS;
}

// ---- RAG builder factory ----
// Stub embeddings + contextManager neu chua wire. Giu bench van chay duoc ngay ca khi
// embedding store trong — builder se fallback profile-only / basePrompt theo metrics.
function makeRagBuilder(projectDir, mock) {
  let embeddings = null;
  let contextManager = null;

  if (!mock) {
    try {
      const { EmbeddingStore } = require('../lib/embeddings');
      const store = new EmbeddingStore({ projectDir });
      embeddings = {
        search: async ({ query, topK }) => {
          const hits = await store.query({ text: query, top_k: topK });
          return hits.map(h => ({ id: h.id, score: h.score, text: h.text, metadata: h.metadata }));
        }
      };
    } catch { /* optional */ }
    try {
      const stackProfilePath = path.join(projectDir, '.orcai', 'stack-profile.md');
      if (fs.existsSync(stackProfilePath)) {
        const md = fs.readFileSync(stackProfilePath, 'utf8');
        contextManager = { getStackProfile: () => md };
      }
    } catch { /* optional */ }
  } else {
    // Mock mode: deterministic stub — always returns 1 high-sim example + canned profile
    embeddings = {
      search: async ({ query }) => ([
        { id: 'mock-1', score: 0.82, text: `// relevant pattern for: ${String(query).slice(0, 40)}`, metadata: {} }
      ])
    };
    contextManager = { getStackProfile: () => '# Mock Stack\n- Node 20\n- TypeScript 5\n' };
  }

  return new RagPromptBuilder({
    projectDir,
    embeddings,
    contextManager,
    maxExamples: Number(process.env.BENCH_RAG_MAX_EXAMPLES || 3),
    minSimilarity: Number(process.env.BENCH_RAG_MIN_SIMILARITY || 0.55),
    // BENCH_NO_HINTS=1 → disable decision-hints injection (A/B test graph hints)
    hintsPath: process.env.BENCH_NO_HINTS === '1' ? null : undefined,
  });
}

// ---- LLM call ----
async function callModel(model, prompt, systemPrompt, mock) {
  const started = Date.now();
  if (mock) return mockResponse(model, prompt, systemPrompt, started);

  const body = {
    model: model.id,
    messages: [
      { role: 'system', content: systemPrompt },
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
// RAG boost: khi systemPrompt chua "USER STACK PROFILE" va model la local, nang chat luong
// de delta demo ro — thuc te local model gen better khi co profile + examples.
function mockResponse(model, prompt, systemPrompt, started) {
  const ragApplied = /USER STACK PROFILE|RELEVANT EXAMPLES/i.test(systemPrompt || '');
  const q = prompt.toLowerCase();
  let canned =
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

  // Local model DEGRADED when no RAG — simulates real-world drift on local coder.
  // Voi RAG: gen day du. Khong RAG: drop testing harness / them console.log.
  if (model.tier === 'local') {
    if (!ragApplied) {
      canned = canned
        .replace(/describe[\s\S]*?;\}\);/, '')
        .replace(/jest\.useFakeTimers\(\);/, '')
        .replace(/module\.exports\s*=\s*\{?\s*debounce[^;]*;?/, '')
        .replace(/\/\/ test[\s\S]*$/, '');
      // Them bad practice mo phong drift
      if (q.includes('refactor')) canned = canned.replace('const filterActive', 'let total = 0;\nconst filterActive');
      if (q.includes('rate-limit')) canned = canned.replace('next();', 'console.log("hit");next();');
    }
  } else if (!ragApplied) {
    // Cloud models: RAG bypassed anyway, nen khong degrade → giong RAG ON.
  }

  const promptTokens = Math.ceil((systemPrompt.length + prompt.length) / 4);
  const completionTokens = Math.ceil(canned.length / 4);
  const latency = model.tier === 'local' ? 1200 + Math.random()*400
                 : model.tier === 'cheap' ? 800 + Math.random()*300
                 : model.tier === 'fast'  ? 600 + Math.random()*200
                 : model.tier === 'smart' ? 1800 + Math.random()*500
                 : 3000 + Math.random()*800;
  return { content: canned, promptTokens, completionTokens, latencyMs: Math.round(Date.now() - started + latency) };
}

// ---- Extract + syntax check + scoring (same as parent bench) ----
function extractCode(content) {
  if (!content) return '';
  const blocks = [...content.matchAll(/```(?:\w+)?\s*\n([\s\S]*?)```/g)].map(m => m[1]);
  return blocks.length ? blocks.join('\n') : content;
}

function syntaxCheck(code, lang) {
  if (!code || !code.trim()) return { ok: false, reason: 'empty' };
  const tmp = path.join(os.tmpdir(), `bench-rag-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    if (lang === 'js') {
      fs.writeFileSync(tmp + '.js', code);
      const r = spawnSync(process.execPath, ['--check', tmp + '.js'], { encoding: 'utf8' });
      if (r.status === 0) return { ok: true };
      fs.writeFileSync(tmp + '.js', `(async()=>{${code}})();`);
      const r2 = spawnSync(process.execPath, ['--check', tmp + '.js'], { encoding: 'utf8' });
      return r2.status === 0 ? { ok: true } : { ok: false, reason: (r.stderr || '').slice(0, 160) };
    }
    if (lang === 'ts') return { ok: bracesBalanced(code), reason: 'ts-soft-check' };
    if (lang === 'py') {
      fs.writeFileSync(tmp + '.py', code);
      // Explicit full paths beat PATH-based lookup (Windows Store stubs shadow real Python)
      const HOME = process.env.USERPROFILE || process.env.HOME || '';
      const candidates = [
        path.join(HOME, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
        path.join(HOME, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
        'py', 'python', 'python3',
      ];
      for (const c of candidates) {
        const r = spawnSync(c, ['-m', 'py_compile', tmp + '.py'], { encoding: 'utf8' });
        if (r.status === 0) return { ok: true };
        // Detect Windows Store stub / missing Python → fall through to next candidate
        const msg = (r.stderr || '') + (r.stdout || '');
        if (r.status === null || r.status === 9009 || /python was not found|app execution alias|Microsoft Store/i.test(msg)) continue;
        if (r.status !== null) return { ok: false, reason: msg.slice(0, 160) };
      }
      return { ok: bracesBalanced(code, 'py'), reason: 'py-soft-check' };
    }
    if (lang === 'yaml') {
      try {
        const yaml = (() => { try { return require('js-yaml'); } catch { return null; } })();
        if (yaml) { yaml.load(code); return { ok: true }; }
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
  if (lang === 'py') return !/^\s+\t/m.test(s);
  let c = 0, p = 0, b = 0;
  for (const ch of s) { if (ch === '{') c++; else if (ch === '}') c--; else if (ch === '(') p++; else if (ch === ')') p--; else if (ch === '[') b++; else if (ch === ']') b--; }
  return c === 0 && p === 0 && b === 0;
}

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

function computeCost(model, promptTokens, completionTokens) {
  return (promptTokens / 1000) * model.pricePer1kIn + (completionTokens / 1000) * model.pricePer1kOut;
}

// ---- Run one problem/model ----
async function runProblemForModel(problem, model, ragBuilder, useRag, mock) {
  // Tao system prompt: neu useRag -> goi builder; neu khong -> dung base.
  let systemPrompt = BASE_SYSTEM_PROMPT;
  if (useRag && ragBuilder) {
    try {
      systemPrompt = await ragBuilder.build({
        basePrompt: BASE_SYSTEM_PROMPT,
        userMessage: problem.prompt,
        modelId: model.id
      });
    } catch (e) {
      systemPrompt = BASE_SYSTEM_PROMPT;
    }
  }

  const p1 = await callModel(model, problem.prompt, systemPrompt, mock);
  if (p1.skipped) return { skipped: true, reason: p1.reason, latencyMs: p1.latencyMs };

  const s1 = scoreResult(problem, p1.content);
  let retry = null;
  if (s1.score < 3) {
    const expanded = problem.prompt + `\n\nGOI Y: ${problem.hint}`;
    const p2 = await callModel(model, expanded, systemPrompt, mock);
    if (!p2.skipped) {
      const s2 = scoreResult(problem, p2.content);
      retry = { ...s2, latencyMs: p2.latencyMs, promptTokens: p2.promptTokens, completionTokens: p2.completionTokens };
    }
  }

  // BENCH_SAVE_CODE=1 → append raw model output to .orcai/distill-<model>.jsonl for FT data capture
  if (process.env.BENCH_SAVE_CODE === '1') {
    try {
      const line = JSON.stringify({
        model: model.id,
        problemId: problem.id,
        problemKey: problem.key,
        category: problem.category,
        difficulty: problem.difficulty,
        lang: problem.lang,
        prompt: problem.prompt,
        code: p1.content || '',
        score: s1.score,
        breakdown: s1.breakdown,
        ts: new Date().toISOString(),
      });
      fs.appendFileSync(path.join('.orcai', `distill-${model.id}.jsonl`), line + '\n');
    } catch {}
  }

  return {
    first: { ...s1, latencyMs: p1.latencyMs, promptTokens: p1.promptTokens, completionTokens: p1.completionTokens },
    retry,
  };
}

// ---- Main run (one mode: RAG on OR off) ----
async function runBench({ useRag, args, selectedModels, selectedProblems, ragBuilder }) {
  const results = {
    startedAt: new Date().toISOString(),
    mock: args.mock,
    endpoint: LITELLM_URL,
    rag: useRag,
    problemSet: args.problemSet,
    perModel: {},
  };

  for (const m of selectedModels) {
    results.perModel[m.id] = {
      tier: m.tier, score: 0, maxScore: selectedProblems.length * 5,
      costUSD: 0, latencyMs: 0, rework: 0, problems: {}, skipped: false
    };
  }

  for (const problem of selectedProblems) {
    console.log(`\n[problem ${problem.id}] ${problem.key} (rag=${useRag})`);
    const runs = await Promise.all(selectedModels.map(m =>
      runProblemForModel(problem, m, ragBuilder, useRag, args.mock).then(r => ({ m, r }))
    ));
    for (const { m, r } of runs) {
      const bucket = results.perModel[m.id];
      if (r.skipped) {
        bucket.problems[problem.id] = { skipped: true, reason: r.reason };
        bucket.latencyMs += r.latencyMs || 0;
        bucket.skippedCount = (bucket.skippedCount || 0) + 1;
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
  if (ragBuilder) results.ragMetrics = ragBuilder.getMetrics();
  return results;
}

// ---- Write main results + MD table ----
function writeResultsAndTable(results, outPath, selectedProblems, selectedModels, label) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n[bench-rag] wrote ${outPath}`);

  const maxScore = selectedProblems.length * 5;
  const rows = Object.entries(results.perModel)
    .map(([id, b]) => ({ id, ...b }))
    .sort((a, b) => b.score - a.score);

  const ragApplied = results.ragMetrics?.rag_applied || 0;
  const lines = [];
  lines.push(`### ${label} (rag=${results.rag})`);
  lines.push('');
  lines.push('| model | rag | score | cost (USD) | latency (s) | rework | rag_applied |');
  lines.push('|---|:---:|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    const s = r.skippedCount ? `${r.score}/${maxScore} (${r.skippedCount} skip)` : `${r.score}/${maxScore}`;
    lines.push(`| ${r.id} | ${results.rag ? 'yes' : 'no'} | ${s} | ${r.costUSD.toFixed(4)} | ${(r.latencyMs/1000).toFixed(2)} | ${r.rework} | ${results.rag ? ragApplied : 0} |`);
  }
  const table = lines.join('\n');
  console.log('\n' + table);
  return table;
}

// ---- Delta calc ----
// Public helper — reused by tests.
function computeDelta(ragResults, nonRagResults) {
  const perModel = {};
  const problemDeltas = []; // {model, problemId, key, delta, ragScore, nonRagScore}

  const modelIds = new Set([
    ...Object.keys(ragResults.perModel || {}),
    ...Object.keys(nonRagResults.perModel || {})
  ]);

  for (const id of modelIds) {
    const rag = ragResults.perModel[id];
    const nr = nonRagResults.perModel[id];
    if (!rag || !nr) continue;
    const ragTotal = rag.score || 0;
    const nrTotal = nr.score || 0;
    const pct = nrTotal === 0 ? (ragTotal > 0 ? 100 : 0) : ((ragTotal - nrTotal) / nrTotal) * 100;
    perModel[id] = {
      ragScore: ragTotal,
      nonRagScore: nrTotal,
      delta: ragTotal - nrTotal,
      pct: Math.round(pct * 10) / 10,
      tier: rag.tier || nr.tier
    };

    const pIds = new Set([
      ...Object.keys(rag.problems || {}),
      ...Object.keys(nr.problems || {})
    ]);
    for (const pid of pIds) {
      const rp = rag.problems[pid];
      const np = nr.problems[pid];
      const rs = rp && !rp.skipped ? rp.finalScore : 0;
      const ns = np && !np.skipped ? np.finalScore : 0;
      problemDeltas.push({
        model: id,
        problemId: Number(pid),
        delta: rs - ns,
        ragScore: rs,
        nonRagScore: ns
      });
    }
  }

  const improved = problemDeltas.filter(d => d.delta > 0)
    .sort((a, b) => b.delta - a.delta || b.ragScore - a.ragScore);
  const notHelped = problemDeltas.filter(d => d.delta <= 0 && d.ragScore < 5)
    .sort((a, b) => a.delta - b.delta || a.ragScore - b.ragScore);

  return {
    perModel,
    topImproved: improved.slice(0, 5),
    topNotHelped: notHelped.slice(0, 5),
    problemDeltas
  };
}

function writeDeltaReport(delta, outDir, selectedProblems) {
  const lines = [];
  lines.push('# RAG vs Non-RAG Delta Report');
  lines.push('');
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Per-model — total score');
  lines.push('');
  lines.push('| model | tier | rag score | non-rag score | delta | % improvement |');
  lines.push('|---|---|---:|---:|---:|---:|');
  const rows = Object.entries(delta.perModel)
    .sort((a, b) => b[1].delta - a[1].delta);
  for (const [id, d] of rows) {
    lines.push(`| ${id} | ${d.tier || '-'} | ${d.ragScore} | ${d.nonRagScore} | ${d.delta >= 0 ? '+' : ''}${d.delta} | ${d.pct >= 0 ? '+' : ''}${d.pct}% |`);
  }

  const keyOf = (pid) => {
    const p = selectedProblems.find(x => x.id === Number(pid));
    return p ? p.key : `p${pid}`;
  };

  lines.push('');
  lines.push('## Top 5 problems most improved by RAG');
  lines.push('');
  lines.push('| model | problem | non-rag | rag | delta |');
  lines.push('|---|---|---:|---:|---:|');
  for (const d of delta.topImproved) {
    lines.push(`| ${d.model} | ${d.problemId}.${keyOf(d.problemId)} | ${d.nonRagScore} | ${d.ragScore} | +${d.delta} |`);
  }

  lines.push('');
  lines.push('## Top 5 problems NOT helped by RAG (fine-tuning candidates)');
  lines.push('');
  lines.push('| model | problem | non-rag | rag | delta |');
  lines.push('|---|---|---:|---:|---:|');
  for (const d of delta.topNotHelped) {
    lines.push(`| ${d.model} | ${d.problemId}.${keyOf(d.problemId)} | ${d.nonRagScore} | ${d.ragScore} | ${d.delta} |`);
  }

  const outPath = path.join(outDir, 'bench-rag-delta.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`[bench-rag] wrote ${outPath}`);
  return outPath;
}

// ---- Entry ----
async function main() {
  const args = parseArgs(process.argv);
  const selectedModels = args.models
    ? ALL_MODELS.filter(m => args.models.includes(m.id))
    : ALL_MODELS;
  const problems = loadProblemSet(args.problemSet);
  const selectedProblems = args.problems
    ? problems.filter(p => args.problems.includes(p.id))
    : problems;

  const projectDir = process.cwd();
  const outDir = path.resolve('.orcai');
  const ragOut = args.out || path.join(outDir, 'bench-rag-results.json');
  const nonRagOut = args.out && !args.compare ? args.out : path.join(outDir, 'bench-non-rag-results.json');

  console.log(`[bench-rag] models=${selectedModels.map(m=>m.id).join(',')} problems=${selectedProblems.map(p=>p.id).join(',')} mock=${args.mock} rag=${args.rag} compare=${args.compare}`);

  const ragBuilder = makeRagBuilder(projectDir, args.mock);

  // Mode selection
  const modes = args.compare ? [true, false] : [args.rag];
  let ragResults = null;
  let nonRagResults = null;

  for (const useRag of modes) {
    ragBuilder.resetMetrics();
    const res = await runBench({ useRag, args, selectedModels, selectedProblems, ragBuilder });
    const target = useRag ? ragOut : nonRagOut;
    const label = useRag ? 'RAG on' : 'Non-RAG (baseline)';
    writeResultsAndTable(res, target, selectedProblems, selectedModels, label);
    if (useRag) ragResults = res; else nonRagResults = res;
  }

  // Delta: neu 2 file cung ton tai (co the tu run truoc), load va report
  const finalRagPath = ragOut;
  const finalNonRagPath = nonRagOut;
  if (!ragResults && fs.existsSync(finalRagPath)) {
    try { ragResults = JSON.parse(fs.readFileSync(finalRagPath, 'utf8')); } catch {}
  }
  if (!nonRagResults && fs.existsSync(finalNonRagPath)) {
    try { nonRagResults = JSON.parse(fs.readFileSync(finalNonRagPath, 'utf8')); } catch {}
  }

  if (ragResults && nonRagResults) {
    const delta = computeDelta(ragResults, nonRagResults);
    // Print delta table
    const deltaLines = ['', '## Delta (rag - non-rag)', '', '| model | rag | non-rag | delta | % |', '|---|---:|---:|---:|---:|'];
    for (const [id, d] of Object.entries(delta.perModel)) {
      deltaLines.push(`| ${id} | ${d.ragScore} | ${d.nonRagScore} | ${d.delta >= 0 ? '+' : ''}${d.delta} | ${d.pct >= 0 ? '+' : ''}${d.pct}% |`);
    }
    console.log('\n' + deltaLines.join('\n'));
    writeDeltaReport(delta, outDir, selectedProblems);
  } else {
    console.log('\n[bench-rag] delta report skipped — need BOTH rag + non-rag results in .orcai/ (run with --compare or separate --no-rag run)');
  }
}

// Exports cho test
module.exports = {
  parseArgs,
  loadProblemSet,
  makeRagBuilder,
  computeDelta,
  writeDeltaReport,
  scoreResult,
  extractCode,
  GENERIC_PROBLEMS,
  ALL_MODELS,
  BASE_SYSTEM_PROMPT,
};

if (require.main === module) {
  main().catch(e => {
    console.error('[bench-rag] fatal:', e);
    process.exit(1);
  });
}
