#!/usr/bin/env node
/**
 * Trace Store Test — save/list/get/prune round trip
 *
 * Chay: node test/trace-store.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result
        .then(() => { passed++; console.log(`✓ ${name}`); })
        .catch(e => { failed++; failures.push({ name, error: e.message }); console.log(`✗ ${name}: ${e.message}`); });
    }
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`✗ ${name}: ${e.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orcai-trace-'));
}

function mkTrace(id, overrides = {}) {
  return {
    id,
    startedAt: Date.now() - 10000,
    endedAt: Date.now(),
    status: 'completed',
    task: `Task for ${id}`,
    steps: [
      { agent: 'scanner', model: 'cheap', tool: 'scan', cost: 0.001, tokens: 100, durationMs: 200 },
      { agent: 'builder', model: 'smart', tool: 'write_file', cost: 0.01, tokens: 500, durationMs: 1500 }
    ],
    totalCost: 0.011,
    totalTokens: 600,
    result: { summary: 'ok' },
    ...overrides
  };
}

(async () => {
  console.log('=== TraceStore Test ===\n');

  const { TraceStore } = require('../lib/trace-store');

  // --- Round trip: save + get ---
  test('save + get round trip', () => {
    const dir = mkTmp();
    try {
      const store = new TraceStore({ projectDir: dir });
      const t = mkTrace('trc-test-1');
      const res = store.save(t);
      assert(res.id === 'trc-test-1');
      assert(fs.existsSync(res.path));
      const loaded = store.get('trc-test-1');
      assert(loaded);
      assert(loaded.id === 'trc-test-1');
      assert(loaded.status === 'completed');
      assert(loaded.steps.length === 2);
      assert(loaded.totalCost === 0.011);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('get returns null for missing trace', () => {
    const dir = mkTmp();
    try {
      const store = new TraceStore({ projectDir: dir });
      assert(store.get('nope') === null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- List + filters ---
  test('list returns newest first', () => {
    const dir = mkTmp();
    try {
      const store = new TraceStore({ projectDir: dir });
      const now = Date.now();
      store.save(mkTrace('trc-1', { startedAt: now - 30000 }));
      store.save(mkTrace('trc-2', { startedAt: now - 20000 }));
      store.save(mkTrace('trc-3', { startedAt: now - 10000 }));
      const list = store.list({});
      assert(list.length === 3, `got ${list.length}`);
      assert(list[0].id === 'trc-3', `expected trc-3 first, got ${list[0].id}`);
      assert(list[2].id === 'trc-1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('list filters by status', () => {
    const dir = mkTmp();
    try {
      const store = new TraceStore({ projectDir: dir });
      store.save(mkTrace('trc-a', { status: 'completed' }));
      store.save(mkTrace('trc-b', { status: 'failed' }));
      store.save(mkTrace('trc-c', { status: 'completed' }));
      const failed = store.list({ status: 'failed' });
      assert(failed.length === 1);
      assert(failed[0].id === 'trc-b');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('list filters by since/until', () => {
    const dir = mkTmp();
    try {
      const store = new TraceStore({ projectDir: dir });
      const base = Date.now();
      store.save(mkTrace('trc-old', { startedAt: base - 100000 }));
      store.save(mkTrace('trc-mid', { startedAt: base - 50000 }));
      store.save(mkTrace('trc-new', { startedAt: base }));
      const since = store.list({ since: base - 60000 });
      assert(since.length === 2);
      const window = store.list({ since: base - 60000, until: base - 40000 });
      assert(window.length === 1);
      assert(window[0].id === 'trc-mid');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('list respects limit', () => {
    const dir = mkTmp();
    try {
      const store = new TraceStore({ projectDir: dir });
      for (let i = 0; i < 10; i++) {
        store.save(mkTrace(`trc-${i}`, { startedAt: Date.now() - (10 - i) * 1000 }));
      }
      const limited = store.list({ limit: 3 });
      assert(limited.length === 3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Prune ---
  test('prune keeps newest N', () => {
    const dir = mkTmp();
    try {
      const store = new TraceStore({ projectDir: dir });
      for (let i = 0; i < 10; i++) {
        store.save(mkTrace(`trc-p-${i}`, { startedAt: Date.now() - (10 - i) * 1000 }));
      }
      const res = store.prune(4);
      assert(res.removed === 6, `expected 6 removed, got ${res.removed}`);
      assert(res.kept === 4);
      const remaining = store.list({});
      assert(remaining.length === 4);
      // Newest preserved
      assert(remaining[0].id === 'trc-p-9');
      // Oldest files deleted
      assert(!fs.existsSync(path.join(dir, '.orcai', 'traces', 'trc-p-0.json')));
      assert(fs.existsSync(path.join(dir, '.orcai', 'traces', 'trc-p-9.json')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('prune noop when under cap', () => {
    const dir = mkTmp();
    try {
      const store = new TraceStore({ projectDir: dir });
      store.save(mkTrace('trc-one'));
      const res = store.prune(5);
      assert(res.removed === 0);
      assert(res.kept === 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('prune rejects invalid arg', () => {
    const dir = mkTmp();
    try {
      const store = new TraceStore({ projectDir: dir });
      let threw = false;
      try { store.prune(-1); } catch { threw = true; }
      assert(threw, 'expected throw for negative');
      threw = false;
      try { store.prune(1.5); } catch { threw = true; }
      assert(threw, 'expected throw for float');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Delete ---
  test('delete removes file + index entry', () => {
    const dir = mkTmp();
    try {
      const store = new TraceStore({ projectDir: dir });
      store.save(mkTrace('trc-del'));
      const before = store.list({});
      assert(before.length === 1);
      const res = store.delete('trc-del');
      assert(res.removedFile);
      const after = store.list({});
      assert(after.length === 0);
      assert(store.get('trc-del') === null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Normalize tolerance ---
  test('save normalizes PipelineTracer-shape trace', () => {
    const dir = mkTmp();
    try {
      const store = new TraceStore({ projectDir: dir });
      // Legacy shape: traceId, startTime, status:'done'
      store.save({
        traceId: 'trc-legacy',
        startTime: Date.now() - 5000,
        endTime: Date.now(),
        status: 'done',
        operation: 'legacy run',
        steps: [
          { name: 'scan', label: 'Scanner', model: 'cheap', elapsed_ms: 100, status: 'done', startTime: Date.now() - 5000, endTime: Date.now() - 4900, result: { tokens: 50 } }
        ]
      });
      const loaded = store.get('trc-legacy');
      assert(loaded.id === 'trc-legacy');
      assert(loaded.status === 'completed', `got ${loaded.status}`);
      assert(loaded.steps[0].durationMs === 100);
      assert(loaded.steps[0].tokens === 50);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('save throws without id', () => {
    const dir = mkTmp();
    try {
      const store = new TraceStore({ projectDir: dir });
      let threw = false;
      try { store.save({ status: 'completed' }); } catch { threw = true; }
      assert(threw);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Dedupe on list (re-save same id) ---
  test('list dedupes by id after re-save', () => {
    const dir = mkTmp();
    try {
      const store = new TraceStore({ projectDir: dir });
      store.save(mkTrace('trc-dup', { status: 'running' }));
      store.save(mkTrace('trc-dup', { status: 'completed' }));
      const list = store.list({});
      assert(list.length === 1, `expected 1 after dedup, got ${list.length}`);
      assert(list[0].status === 'completed', `expected newest status, got ${list[0].status}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- trace-api surface ---
  test('trace-api listTraces returns ok envelope', () => {
    const dir = mkTmp();
    try {
      const { TraceStore } = require('../lib/trace-store');
      const store = new TraceStore({ projectDir: dir });
      store.save(mkTrace('trc-api-1'));
      const { listTraces, getTrace, deleteTrace, pruneTraces } = require('../lib/trace-api');
      const l = listTraces({ projectDir: dir });
      assert(l.ok);
      assert(l.data.count === 1);
      const g = getTrace('trc-api-1', { projectDir: dir });
      assert(g.ok);
      assert(g.data.id === 'trc-api-1');
      const miss = getTrace('nope', { projectDir: dir });
      assert(!miss.ok);
      const p = pruneTraces(0, { projectDir: dir });
      assert(p.ok);
      assert(p.data.removed === 1);
      const d = deleteTrace('gone', { projectDir: dir });
      assert(d.ok); // delete of missing is still ok (idempotent)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- replay integration ---
  await test('replayFromTrace dry-run replays steps', async () => {
    const dir = mkTmp();
    try {
      const { TraceStore } = require('../lib/trace-store');
      const { replayFromTrace, compareTraces } = require('../lib/replay');
      const store = new TraceStore({ projectDir: dir });
      store.save(mkTrace('trc-rp-1'));
      store.save(mkTrace('trc-rp-2', {
        steps: [
          { agent: 'scanner', model: 'cheap', tool: 'scan', cost: 0.001, tokens: 100, durationMs: 200 },
          { agent: 'builder', model: 'smart', tool: 'write_file', cost: 0.02, tokens: 900, durationMs: 3000 }
        ],
        totalCost: 0.021,
        totalTokens: 1000
      }));
      const rp = await replayFromTrace('trc-rp-1', { projectDir: dir });
      assert(rp.success);
      assert(rp.steps.length === 2);
      assert(rp.dryRun === true);
      const rpFrom = await replayFromTrace('trc-rp-1', { projectDir: dir, fromStep: 1 });
      assert(rpFrom.steps.length === 1);
      assert(rpFrom.skipped === 1);

      const diff = compareTraces('trc-rp-1', 'trc-rp-2', { projectDir: dir });
      assert(diff.success);
      assert(typeof diff.summary.costDelta === 'number');
      assert(diff.summary.costDelta > 0.009);
      assert(diff.steps.length === 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await new Promise(r => setTimeout(r, 100));

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  - ${f.name}: ${f.error}`));
    process.exit(1);
  }
})();
