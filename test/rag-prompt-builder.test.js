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

  // === 7. Decision Hints — file present → injected into full RAG prompt ===
  console.log('\nTest 7: hints injected when file present (full RAG)');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-hints-'));
  const tmpHints = path.join(tmpDir, '_decision-hints.md');
  fs.writeFileSync(tmpHints, '---\ntitle: test\n---\n## RULE A\nFoo bar baz.\n## RULE B\nBcrypt cost >= 10.\n');
  const builder7 = new RagPromptBuilder({
    projectDir: __dirname,
    embeddings: makeStubEmbeddings([{ id: 'x', score: 0.9, text: 'code', metadata: {} }]),
    contextManager: makeStubCtxMgr(STACK_MD),
    hintsPath: tmpHints
  });
  const out7 = await builder7.build({
    basePrompt: 'You are a coding agent.',
    userMessage: 'some query',
    modelId: 'local-heavy'
  });
  assert('output contains DECISION HINTS section', out7.includes('## DECISION HINTS'));
  assert('hints body inlined', out7.includes('RULE A') && out7.includes('Bcrypt cost'));
  assert('frontmatter stripped', !out7.includes('title: test'));
  assert('metric rag_hints_injected incremented', builder7.getMetrics().rag_hints_injected === 1);
  assert('hints appears BEFORE stack profile', out7.indexOf('## DECISION HINTS') < out7.indexOf('## USER STACK PROFILE'));

  // === 8. Hints injected in profile-only path ===
  console.log('\nTest 8: hints injected in profile-only path');
  const builder8 = new RagPromptBuilder({
    projectDir: __dirname,
    embeddings: makeStubEmbeddings([], true), // throws
    contextManager: makeStubCtxMgr(STACK_MD),
    hintsPath: tmpHints
  });
  const out8 = await builder8.build({ basePrompt: 'x', userMessage: 'q', modelId: 'local-heavy' });
  assert('profile-only path has hints', out8.includes('## DECISION HINTS') && out8.includes('## USER STACK PROFILE') && !out8.includes('RELEVANT EXAMPLES'));

  // === 9. hintsPath=null disables injection ===
  console.log('\nTest 9: hintsPath=null disables hints');
  const builder9 = new RagPromptBuilder({
    projectDir: __dirname,
    embeddings: makeStubEmbeddings([{ id: 'x', score: 0.9, text: 'code', metadata: {} }]),
    contextManager: makeStubCtxMgr(STACK_MD),
    hintsPath: null
  });
  const out9 = await builder9.build({ basePrompt: 'x', userMessage: 'q', modelId: 'local-heavy' });
  assert('no DECISION HINTS when disabled', !out9.includes('## DECISION HINTS'));
  assert('metric rag_hints_injected stays 0', builder9.getMetrics().rag_hints_injected === 0);

  // === 10. Missing hints file degrades silently ===
  console.log('\nTest 10: missing hints file → silent no-op');
  const builder10 = new RagPromptBuilder({
    projectDir: __dirname,
    embeddings: makeStubEmbeddings([{ id: 'x', score: 0.9, text: 'code', metadata: {} }]),
    contextManager: makeStubCtxMgr(STACK_MD),
    hintsPath: path.join(tmpDir, 'no-such-file.md')
  });
  const out10 = await builder10.build({ basePrompt: 'x', userMessage: 'q', modelId: 'local-heavy' });
  assert('no DECISION HINTS when file missing', !out10.includes('## DECISION HINTS'));
  assert('rest of prompt still composed', out10.includes('## USER STACK PROFILE') && out10.includes('RELEVANT EXAMPLES'));

  // === 11. Cloud model still bypasses hints ===
  console.log('\nTest 11: cloud model bypass unaffected by hints');
  const builder11 = new RagPromptBuilder({
    projectDir: __dirname,
    hintsPath: tmpHints,
    embeddings: makeStubEmbeddings([{ id: 'x', score: 0.9, text: 'code' }]),
    contextManager: makeStubCtxMgr(STACK_MD)
  });
  const base11 = 'CLOUD BASE';
  const out11 = await builder11.build({ basePrompt: base11, userMessage: 'q', modelId: 'smart' });
  assert('cloud byte-exact even with hints configured', out11 === base11);

  // === 12. Stage-based RAG: cloud model + planner role → apply RAG ===
  console.log('\nTest 12: stage-based RAG (cloud model + thinking role)');
  const b12 = new RagPromptBuilder({ projectDir: __dirname });
  assert('isStageRole(planner) → true', b12.isStageRole('planner') === true);
  assert('isStageRole(scanner) → true', b12.isStageRole('scanner') === true);
  assert('isStageRole(reviewer) → true', b12.isStageRole('reviewer') === true);
  assert('isStageRole(builder) → false', b12.isStageRole('builder') === false);
  assert('isStageRole(fe-dev) → false', b12.isStageRole('fe-dev') === false);
  assert('isStageRole(undefined) → false', b12.isStageRole(undefined) === false);

  // shouldApplyRag combines both signals
  assert('shouldApplyRag cloud+builder → false',
    b12.shouldApplyRag({ modelId: 'smart', agentRole: 'builder' }).apply === false);
  assert('shouldApplyRag cloud+planner → true (reason=stage)',
    b12.shouldApplyRag({ modelId: 'smart', agentRole: 'planner' }).apply === true &&
    b12.shouldApplyRag({ modelId: 'smart', agentRole: 'planner' }).reason === 'stage');
  assert('shouldApplyRag local+builder → true (reason=local)',
    b12.shouldApplyRag({ modelId: 'local-heavy', agentRole: 'builder' }).apply === true &&
    b12.shouldApplyRag({ modelId: 'local-heavy', agentRole: 'builder' }).reason === 'local');

  // build() voi cloud + planner → RAG applied, metric rag_applied_stage tang
  const builderStage = new RagPromptBuilder({
    projectDir: __dirname,
    embeddings: makeStubEmbeddings([{ id: 's', score: 0.9, text: 'planFlow' }]),
    contextManager: makeStubCtxMgr(STACK_MD)
  });
  const outStage = await builderStage.build({
    basePrompt: 'Planner base',
    userMessage: 'design auth flow',
    modelId: 'smart',
    agentRole: 'planner'
  });
  assert('cloud+planner output has RAG markers',
    outStage.includes('USER STACK PROFILE'));
  const mStage = builderStage.getMetrics();
  assert('rag_applied_stage incremented', mStage.rag_applied_stage === 1);
  assert('rag_applied_local unchanged', mStage.rag_applied_local === 0);
  assert('rag_applied total = 1', mStage.rag_applied === 1);

  // build() voi cloud + builder → bypass (skipped_cloud)
  const builderExec = new RagPromptBuilder({
    projectDir: __dirname,
    embeddings: makeStubEmbeddings([{ id: 's', score: 0.9, text: 'code' }]),
    contextManager: makeStubCtxMgr(STACK_MD)
  });
  const outExec = await builderExec.build({
    basePrompt: 'Builder base',
    userMessage: 'write code',
    modelId: 'smart',
    agentRole: 'builder'
  });
  assert('cloud+builder byte-exact (RAG skipped)', outExec === 'Builder base');
  assert('rag_skipped_cloud incremented for execute role',
    builderExec.getMetrics().rag_skipped_cloud === 1);

  // Cleanup tmp
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  console.warn = origWarn;
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => {
  console.warn = origWarn;
  console.error('Test crashed:', e);
  process.exit(1);
});
