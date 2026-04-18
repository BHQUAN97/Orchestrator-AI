#!/usr/bin/env node
/**
 * Test RagPromptBuilder — isolate mocks, no network
 */
const { RagPromptBuilder } = require('../lib/rag-prompt-builder');

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { console.log(`  OK  ${name}`); passed++; }
  else { console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`); failed++; }
}

console.log('=== rag-prompt-builder tests ===\n');

// Silence console.warn (builder emit warnings in fallback paths)
const origWarn = console.warn;
console.warn = () => {};

// Helpers
function makeStubEmbeddings(results, shouldThrow = false) {
  return {
    async search({ query, topK }) {
      if (shouldThrow) throw new Error('stub embeddings down');
      return results.slice(0, topK);
    }
  };
}

function makeStubCtxMgr(profile) {
  return {
    getStackProfile() { return profile; }
  };
}

const STACK_MD = '# User Stack Profile\n- Node/Express\n- npm\n';

// === 1. isLocalModel classification ===
console.log('Test 1: isLocalModel classification');
const b1 = new RagPromptBuilder({ projectDir: __dirname });
assert('"local-heavy" → local', b1.isLocalModel('local-heavy') === true);
assert('"qwen2.5-coder-7b-instruct" → local', b1.isLocalModel('qwen2.5-coder-7b-instruct') === true);
assert('"qwen2.5-coder-3b" → local', b1.isLocalModel('qwen2.5-coder-3b') === true);
assert('"smart" → cloud', b1.isLocalModel('smart') === false);
assert('"gpt-4.1" → cloud', b1.isLocalModel('gpt-4.1') === false);
assert('empty/null → false', b1.isLocalModel('') === false && b1.isLocalModel(null) === false);

// === 2. build() — full RAG path with 2 high-sim results ===
console.log('\nTest 2: build() full RAG path');
(async () => {
  const embeddings = makeStubEmbeddings([
    { id: 'a', score: 0.82, text: 'function rateLimit(req, res, next) { /* sliding window */ }', metadata: {} },
    { id: 'b', score: 0.71, text: 'const limiter = new SlidingWindow({ max: 100 });', metadata: {} }
  ]);
  const ctxMgr = makeStubCtxMgr(STACK_MD);
  const builder = new RagPromptBuilder({
    projectDir: __dirname,
    embeddings,
    contextManager: ctxMgr,
    maxExamples: 3
  });
  const out = await builder.build({
    basePrompt: 'You are a coding agent.',
    userMessage: 'Viet middleware Express rate-limit sliding window',
    modelId: 'local-heavy'
  });
  assert('output contains STACK PROFILE', out.includes('USER STACK PROFILE'));
  assert('output contains RELEVANT EXAMPLES', out.includes('RELEVANT EXAMPLES FROM CODEBASE'));
  assert('output contains Example 1', out.includes('Example 1'));
  assert('output contains Example 2', out.includes('Example 2'));
  assert('output contains INSTRUCTIONS', out.includes('## INSTRUCTIONS'));
  assert('output preserves basePrompt', out.startsWith('You are a coding agent.'));
  const m = builder.getMetrics();
  assert('metric rag_applied incremented', m.rag_applied === 1, JSON.stringify(m));

  // === 3. build() with cloud model → basePrompt byte-exact ===
  console.log('\nTest 3: build() cloud model bypass (byte-exact)');
  const basePrompt = 'ORIGINAL PROMPT BYTES ABC 123';
  const out2 = await builder.build({
    basePrompt,
    userMessage: 'anything',
    modelId: 'smart'
  });
  assert('cloud path returns base byte-exact', out2 === basePrompt, `got: ${JSON.stringify(out2)}`);
  const m2 = builder.getMetrics();
  assert('metric rag_skipped_cloud incremented', m2.rag_skipped_cloud === 1, JSON.stringify(m2));

  // === 4. Embeddings failure → profile-only ===
  console.log('\nTest 4: embeddings fail → profile-only fallback');
  const failingEmb = makeStubEmbeddings([], true);
  const builder2 = new RagPromptBuilder({
    projectDir: __dirname,
    embeddings: failingEmb,
    contextManager: makeStubCtxMgr(STACK_MD)
  });
  const out3 = await builder2.build({
    basePrompt: 'base',
    userMessage: 'q',
    modelId: 'local-heavy'
  });
  assert('profile-only includes STACK PROFILE', out3.includes('USER STACK PROFILE'));
  assert('profile-only excludes EXAMPLES section', !out3.includes('RELEVANT EXAMPLES'));
  const m3 = builder2.getMetrics();
  assert('metric rag_fallback_profile_only incremented',
    m3.rag_fallback_profile_only === 1, JSON.stringify(m3));

  // === 5. Both fail → basePrompt + warning metric ===
  console.log('\nTest 5: both fail → basePrompt + warning metric');
  const builder3 = new RagPromptBuilder({
    projectDir: __dirname,
    embeddings: makeStubEmbeddings([], true),
    contextManager: makeStubCtxMgr(null) // no profile
  });
  const out4 = await builder3.build({
    basePrompt: 'UNCHANGED_BASE',
    userMessage: 'q',
    modelId: 'qwen2.5-coder-7b-instruct'
  });
  assert('both-fail returns basePrompt unchanged', out4 === 'UNCHANGED_BASE');
  const m4 = builder3.getMetrics();
  assert('metric rag_fallback_none incremented',
    m4.rag_fallback_none === 1, JSON.stringify(m4));

  // === 6. Low similarity examples filtered out ===
  console.log('\nTest 6: low similarity filtered');
  const lowEmb = makeStubEmbeddings([
    { id: 'x', score: 0.2, text: 'irrelevant' },
    { id: 'y', score: 0.3, text: 'also irrelevant' }
  ]);
  const builder4 = new RagPromptBuilder({
    projectDir: __dirname,
    embeddings: lowEmb,
    contextManager: makeStubCtxMgr(STACK_MD)
  });
  const out5 = await builder4.build({
    basePrompt: 'b',
    userMessage: 'q',
    modelId: 'local-heavy'
  });
  assert('low-sim filtered → profile-only', out5.includes('USER STACK PROFILE') && !out5.includes('RELEVANT EXAMPLES'));

  console.warn = origWarn;
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => {
  console.warn = origWarn;
  console.error('Test crashed:', e);
  process.exit(1);
});
