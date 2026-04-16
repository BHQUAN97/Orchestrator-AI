#!/usr/bin/env node
/**
 * Test suite cho 3 cai tien v2.2:
 * 1. SLM Classifier
 * 2. Shadow Git
 * 3. Trust Graph env/global tracking
 */

async function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(name, condition) {
    if (condition) {
      console.log(`  ✅ ${name}`);
      passed++;
    } else {
      console.log(`  ❌ FAIL: ${name}`);
      failed++;
    }
  }

  // === SLM Classifier ===
  console.log('=== SLM Classifier Tests ===\n');

  const { SLMClassifier, INTENT_MODEL_MAP } = require('./router/slm-classifier');

  // Test 1: Intent-Model mapping
  console.log('Test 1: Intent-Model mapping');
  assert('architect:expert → architect', INTENT_MODEL_MAP['architect:expert'] === 'architect');
  assert('debug:complex → smart', INTENT_MODEL_MAP['debug:complex'] === 'smart');
  assert('build:medium → default', INTENT_MODEL_MAP['build:medium'] === 'default');
  assert('review:simple → fast', INTENT_MODEL_MAP['review:simple'] === 'fast');
  assert('docs:simple → cheap', INTENT_MODEL_MAP['docs:simple'] === 'cheap');

  // Test 2: Classification parsing
  console.log('\nTest 2: Classification parsing');
  const classifier = new SLMClassifier({ timeout: 1000 });

  const validJson = '{"intent":"build","complexity":"complex","domain":"fullstack","reasoning":"Multi-file"}';
  const p1 = classifier._parseClassification(validJson);
  assert('Valid JSON parse', p1.intent === 'build' && p1.complexity === 'complex' && p1.domain === 'fullstack');

  const mdJson = '```json\n{"intent":"fix","complexity":"simple","domain":"frontend","reasoning":"CSS"}\n```';
  const p2 = classifier._parseClassification(mdJson);
  assert('Markdown JSON parse', p2.intent === 'fix' && p2.domain === 'frontend');

  const badJson = 'The task is to fix a frontend bug in React';
  const p3 = classifier._parseClassification(badJson);
  assert('Fallback text extraction', p3.intent === 'fix' && p3.domain === 'frontend');

  const invalidVals = '{"intent":"destroy","complexity":"mega","domain":"space"}';
  const p4 = classifier._parseClassification(invalidVals);
  assert('Invalid values → defaults', p4.intent === 'build' && p4.complexity === 'medium');

  // Test 3: Model tier mapping
  console.log('\nTest 3: Model tier mapping');
  const t1 = classifier._mapToModelTier({ intent: 'architect', complexity: 'expert', domain: 'fullstack' });
  assert('architect:expert → architect tier', t1 === 'architect');
  const t2 = classifier._mapToModelTier({ intent: 'docs', complexity: 'simple', domain: 'docs' });
  assert('docs:simple → cheap tier', t2 === 'cheap');
  const t3 = classifier._mapToModelTier({ intent: 'build', complexity: 'complex', domain: 'database' });
  assert('build:complex+database → default tier', t3 === 'default');

  // Test 4: Domain boost — avoid cheap for database
  console.log('\nTest 4: Domain boost');
  const t4 = classifier._mapToModelTier({ intent: 'docs', complexity: 'medium', domain: 'database' });
  assert('Database avoids cheap tier', t4 !== 'cheap');

  // Test 5: User message building
  console.log('\nTest 5: User message');
  const msg = classifier._buildUserMessage('build', ['src/Button.tsx', 'src/api.ts'], 'Fix styling', 'MyApp');
  assert('Message contains task', msg.includes('Task type: build'));
  assert('Message contains files', msg.includes('Button.tsx'));
  assert('Message contains prompt', msg.includes('Fix styling'));

  // Test 6: Cache key
  console.log('\nTest 6: Cache');
  const k1 = classifier._cacheKey('build', ['a.ts'], 'fix bug');
  const k2 = classifier._cacheKey('build', ['a.ts'], 'fix bug');
  const k3 = classifier._cacheKey('fix', ['b.ts'], 'fix bug');
  assert('Same input → same key', k1 === k2);
  assert('Different input → different key', k1 !== k3);

  // Test 7: Confidence
  console.log('\nTest 7: Confidence');
  const c1 = classifier._estimateConfidence({ intent: 'build', complexity: 'medium', domain: 'frontend', reasoning: 'Building React component' });
  const c2 = classifier._estimateConfidence({ intent: 'architect', complexity: 'expert', domain: 'docs', reasoning: '' });
  assert('Coherent task has higher confidence', c1 > c2);

  // === Shadow Git ===
  console.log('\n=== Shadow Git Tests ===\n');

  const { ShadowGit } = require('./tools/shadow-git');

  // Test 8: Constructor
  console.log('Test 8: Constructor');
  const shadow = new ShadowGit(process.cwd());
  assert('Detects git repo', shadow.isGitRepo === true);
  assert('Enabled by default', shadow.enabled === true);

  // Test 9: Disabled mode
  console.log('\nTest 9: Disabled mode');
  const shadowOff = new ShadowGit(process.cwd(), { enabled: false });
  const r1 = await shadowOff.ensureSnapshot('test');
  assert('Returns null when disabled', r1 === null);

  // Test 10: Session lock
  console.log('\nTest 10: Session lock');
  const shadow2 = new ShadowGit(process.cwd());
  shadow2.sessionSnapshot = 'abc123';
  const r2 = await shadow2.ensureSnapshot('test');
  assert('Returns existing snapshot (no duplicate)', r2 === 'abc123');

  // Test 11: Rollback when disabled
  console.log('\nTest 11: Rollback disabled');
  const r3 = shadowOff.rollback('abc');
  assert('Rollback fails gracefully', !r3.success && r3.message.includes('not enabled'));

  // Test 12: Rollback no hash
  console.log('\nTest 12: Rollback no hash');
  const shadow3 = new ShadowGit(process.cwd());
  const r4 = shadow3.rollback();
  assert('Rollback fails with no snapshot', !r4.success);

  // Test 13: getSnapshots
  console.log('\nTest 13: getSnapshots');
  assert('Empty snapshots initially', shadow3.getSnapshots().length === 0);

  // === Trust Graph Env Tracking ===
  console.log('\n=== Trust Graph Env Tracking Tests ===\n');

  const { TrustGraph } = require('./graph/trust-graph');

  // Test 14: Env var parsing
  console.log('Test 14: Env var parsing');
  const g1 = new TrustGraph(process.cwd());
  g1._parseEnvUsage('const PORT = process.env.PORT || 3000;\nconst DB = process.env.DATABASE_URL;\nconst k = process.env[\'API_KEY\'];', 'config.js');
  g1._parseEnvUsage('const port = process.env.PORT;\nconst secret = process.env.API_KEY;', 'server.js');

  assert('PORT tracked in 2 files', g1.envUsage.get('PORT')?.size === 2);
  assert('API_KEY tracked (bracket + dot)', g1.envUsage.get('API_KEY')?.size === 2);
  assert('DATABASE_URL tracked in 1 file', g1.envUsage.get('DATABASE_URL')?.size === 1);

  // Test 15: Global var parsing
  console.log('\nTest 15: Global var parsing');
  const g2 = new TrustGraph(process.cwd());
  g2._parseGlobalVars('global.appConfig = { debug: true };\nmodule.exports.MAX_RETRIES = 3;', 'globals.js');
  g2._parseGlobalVars('const cfg = global.appConfig;', 'worker.js');

  assert('global.appConfig export tracked', g2.globalExports.has('global.appConfig'));
  assert('MAX_RETRIES export tracked', g2.globalExports.has('MAX_RETRIES'));
  assert('global.appConfig usage in worker.js', g2.globalUsage.get('global.appConfig')?.has('worker.js'));

  // Test 16: Semantic edges
  console.log('\nTest 16: Semantic edges');
  const g3 = new TrustGraph(process.cwd());
  g3.envUsage.set('PORT', new Set(['config.js', 'server.js', 'health.js']));
  g3.envUsage.set('DB_URL', new Set(['config.js', 'db.js']));
  g3._buildSemanticEdges();

  const configEdges = g3.semanticEdges.get('config.js') || [];
  const serverEdges = g3.semanticEdges.get('server.js') || [];
  assert('config.js has >= 3 semantic edges', configEdges.length >= 3);
  assert('server.js linked via env:PORT', serverEdges.some(e => e.reason === 'env:PORT'));

  // Test 17: getAffectedFiles
  console.log('\nTest 17: getAffectedFiles');
  const affected = g3.getAffectedFiles('config.js');
  assert('config.js affects >= 3 files', affected.length >= 3);
  assert('Affected files have reasons', affected.every(a => a.reasons.length > 0));

  // Test 18: getEnvVarMap
  console.log('\nTest 18: getEnvVarMap');
  const envMap = g3.getEnvVarMap();
  assert('PORT has 3 files', envMap.PORT?.length === 3);
  assert('DB_URL has 2 files', envMap.DB_URL?.length === 2);

  // Test 19: Stats include semantic data
  console.log('\nTest 19: Stats');
  const stats = g3.getStats();
  assert('Stats has semanticEdges > 0', stats.semanticEdges > 0);
  assert('Stats has envVarsTracked = 2', stats.envVarsTracked === 2);

  // === FileManager Integration ===
  console.log('\n=== FileManager Integration Tests ===\n');

  const { FileManager } = require('./tools/file-manager');

  // Test 20: FileManager has shadowGit
  console.log('Test 20: FileManager integration');
  const fm = new FileManager({ projectDir: process.cwd() });
  assert('FileManager has shadowGit', fm.shadowGit instanceof ShadowGit);
  assert('Shadow git enabled by default', fm.shadowGit.enabled === true);

  const fm2 = new FileManager({ projectDir: process.cwd(), shadowGit: false });
  assert('Shadow git can be disabled', fm2.shadowGit.enabled === false);

  // === SmartRouter SLM Integration ===
  console.log('\n=== SmartRouter SLM Integration Tests ===\n');

  const { SmartRouter } = require('./router/smart-router');

  // Test 21: SmartRouter has slmRoute method
  console.log('Test 21: SmartRouter SLM method');
  const router = new SmartRouter({ costOptimize: true });
  assert('slmRoute method exists', typeof router.slmRoute === 'function');
  assert('route method still exists', typeof router.route === 'function');

  // Test 22: slmRoute (works with or without LiteLLM)
  console.log('\nTest 22: SLM route integration');
  try {
    const result = await router.slmRoute({
      task: 'build',
      files: ['src/app.tsx'],
      prompt: 'Build a React component',
      project: 'test'
    });
    assert('Returns result from slmRoute', result !== null);
    const validMethod = result.routing_method === 'slm' || result.routing_method === 'heuristic_fallback';
    assert('routing_method is slm or heuristic_fallback', validMethod);
    if (result.routing_method === 'slm') {
      assert('SLM classification present', result.slm_classification !== null);
      assert('SLM has intent', !!result.slm_classification.intent);
      assert('SLM has domain', !!result.slm_classification.domain);
      console.log(`    (SLM chose: ${result.model} — ${result.slm_classification.intent}/${result.slm_classification.domain})`);
    } else {
      console.log('    (LiteLLM not available — fell back to heuristic)');
    }
  } catch (err) {
    console.log(`  ⚠️ slmRoute threw: ${err.message}`);
  }

  // === Round 2 Fix Tests ===
  console.log('\n=== Round 2 Fix Tests ===\n');

  // Test 23: Shadow Git — command injection prevention
  console.log('Test 23: Shadow Git injection prevention');
  const shadowInject = new ShadowGit(process.cwd());
  shadowInject.enabled = true;
  shadowInject.sessionSnapshot = null;
  // Simulate malicious rollback hash
  const injResult = shadowInject.rollback('; rm -rf /');
  assert('Rejects shell injection in hash', !injResult.success && injResult.message.includes('Invalid'));
  const injResult2 = shadowInject.rollback('abc123def');  // valid hex
  // Should fail because hash doesn't exist, but format is valid
  assert('Accepts valid hex format', !injResult2.message.includes('Invalid'));

  // Test 24: Trust Graph — comment lines skipped
  console.log('\nTest 24: Comment lines skipped');
  const g4 = new TrustGraph(process.cwd());
  g4._parseEnvUsage('// process.env.FAKE_VAR is just a comment\nconst x = process.env.REAL_VAR;', 'test.js');
  assert('FAKE_VAR not tracked (in comment)', !g4.envUsage.has('FAKE_VAR'));
  assert('REAL_VAR tracked (in code)', g4.envUsage.has('REAL_VAR'));

  // Test 25: Trust Graph — destructured env detection
  console.log('\nTest 25: Destructured env detection');
  const g5 = new TrustGraph(process.cwd());
  g5._parseEnvUsage('const { API_KEY, DB_HOST, SECRET } = process.env;', 'config.js');
  assert('API_KEY from destructure', g5.envUsage.has('API_KEY'));
  assert('DB_HOST from destructure', g5.envUsage.has('DB_HOST'));
  assert('SECRET from destructure', g5.envUsage.has('SECRET'));

  // Test 26: Trust Graph — exports assignment vs comparison
  console.log('\nTest 26: Export assignment vs comparison');
  const g6 = new TrustGraph(process.cwd());
  g6._parseGlobalVars('if (exports.CONFIG === true) {}', 'check.js');
  assert('Comparison not tracked as export', !g6.globalExports.has('CONFIG'));
  g6._parseGlobalVars('exports.CONFIG = { debug: true };', 'config.js');
  assert('Assignment tracked as export', g6.globalExports.has('CONFIG'));

  // Test 27: Trust Graph — global vars in comments skipped
  console.log('\nTest 27: Global vars in comments');
  const g7 = new TrustGraph(process.cwd());
  g7._parseGlobalVars('// global.testVar = 123', 'test.js');
  assert('Comment global not tracked', !g7.globalExports.has('global.testVar'));

  // Test 28: Hub-spoke pattern (O(n) edges instead of O(n²))
  console.log('\nTest 28: Hub-spoke edge count');
  const g8 = new TrustGraph(process.cwd());
  // 100 files share NODE_ENV — should create ~198 edges (hub + 99 spokes × 2 directions)
  // NOT 100×99 = 9900 edges (all-pairs)
  const manyFiles = new Set();
  for (let i = 0; i < 100; i++) manyFiles.add(`file${i}.js`);
  g8.envUsage.set('NODE_ENV', manyFiles);
  g8._buildSemanticEdges();
  const totalEdges = Array.from(g8.semanticEdges.values()).reduce((s, e) => s + e.length, 0);
  assert(`Hub-spoke: ${totalEdges} edges (should be ~198, not 9900)`, totalEdges < 500);

  // Test 29: SLM classifier — empty response handling
  console.log('\nTest 29: SLM empty response');
  const classifier2 = new SLMClassifier({});
  assert('Empty string → null', classifier2._parseClassification('') === null);
  assert('Whitespace → null', classifier2._parseClassification('   ') === null);
  assert('null → null', classifier2._parseClassification(null) === null);

  // Test 30: Trust Graph — camelCase env vars
  console.log('\nTest 30: camelCase env vars');
  const g9 = new TrustGraph(process.cwd());
  g9._parseEnvUsage('const port = process.env.port || 3000;', 'app.js');
  assert('Lowercase env var tracked', g9.envUsage.has('port'));

  // === Pipeline Tracer Tests ===
  console.log('\n=== Pipeline Tracer Tests ===\n');

  const { PipelineTracer, Trace } = require('./lib/pipeline-tracer');

  // Test 31: Create trace
  console.log('Test 31: Create trace');
  const pTracer = new PipelineTracer({ maxTraces: 10 });
  const tr1 = pTracer.start('run', { prompt: 'test task' });
  assert('Trace created', tr1 instanceof Trace);
  assert('Trace has ID', tr1.traceId.startsWith('trc-'));
  assert('Status is running', tr1.status === 'running');

  // Test 32: Step tracking
  console.log('\nTest 32: Step tracking');
  tr1.step('scan', { model: 'cheap' });
  tr1.stepDone('scan', { output: 'scan result', tokens: 500 });
  assert('Step recorded', tr1.steps.length === 1);
  assert('Step status done', tr1.steps[0].status === 'done');
  assert('Step has elapsed', tr1.steps[0].elapsed_ms >= 0);

  // Test 33: Step failure + error attribution
  console.log('\nTest 33: Step failure');
  tr1.step('plan', { model: 'default' });
  tr1.stepFail('plan', new Error('fetch failed'), { model: 'default' });
  assert('Error recorded', tr1.errors.length === 1);
  assert('Error has suggestion', tr1.errors[0].suggestion !== null);
  assert('Error type is network', tr1.errors[0].type === 'network');

  // Test 34: Finish trace
  console.log('\nTest 34: Finish trace');
  const traceSummary = pTracer.finish(tr1);
  assert('Summary has traceId', !!traceSummary.traceId);
  assert('Status is failed (has errors)', traceSummary.status === 'failed');
  assert('Has timeline', !!traceSummary.timeline);
  assert('Timeline shows failure', traceSummary.timeline.includes('FAILED'));
  assert('Has error_attribution', !!traceSummary.error_attribution);
  assert('Error attribution has user_message', !!traceSummary.error_attribution.user_message);
  assert('Failed at Planner', traceSummary.error_attribution.failed_at === 'Planner');
  console.log(`    Timeline: ${traceSummary.timeline}`);
  console.log(`    User msg: ${traceSummary.error_attribution.user_message}`);

  // Test 35: Successful trace
  console.log('\nTest 35: Successful trace');
  const tr2 = pTracer.start('run', { prompt: 'success test' });
  tr2.step('scan', { model: 'cheap' });
  tr2.stepDone('scan', {});
  tr2.step('plan', { model: 'default' });
  tr2.stepDone('plan', { subtasks: 3 });
  tr2.step('review', { model: 'smart' });
  tr2.stepDone('review', { action: 'approve' });
  tr2.step('execute', {});
  tr2.stepDone('execute', { success: true });
  const trSum2 = pTracer.finish(tr2);
  assert('Successful trace status done', trSum2.status === 'done');
  assert('No errors', trSum2.errors.length === 0);
  assert('Timeline ends with checkmark', trSum2.timeline.endsWith('✓'));
  assert('4 steps recorded', trSum2.total_steps === 4);
  console.log(`    Timeline: ${trSum2.timeline}`);

  // Test 36: Error suggestions mapping
  console.log('\nTest 36: Error suggestions');
  const tr3 = pTracer.start('test', {});
  tr3.step('model_call', { model: 'default' });
  tr3.stepFail('model_call', new Error('Budget exhausted: $2.00 / $2.00'));
  assert('Budget error type', tr3.errors[0].type === 'budget');
  assert('Budget suggestion', tr3.errors[0].suggestion.includes('DAILY_BUDGET'));
  pTracer.finish(tr3);

  // Test 37: Get trace by ID
  console.log('\nTest 37: Get trace by ID');
  const retrieved = pTracer.get(tr2.traceId);
  assert('Retrieve by ID works', retrieved !== null);
  assert('Correct trace returned', retrieved.traceId === tr2.traceId);

  // Test 38: Get recent traces
  console.log('\nTest 38: Recent traces');
  const recent = pTracer.getRecent(5);
  assert('Recent traces returned', recent.length >= 2);

  // Test 39: Tracer stats
  console.log('\nTest 39: Tracer stats');
  const tStats = pTracer.getStats();
  assert('Stats has total', tStats.total >= 3);
  assert('Stats has success rate', typeof tStats.success_rate === 'number');
  assert('Stats tracks by_error_type', typeof tStats.by_error_type === 'object');
  console.log(`    Total: ${tStats.total}, Success rate: ${tStats.success_rate}%`);

  // Test 40: Warn tracking
  console.log('\nTest 40: Warnings');
  const tr4 = pTracer.start('test', {});
  tr4.warn('review', 'Plan rejected by Tech Lead');
  assert('Warning recorded', tr4.warnings.length === 1);
  assert('Warning has step', tr4.warnings[0].step === 'review');
  pTracer.finish(tr4);

  // Test 41: LRU eviction
  console.log('\nTest 41: LRU eviction');
  const smallTracer = new PipelineTracer({ maxTraces: 3 });
  for (let i = 0; i < 5; i++) {
    const tmpT = smallTracer.start(`op-${i}`, {});
    smallTracer.finish(tmpT);
  }
  assert('Traces capped at maxTraces', smallTracer.traces.size <= 3);

  // Test 42: Multiple error types
  console.log('\nTest 42: Error type classification');
  const tr5 = pTracer.start('test', {});
  tr5.step('a', {}); tr5.stepFail('a', new Error('ECONNREFUSED'));
  assert('ECONNREFUSED → network', tr5.errors[0].type === 'network');
  tr5.step('b', {}); tr5.stepFail('b', new Error('429 Too Many Requests'));
  assert('429 → rate_limit', tr5.errors[1].type === 'rate_limit');
  tr5.step('c', {}); tr5.stepFail('c', new Error('BLOCKED: Decision lock'));
  assert('BLOCKED → permission', tr5.errors[2].type === 'permission');
  pTracer.finish(tr5);

  // === Summary ===
  console.log('\n' + '='.repeat(50));
  console.log(`TOTAL: ${passed + failed} tests — ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('🎉 ALL TESTS PASSED');
  } else {
    console.log('⚠️ Some tests failed');
  }
  console.log('='.repeat(50));
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
