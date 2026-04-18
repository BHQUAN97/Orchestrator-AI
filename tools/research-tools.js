#!/usr/bin/env node
/**
 * Research Tools — 4 tools de giam rework do knowledge-cutoff drift
 *
 * 1. githubCodeSearch  → search code tren GitHub (React 19, Next 15 examples)
 * 2. githubIssueSearch → search issues/PRs (bug patterns, migration gotchas)
 * 3. npmInfo           → package metadata (latest version, deprecated, deps)
 * 4. deepResearch      → orchestrated: web_search + web_fetch + LLM synth
 *
 * Return shape chuan: { ok: true, data } hoac { ok: false, error, status? }
 *
 * Timeouts: 15s per HTTP call, 60s total cho deepResearch.
 */

const { webFetch, webSearch } = require('./web-tools');

const DEFAULT_TIMEOUT_MS = 15000;
const DEEP_RESEARCH_TIMEOUT_MS = 60000;
const UA = 'orcai/2.3 research-tools (+https://github.com/BHQUAN97/Orchestrator-AI)';

// ============================================================
// a) GitHub Code Search
// ============================================================
async function githubCodeSearch({ query, language, limit = 20 } = {}) {
  if (!query) return { ok: false, error: 'Missing query' };

  // Compose qualifier
  let q = query;
  if (language) q += ` language:${language}`;

  const url = `https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=${Math.min(limit, 100)}`;
  const headers = {
    'Accept': 'application/vnd.github.v3.text-match+json',
    'User-Agent': UA,
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const resp = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);

    const rateRemaining = resp.headers.get('x-ratelimit-remaining');

    if (resp.status === 403) {
      return { ok: false, status: 403, error: 'GitHub rate-limited. Set GITHUB_TOKEN env for 5000/hr quota.' };
    }
    if (resp.status === 422) {
      const body = await resp.text().catch(() => '');
      return { ok: false, status: 422, error: `GitHub rejected query (422): ${body.slice(0, 200)}` };
    }
    if (!resp.ok) {
      return { ok: false, status: resp.status, error: `HTTP ${resp.status} ${resp.statusText}` };
    }

    const json = await resp.json();
    const results = (json.items || []).slice(0, limit).map(it => ({
      repo: it.repository?.full_name || '',
      path: it.path,
      url: it.html_url,
      score: it.score,
      snippet: (it.text_matches || []).map(m => m.fragment).join('\n---\n').slice(0, 600)
    }));

    return {
      ok: true,
      data: {
        results,
        rateRemaining: rateRemaining ? Number(rateRemaining) : null,
        total: json.total_count || results.length
      }
    };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, error: `Timeout after ${DEFAULT_TIMEOUT_MS}ms` };
    return { ok: false, error: `Fetch failed: ${e.message}` };
  }
}

// ============================================================
// b) GitHub Issue Search
// ============================================================
async function githubIssueSearch({ query, state = 'all', limit = 20 } = {}) {
  if (!query) return { ok: false, error: 'Missing query' };

  let q = query;
  if (state && state !== 'all') q += ` state:${state}`;

  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=${Math.min(limit, 100)}`;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': UA,
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const resp = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);

    if (resp.status === 403) return { ok: false, status: 403, error: 'GitHub rate-limited. Set GITHUB_TOKEN.' };
    if (resp.status === 422) {
      const body = await resp.text().catch(() => '');
      return { ok: false, status: 422, error: `Bad query: ${body.slice(0, 200)}` };
    }
    if (!resp.ok) return { ok: false, status: resp.status, error: `HTTP ${resp.status} ${resp.statusText}` };

    const json = await resp.json();
    const results = (json.items || []).slice(0, limit).map(it => {
      // repo from html_url: https://github.com/OWNER/REPO/issues/N
      const m = (it.html_url || '').match(/github\.com\/([^/]+\/[^/]+)\//);
      return {
        repo: m ? m[1] : '',
        title: it.title,
        url: it.html_url,
        state: it.state,
        body_preview: String(it.body || '').slice(0, 400),
        comments: it.comments || 0,
        createdAt: it.created_at,
        closedAt: it.closed_at || null
      };
    });

    return { ok: true, data: { results, total: json.total_count || results.length } };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, error: `Timeout after ${DEFAULT_TIMEOUT_MS}ms` };
    return { ok: false, error: `Fetch failed: ${e.message}` };
  }
}

// ============================================================
// c) npm Info
// ============================================================
async function npmInfo({ pkg } = {}) {
  if (!pkg) return { ok: false, error: 'Missing pkg' };

  // Encode scoped packages correctly: @scope/name → @scope%2Fname
  const encoded = pkg.startsWith('@') ? pkg.replace('/', '%2F') : encodeURIComponent(pkg);
  const url = `https://registry.npmjs.org/${encoded}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: controller.signal
    });
    clearTimeout(timer);

    if (resp.status === 404) return { ok: false, status: 404, error: `Package not found: ${pkg}` };
    if (!resp.ok) return { ok: false, status: resp.status, error: `HTTP ${resp.status} ${resp.statusText}` };

    const json = await resp.json();
    const latest = json['dist-tags']?.latest || '';
    const latestMeta = json.versions?.[latest] || {};

    // Top 5 recent versions — theo thu tu time (desc)
    const time = json.time || {};
    const versions = Object.keys(time)
      .filter(v => v !== 'created' && v !== 'modified' && json.versions?.[v])
      .sort((a, b) => new Date(time[b]) - new Date(time[a]))
      .slice(0, 5)
      .map(v => ({ version: v, date: time[v] }));

    const repoField = latestMeta.repository || json.repository || {};
    const repoUrl = typeof repoField === 'string' ? repoField : (repoField.url || '');

    return {
      ok: true,
      data: {
        name: json.name,
        latest,
        description: latestMeta.description || json.description || '',
        deprecated: !!latestMeta.deprecated,
        deprecatedMessage: latestMeta.deprecated || null,
        versions,
        homepage: latestMeta.homepage || json.homepage || '',
        repo: repoUrl,
        license: latestMeta.license || json.license || '',
        deps: Object.keys(latestMeta.dependencies || {}).length
      }
    };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, error: `Timeout after ${DEFAULT_TIMEOUT_MS}ms` };
    return { ok: false, error: `Fetch failed: ${e.message}` };
  }
}

