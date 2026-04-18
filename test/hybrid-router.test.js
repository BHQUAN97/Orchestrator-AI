#!/usr/bin/env node
/**
 * Hybrid Router Test — kiem tra hybridRoute + privacy rules
 *
 * Cover:
 *  - Privacy rule match → force local-heavy
 *  - Local classifier fail/timeout → silent fallback to cloud path
 *  - High confidence + trivial → local-workhorse
 *  - Low confidence → cloud path
 *
 * Chay: node test/hybrid-router.test.js
 */

const { SmartRouter } = require('../router/smart-router');
const { isPrivatePath, forceLocalForPaths } = require('../lib/privacy-rules');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  const wrap = (result) => {
    if (result instanceof Promise) {
      return result
        .then(() => { passed++; console.log(`OK  ${name}`); })
        .catch(e => { failed++; failures.push({ name, error: e.message }); console.log(`FAIL ${name}: ${e.message}`); });
    }
    passed++;
    console.log(`OK  ${name}`);
  };
  try { return wrap(fn()); }
  catch (e) { failed++; failures.push({ name, error: e.message }); console.log(`FAIL ${name}: ${e.message}`); }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// Helper: tao router voi mock classifier
function makeRouter(classifierMock, slmRouteMock) {
  const router = new SmartRouter();
  if (classifierMock !== undefined) {
    router._callLocalClassifier = classifierMock;
  }
  if (slmRouteMock !== undefined) {
    router.slmRoute = slmRouteMock;
  }
  return router;
}

