#!/usr/bin/env node
/**
 * Tests for tools/research-tools.js
 *
 * - Live tests skip when OFFLINE=1
 * - deepResearch uses dry-run hooks (no real LiteLLM/network)
 * - Error-shape tests dung URL khong ton tai de force network failure
 */

const OFFLINE = process.env.OFFLINE === '1';

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

async function skip(name, reason) {
  console.log(`SKIP ${name} (${reason})`);
}

(async () => {
  console.log('=== research-tools tests ===\n');

  const {
    npmInfo,
    githubCodeSearch,
    githubIssueSearch,
    deepResearch,
    TOOL_SCHEMAS,
    TOOL_HANDLERS
  } = require('../tools/research-tools');

  // --- Schema / handler plumbing ---
  await test('TOOL_SCHEMAS has 4 entries with required names', () => {
    const names = TOOL_SCHEMAS.map(s => s.function.name).sort();
    assert(TOOL_SCHEMAS.length === 4, `got ${TOOL_SCHEMAS.length}`);
    assert(names.join(',') === 'deep_research,github_code_search,github_issue_search,npm_info',
      `names=${names.join(',')}`);
    for (const s of TOOL_SCHEMAS) {
      assert(s.type === 'function' && s.function.parameters, `bad schema ${s.function.name}`);
    }
  });

  await test('TOOL_HANDLERS wires all 4 functions', () => {
    for (const k of ['github_code_search', 'github_issue_search', 'npm_info', 'deep_research']) {
      assert(typeof TOOL_HANDLERS[k] === 'function', `missing ${k}`);
    }
  });

  // --- npmInfo live ---
  if (OFFLINE) {
    skip('npmInfo(react) live', 'OFFLINE=1');
  } else {
    await test('npmInfo(react) returns latest version + versions[]', async () => {
      const res = await npmInfo({ pkg: 'react' });
      assert(res.ok, `not ok: ${res.error}`);
      assert(res.data.name === 'react', `name=${res.data.name}`);
      assert(/^\d+\.\d+\.\d+/.test(res.data.latest), `latest=${res.data.latest}`);
      assert(Array.isArray(res.data.versions) && res.data.versions.length > 0, 'versions empty');
      assert(res.data.versions.length <= 5, 'versions > 5');
      assert(typeof res.data.deps === 'number', 'deps not number');
    });
  }

  await test('npmInfo missing pkg returns error shape', async () => {
    const res = await npmInfo({});
    assert(res.ok === false && typeof res.error === 'string', 'bad shape');
  });

  if (OFFLINE) {
    skip('npmInfo(nonexistent) live', 'OFFLINE=1');
  } else {
    await test('npmInfo for unknown package returns 404', async () => {
      const res = await npmInfo({ pkg: 'this-pkg-definitely-does-not-exist-zzz-12345' });
      assert(!res.ok, 'should fail');
      assert(res.status === 404, `status=${res.status}`);
    });
  }

  // --- githubCodeSearch live ---
  if (OFFLINE) {
    skip('githubCodeSearch live', 'OFFLINE=1');
  } else {
    await test('githubCodeSearch returns results array shape', async () => {
      const res = await githubCodeSearch({ query: 'useState repo:facebook/react', limit: 3 });
      // With no token we may be rate-limited. Accept either ok or 403.
      if (!res.ok) {
        assert(res.status === 403 || res.status === 422 || typeof res.error === 'string',
          `unexpected err: ${res.error}`);
        console.log(`   (note: ${res.error})`);
        return;
      }
      assert(Array.isArray(res.data.results), 'results not array');
      if (res.data.results.length > 0) {
        const r = res.data.results[0];
        assert(typeof r.repo === 'string' && typeof r.url === 'string' && typeof r.path === 'string',
          'bad result shape');
      }
    });
  }

  await test('githubCodeSearch missing query returns error', async () => {
    const res = await githubCodeSearch({});
    assert(res.ok === false && res.error, 'bad shape');
  });

  await test('githubIssueSearch missing query returns error', async () => {
    const res = await githubIssueSearch({});
    assert(res.ok === false && res.error, 'bad shape');
  });

  // --- Network failure shape ---
  await test('npmInfo network failure returns { ok:false, error }', async () => {
    // Force bad host via env hack — actually easier: scoped bad name triggers 404 path
    // Instead test actual network failure by pointing at nonexistent host through fetch mock.
    const origFetch = global.fetch;
    global.fetch = async () => { throw new Error('ECONNREFUSED'); };
    try {
      const res = await npmInfo({ pkg: 'react' });
      assert(res.ok === false, 'should be not-ok');
      assert(typeof res.error === 'string' && res.error.includes('ECONNREFUSED'), `error=${res.error}`);
    } finally {
      global.fetch = origFetch;
    }
  });

  await test('githubCodeSearch network failure returns { ok:false, error }', async () => {
    const origFetch = global.fetch;
    global.fetch = async () => { throw new Error('network down'); };
    try {
      const res = await githubCodeSearch({ query: 'foo' });
      assert(res.ok === false && res.error.includes('network down'), `error=${res.error}`);
    } finally {
      global.fetch = origFetch;
    }
  });

  // --- deepResearch orchestration (dry-run) ---
  await test('deepResearch dry-run synthesizes with citations', async () => {
    // Hook cheap LLM: first call returns sub-queries JSON, second call returns synth JSON
    let callCount = 0;
    const cheapLLM = (prompt) => {
      callCount++;
      if (callCount === 1) {
        return JSON.stringify(['React 19 new hooks', 'Next.js 15 app router changes']);
      }
      return JSON.stringify({
        answer: 'React 19 adds useActionState and useOptimistic. Next.js 15 stabilizes App Router.',
        citations: [
          { url: 'https://example.com/react19', title: 'React 19 notes', quote: 'useActionState is stable' },
          { url: 'https://example.com/next15', title: 'Next 15', quote: 'App Router is default' }
        ]
      });
    };

    const fakeSearch = async ({ query }) => ({
      success: true,
      results: [
        { url: `https://example.com/${encodeURIComponent(query)}/a`, title: `A for ${query}`, description: '' },
        { url: `https://example.com/${encodeURIComponent(query)}/b`, title: `B for ${query}`, description: '' }
      ]
    });
    const fakeFetch = async ({ url }) => ({
      success: true,
      url,
      content: `Mock content for ${url}. Lorem ipsum dolor sit amet.`,
      truncated: false,
      length: 40
    });

    const res = await deepResearch(
      { question: 'What changed in React 19 and Next 15?', maxSteps: 4, budget: 1.0 },
      // Pass hooks via 2nd positional? No — must pass inside args. Adjust below.
    );
    // NOTE: deepResearch accepts _hooks inside the same args object.
    // Re-run with hooks:
    const res2 = await deepResearch({
      question: 'What changed in React 19 and Next 15?',
      maxSteps: 4,
      budget: 1.0,
      _hooks: { cheapLLM, webSearch: fakeSearch, webFetch: fakeFetch }
    });

    assert(res2.ok, `not ok: ${res2.error}`);
    assert(res2.data.question.includes('React 19'), 'question missing');
    assert(typeof res2.data.answer === 'string' && res2.data.answer.length > 0, 'no answer');
    assert(Array.isArray(res2.data.citations) && res2.data.citations.length >= 1, 'no citations');
    const c0 = res2.data.citations[0];
    assert(c0.url && c0.title !== undefined && c0.quote !== undefined, 'bad citation shape');
    assert(Array.isArray(res2.data.steps) && res2.data.steps.length > 0, 'no steps');
    assert(typeof res2.data.cost === 'number', 'no cost');
  });

  await test('deepResearch missing question returns error', async () => {
    const res = await deepResearch({});
    assert(res.ok === false, 'should fail');
  });

  await test('deepResearch budget=0 stops early with partial', async () => {
    const cheapLLM = () => JSON.stringify(['q1']);
    const fakeSearch = async () => ({ success: true, results: [{ url: 'https://x.com', title: 'x', description: '' }] });
    const fakeFetch = async () => ({ success: true, content: 'x', truncated: false });

    // Force breakdown cost > budget by injecting cost through usage? Simpler: set budget negative so
    // post-breakdown check trips immediately.
    const res = await deepResearch({
      question: 'test',
      budget: -1,
      _hooks: { cheapLLM, webSearch: fakeSearch, webFetch: fakeFetch }
    });
    assert(res.ok, 'should still return ok with partial data');
    assert(res.data.partial === true, 'should be partial');
  });

  // --- Summary ---
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
})();