// ============================================================
// d) Deep Research (meta-tool)
// ============================================================

/**
 * Goi LiteLLM cheap model cho sub-query breakdown va synthesis.
 * @param {string} prompt
 * @param {object} opts  { dryRun: fn(prompt) => string, mock: string }
 */
async function callCheapLLM(prompt, opts = {}) {
  // Test hook — inject canned response
  if (opts.dryRun) return { ok: true, text: opts.dryRun(prompt), cost: 0 };
  if (process.env.DEEP_RESEARCH_MOCK) {
    return { ok: true, text: process.env.DEEP_RESEARCH_MOCK, cost: 0 };
  }

  const base = process.env.LITELLM_URL || 'http://localhost:4001';
  const key = process.env.LITELLM_KEY || process.env.LITELLM_MASTER_KEY || '';
  const model = process.env.LITELLM_CHEAP_MODEL || 'cheap';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'Authorization': `Bearer ${key}` } : {})
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 800
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, error: `LLM HTTP ${resp.status}: ${body.slice(0, 200)}` };
    }
    const j = await resp.json();
    const text = j.choices?.[0]?.message?.content || '';
    // Cost uoc luong tu usage neu co
    const usage = j.usage || {};
    const cost = Number(j._hidden_params?.response_cost || 0) ||
                 (usage.prompt_tokens || 0) * 1e-7 +
                 (usage.completion_tokens || 0) * 4e-7;
    return { ok: true, text, cost };
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') return { ok: false, error: 'LLM timeout' };
    return { ok: false, error: `LLM failed: ${e.message}` };
  }
}

/**
 * Parse JSON tu LLM output (tolerant — strip markdown fences).
 */