(async () => {
  console.log('=== Hybrid Router Test ===\n');

  // --- Privacy rules ---
  test('isPrivatePath matches .env', () => {
    assert(isPrivatePath('project/.env'), '.env should match');
    assert(isPrivatePath('app/.env.local'), '.env.local should match');
    assert(isPrivatePath('src/config/.env.production'), 'nested .env should match');
  });

  test('isPrivatePath matches secrets dir', () => {
    assert(isPrivatePath('src/secrets/api.json'), 'secrets/ should match');
    assert(isPrivatePath('deep/nested/secrets/foo/bar.txt'), 'deep secrets should match');
  });

  test('isPrivatePath matches keys/pems', () => {
    assert(isPrivatePath('keys/server.key'), '*.key should match');
    assert(isPrivatePath('certs/cert.pem'), '*.pem should match');
  });

  test('isPrivatePath misses normal files', () => {
    assert(!isPrivatePath('src/index.js'), 'index.js should NOT match');
    assert(!isPrivatePath('README.md'), 'README should NOT match');
  });

  test('forceLocalForPaths triggers on mixed list', () => {
    const files = ['src/a.ts', 'src/b.ts', '.env'];
    assert(forceLocalForPaths(files), 'should trigger due to .env');
    assert(!forceLocalForPaths(['src/a.ts', 'src/b.ts']), 'clean list should NOT trigger');
  });

  // --- hybridRoute: privacy match forces local-heavy ---
  await test('hybridRoute: privacy-flagged files force local-heavy', async () => {
    // Classifier should NOT be called when privacy matches
    let classifierCalled = false;
    const router = makeRouter(
      async () => { classifierCalled = true; return null; },
      async () => { throw new Error('slmRoute should not be called'); }
    );

    const result = await router.hybridRoute({
      prompt: 'Review .env file',
      task: 'review',
      files: ['src/.env.production', 'src/config.ts'],
      project: 'testproj'
    });

    assert(result.model === 'local-heavy', `expected local-heavy, got ${result.model}`);
    assert(result.litellm_name === 'local-heavy', 'litellm_name mismatch');
    assert(result.routing_method === 'privacy', `expected privacy, got ${result.routing_method}`);
    assert(result.reasons.includes('privacy'), 'reasons should include privacy');
    assert(!classifierCalled, 'classifier must NOT be called on privacy hit');
    assert(result.privacy_match && result.privacy_match.file, 'privacy_match missing');
  });

  // --- hybridRoute: classifier fail → fallback to slmRoute ---
  await test('hybridRoute: local classifier fail → silent fallback to cloud', async () => {
    let slmCalled = false;
    const router = makeRouter(
      async () => { throw new Error('simulated LM Studio down'); },
      async () => {
        slmCalled = true;
        return {
          model: 'deepseek-v3.2',
          litellm_name: 'default',
          score: 50,
          reasons: ['heuristic fallback'],
          description: 'mock',
          cost: 0.3,
          alternatives: [],
          analysis: { task: '', domains: [], keywords: [], files_count: 0, context_size: 0 },
          routing_method: 'heuristic_fallback'
        };
      }
    );

    const result = await router.hybridRoute({
      prompt: 'Build a REST endpoint',
      task: 'build',
      files: ['src/api.ts'],
      project: 'x'
    });

    assert(slmCalled, 'slmRoute should be called when local fails');
    assert(result.model === 'deepseek-v3.2', `got ${result.model}`);
    assert(['hybrid_cloud', 'heuristic_fallback'].includes(result.routing_method),
      `routing_method=${result.routing_method}`);
  });

  // --- hybridRoute: high confidence trivial → local-workhorse ---
  await test('hybridRoute: high confidence + trivial → local-workhorse', async () => {
    const router = makeRouter(
      async () => ({ intent: 'docs', complexity: 'trivial', confidence: 0.92 }),
      async () => { throw new Error('slmRoute should not be called'); }
    );

    const result = await router.hybridRoute({
      prompt: 'Add JSDoc comment to helper function',
      task: 'docs',
      files: ['src/utils.ts']
    });

    assert(result.model === 'local-workhorse', `expected local-workhorse, got ${result.model}`);
    assert(result.routing_method === 'hybrid_local', `routing_method=${result.routing_method}`);
    assert(result.local_classification.intent === 'docs', 'classification preserved');
    assert(result.cost === 0, 'local cost should be 0');
  });

  // --- hybridRoute: low confidence → cloud ---
  await test('hybridRoute: low confidence → fall through to cloud', async () => {
    let slmCalled = false;
    const router = makeRouter(
      async () => ({ intent: 'build', complexity: 'complex', confidence: 0.45 }),
      async () => {
        slmCalled = true;
        return {
          model: 'sonnet-4.6',
          litellm_name: 'smart',
          score: 80,
          reasons: ['complex task'],
          description: 'mock sonnet',
          cost: 3,
          alternatives: [],
          analysis: { task: '', domains: [], keywords: [], files_count: 0, context_size: 0 },
          routing_method: 'slm'
        };
      }
    );

    const result = await router.hybridRoute({
      prompt: 'Refactor auth middleware to support multi-tenant',
      task: 'refactor',
      files: ['src/server.ts']
    });

    assert(slmCalled, 'slmRoute should be called');
    assert(result.model === 'sonnet-4.6', `got ${result.model}`);
    assert(result.local_classification.confidence === 0.45, 'classification attached');
  });

  // --- hybridRoute: high confidence but complex → cloud ---
  await test('hybridRoute: high confidence but complex → cloud', async () => {
    let slmCalled = false;
    const router = makeRouter(
      async () => ({ intent: 'build', complexity: 'complex', confidence: 0.95 }),
      async () => {
        slmCalled = true;
        return {
          model: 'deepseek-v3.2',
          litellm_name: 'default',
          score: 85,
          reasons: ['complex build'],
          description: 'ds',
          cost: 0.3,
          alternatives: [],
          analysis: { task: '', domains: [], keywords: [], files_count: 0, context_size: 0 },
          routing_method: 'slm'
        };
      }
    );

    const result = await router.hybridRoute({
      prompt: 'Implement new OAuth flow with PKCE',
      task: 'build',
      files: ['src/auth-core.ts']
    });

    assert(slmCalled, 'slmRoute should be called for complex tasks');
    assert(result.model !== 'local-workhorse', 'should NOT pick local-workhorse');
  });

  // --- Summary ---
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failures.length) {
    for (const f of failures) console.log(` - ${f.name}: ${f.error}`);
    process.exit(1);
  }
})();