function parseLLMJson(text) {
  if (!text) return null;
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(stripped); } catch { /* fall through */ }
  // Try to find first JSON object/array
  const m = stripped.match(/[\[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  return null;
}

async function deepResearch({ question, maxSteps = 5, budget = 0.05, _hooks = {} } = {}) {
  if (!question) return { ok: false, error: 'Missing question' };

  const start = Date.now();
  const deadline = start + DEEP_RESEARCH_TIMEOUT_MS;
  let totalCost = 0;
  const steps = [];
  const citations = [];
  let partial = false;
  let warning = null;

  // --- 1. Break question into sub-queries ---
  const breakdownPrompt =
`Ban la research assistant. Tach cau hoi sau thanh 2-4 sub-queries cu the de search web.
Cau hoi: "${question}"
Tra ve JSON array cac string queries, khong giai thich. Vi du: ["query 1","query 2"]`;

  const breakdown = await callCheapLLM(breakdownPrompt, {
    dryRun: _hooks.cheapLLM
  });
  totalCost += breakdown.cost || 0;

  if (!breakdown.ok) {
    return { ok: false, error: `Breakdown failed: ${breakdown.error}`, data: { question, cost: totalCost } };
  }

  let subQueries = parseLLMJson(breakdown.text);
  if (!Array.isArray(subQueries) || subQueries.length === 0) {
    // Fallback — chi dung cau hoi goc
    subQueries = [question];
  }
  subQueries = subQueries.slice(0, Math.max(1, Math.min(maxSteps - 1, 4)));
  steps.push({ type: 'breakdown', subQueries });

  // --- 2. For each sub-query: web_search → top 3 → web_fetch ---
  const search = _hooks.webSearch || webSearch;
  const fetcher = _hooks.webFetch || webFetch;

  const fetched = [];
  for (const sq of subQueries) {
    if (Date.now() > deadline) { partial = true; warning = 'timeout'; break; }
    if (totalCost >= budget) { partial = true; warning = 'budget exceeded'; break; }

    const searchRes = await search({ query: sq, max_results: 3 });
    steps.push({ type: 'search', query: sq, count: searchRes?.results?.length || 0 });
    if (!searchRes?.success || !searchRes.results?.length) continue;

    for (const r of searchRes.results.slice(0, 3)) {
      if (Date.now() > deadline) { partial = true; warning = 'timeout'; break; }
      const fetchRes = await fetcher({ url: r.url, max_length: 8000 });
      if (fetchRes?.success) {
        fetched.push({
          url: r.url,
          title: r.title || '',
          content: (fetchRes.content || '').slice(0, 6000)
        });
      }
      steps.push({ type: 'fetch', url: r.url, ok: !!fetchRes?.success });
    }
    if (partial) break;
  }

  // --- 3. Synthesize ---
  let answer = '';
  if (fetched.length === 0) {
    answer = '(Khong tim duoc nguon nao de tong hop)';
  } else if (totalCost < budget && Date.now() < deadline) {
    const sources = fetched.map((f, i) =>
      `[${i + 1}] ${f.title}\nURL: ${f.url}\n${f.content}`
    ).join('\n\n---\n\n');

    const synthPrompt =
`Cau hoi: ${question}

Cac nguon:
${sources}

Hay tra loi cau hoi dua tren nguon. Output JSON:
{"answer":"...","citations":[{"url":"...","title":"...","quote":"trich 1 doan ngan tu nguon"}]}
Chi trich citation neu thuc su dung thong tin do. Khong bia.`;

    const synth = await callCheapLLM(synthPrompt, { dryRun: _hooks.cheapLLM });
    totalCost += synth.cost || 0;
    steps.push({ type: 'synth', ok: synth.ok });

    if (synth.ok) {
      const parsed = parseLLMJson(synth.text);
      if (parsed && typeof parsed === 'object') {
        answer = parsed.answer || synth.text;
        if (Array.isArray(parsed.citations)) {
          for (const c of parsed.citations) {
            if (c && c.url) citations.push({ url: c.url, title: c.title || '', quote: (c.quote || '').slice(0, 300) });
          }
        }
      } else {
        answer = synth.text;
      }
    } else {
      answer = `(Synthesis failed: ${synth.error})`;
      partial = true;
      warning = warning || synth.error;
    }
  } else {
    partial = true;
    answer = '(Dung som do budget/timeout — khong du ngan sach de tong hop)';
  }

  // Fallback citations — neu LLM khong tra ra, lay tu fetched
  if (citations.length === 0 && fetched.length > 0) {
    for (const f of fetched.slice(0, 3)) {
      citations.push({ url: f.url, title: f.title, quote: f.content.slice(0, 200) });
    }
  }

  return {
    ok: true,
    data: {
      question,
      answer,
      citations,
      steps,
      cost: Number(totalCost.toFixed(6)),
      partial,
      ...(warning ? { warning } : {}),
      elapsedMs: Date.now() - start
    }
  };
}

// ============================================================
// Schemas + Handlers
// ============================================================
const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'github_code_search',
      description: 'Tim kiem code tren GitHub (vi du tim usage React 19 hooks, Next.js 15 patterns). Can GITHUB_TOKEN de co rate limit tot.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Chuoi query. Ho tro qualifier GitHub (repo:, path:, extension:...)' },
          language: { type: 'string', description: 'Loc theo ngon ngu (javascript, typescript, python...). Tuy chon.' },
          limit: { type: 'integer', description: 'So ket qua toi da. Mac dinh 20.', default: 20 }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_issue_search',
      description: 'Tim issue/PR tren GitHub (vi du: loi migration, bug report). Tot de biet bug da biet truoc khi code.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Chuoi query. Ho tro qualifier (repo:, is:issue, is:pr, label:...).' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'all', description: 'Trang thai issue.' },
          limit: { type: 'integer', default: 20, description: 'So ket qua toi da.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'npm_info',
      description: 'Lay metadata npm package: latest version, deprecated status, 5 version gan nhat, homepage, repo, license, so dependencies.',
      parameters: {
        type: 'object',
        properties: {
          pkg: { type: 'string', description: 'Ten package (vi du: react, @types/node).' }
        },
        required: ['pkg']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'deep_research',
      description: 'Nghien cuu sau mot cau hoi: tach thanh sub-queries, search + fetch cac nguon, tong hop tra loi co citations. Co budget cap.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Cau hoi can nghien cuu.' },
          maxSteps: { type: 'integer', default: 5, description: 'So buoc toi da (sub-queries + fetch).' },
          budget: { type: 'number', default: 0.05, description: 'Chi phi USD toi da.' }
        },
        required: ['question']
      }
    }
  }
];

const TOOL_HANDLERS = {
  github_code_search: githubCodeSearch,
  github_issue_search: githubIssueSearch,
  npm_info: npmInfo,
  deep_research: deepResearch
};

module.exports = {
  githubCodeSearch,
  githubIssueSearch,
  npmInfo,
  deepResearch,
  TOOL_SCHEMAS,
  TOOL_HANDLERS,
  // exposed for tests
  _internals: { parseLLMJson, callCheapLLM }
};
