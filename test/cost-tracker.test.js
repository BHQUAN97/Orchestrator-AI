#!/usr/bin/env node
/**
 * Test cho lib/cost-tracker.js
 *  - record + getDailyTotal round trip
 *  - checkCap allows below cap, blocks above
 *  - cap-warning emits tai 80%
 *  - reload from disk preserves state
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;

function assert(name, cond, detail = '') {
  if (cond) { console.log(`  PASS ${name}`); passed++; }
  else { console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`); failed++; }
}

function mkTempProject() {
  const dir = path.join(os.tmpdir(), `ct-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(dir, '.orcai'), { recursive: true });
  return dir;
}

function writeBudget(dir, cfg) {
  fs.writeFileSync(path.join(dir, '.orcai', 'budget.json'), JSON.stringify(cfg, null, 2));
}

function freshTracker(dir) {
  // Xoa cache de lay instance moi moi lan
  delete require.cache[require.resolve('../lib/cost-tracker')];
  const { CostTracker } = require('../lib/cost-tracker');
  return new CostTracker(dir);
}

// === Test 1: record + getDailyTotal roundtrip ===
console.log('=== Test 1: record + getDailyTotal ===');
{
  const dir = mkTempProject();
  writeBudget(dir, { dailyCapUSD: 10, perTaskCapUSD: 5, warnPercent: 80, enforceCap: true });
  const tracker = freshTracker(dir);

  let spendEvents = 0;
  let lastPayload = null;
  tracker.on('spend', (p) => { spendEvents++; lastPayload = p; });

  tracker.record({ taskId: 't1', model: 'smart', inputTokens: 1000, outputTokens: 200, costUSD: 0.5 });
  tracker.record({ taskId: 't1', model: 'smart', inputTokens: 500, outputTokens: 100, costUSD: 0.25 });
  tracker.record({ taskId: 't2', model: 'cheap', inputTokens: 2000, outputTokens: 300, costUSD: 0.1 });

  assert('spend event emitted 3 times', spendEvents === 3, `got ${spendEvents}`);
  assert('getDailyTotal sums correctly', Math.abs(tracker.getDailyTotal() - 0.85) < 1e-6, `got ${tracker.getDailyTotal()}`);
  assert('getTaskTotal t1', Math.abs(tracker.getTaskTotal('t1') - 0.75) < 1e-6);
  assert('getTaskTotal t2', Math.abs(tracker.getTaskTotal('t2') - 0.1) < 1e-6);
  assert('spend payload has taskTotalUSD', lastPayload && typeof lastPayload.taskTotalUSD === 'number');
  assert('spend payload has dailyTotalUSD', lastPayload && typeof lastPayload.dailyTotalUSD === 'number');

  const top = tracker.getTopTasks(5);
  assert('getTopTasks sorted desc', top[0].taskId === 't1' && top[1].taskId === 't2');
  tracker.flush();
}

// === Test 2: checkCap allows below, blocks above ===
console.log('\n=== Test 2: checkCap gate ===');
{
  const dir = mkTempProject();
  writeBudget(dir, { dailyCapUSD: 5, perTaskCapUSD: 2, warnPercent: 80, enforceCap: true });
  const tracker = freshTracker(dir);

  // Below cap
  const r1 = tracker.checkCap({ taskId: 'a', projectedCostUSD: 1.0 });
  assert('allow below per-task cap', r1.allowed === true);

  // Above per-task cap
  const r2 = tracker.checkCap({ taskId: 'a', projectedCostUSD: 2.5 });
  assert('block above per-task cap', r2.allowed === false && r2.capType === 'task', JSON.stringify(r2));

  // Record near daily cap → next check blocks on daily
  tracker.record({ taskId: 'b', costUSD: 4.5 });
  const r3 = tracker.checkCap({ taskId: 'c', projectedCostUSD: 1.0 });
  assert('block above daily cap', r3.allowed === false && r3.capType === 'daily', JSON.stringify(r3));

  // enforceCap=false → always allow
  const dir2 = mkTempProject();
  writeBudget(dir2, { dailyCapUSD: 0.01, perTaskCapUSD: 0.01, warnPercent: 80, enforceCap: false });
  const t2 = freshTracker(dir2);
  const r4 = t2.checkCap({ taskId: 'x', projectedCostUSD: 999 });
  assert('enforceCap=false bypasses', r4.allowed === true);
  t2.flush();
  tracker.flush();
}

// === Test 3: cap-warning emits at 80% ===
console.log('\n=== Test 3: cap-warning at 80% ===');
{
  const dir = mkTempProject();
  writeBudget(dir, { dailyCapUSD: 10, perTaskCapUSD: 10, warnPercent: 80, enforceCap: true });
  const tracker = freshTracker(dir);

  let warningEvents = [];
  let exceededEvents = [];
  tracker.on('cap-warning', (e) => warningEvents.push(e));
  tracker.on('cap-exceeded', (e) => exceededEvents.push(e));

  tracker.record({ taskId: 'w', costUSD: 5.0 });   // 50% → no warn
  assert('no warn at 50%', warningEvents.length === 0);

  tracker.record({ taskId: 'w', costUSD: 3.5 });   // total 8.5 → 85% → warn
  const dailyWarn = warningEvents.find(w => w.capType === 'daily');
  assert('cap-warning emitted at 85% daily', !!dailyWarn, `got ${warningEvents.length} warns`);
  assert('warn payload has percent', dailyWarn && dailyWarn.percent >= 80);

  tracker.record({ taskId: 'w', costUSD: 2.0 });   // total 10.5 → exceeded
  const dailyExc = exceededEvents.find(e => e.capType === 'daily');
  assert('cap-exceeded emitted above 100%', !!dailyExc);

  // Warning khong emit 2 lan cho cung 1 day
  const warnCountBefore = warningEvents.filter(w => w.capType === 'daily').length;
  tracker.record({ taskId: 'w', costUSD: 0.01 });
  const warnCountAfter = warningEvents.filter(w => w.capType === 'daily').length;
  assert('no duplicate daily warning', warnCountAfter === warnCountBefore);
  tracker.flush();
}

// === Test 4: reload from disk preserves state ===
console.log('\n=== Test 4: persistence round trip ===');
{
  const dir = mkTempProject();
  writeBudget(dir, { dailyCapUSD: 10, perTaskCapUSD: 5, warnPercent: 80, enforceCap: true });
  const t1 = freshTracker(dir);
  t1.record({ taskId: 'p1', costUSD: 1.23 });
  t1.record({ taskId: 'p2', costUSD: 0.77 });
  t1.flush();   // force persist ngay, bypass debounce

  assert('cost.json written', fs.existsSync(path.join(dir, '.orcai', 'cost.json')));

  const t2 = freshTracker(dir);
  assert('daily total preserved', Math.abs(t2.getDailyTotal() - 2.0) < 1e-6, `got ${t2.getDailyTotal()}`);
  t2.flush();
}

// === Test 5: BudgetExceededError from enforceHardCap ===
console.log('\n=== Test 5: enforceHardCap throws ===');
{
  const dir = mkTempProject();
  writeBudget(dir, { dailyCapUSD: 1, perTaskCapUSD: 1, warnPercent: 80, enforceCap: true });
  // Tracker phai duoc khoi tao voi dir nay qua singleton
  delete require.cache[require.resolve('../lib/cost-tracker')];
  delete require.cache[require.resolve('../lib/budget')];
  const { enforceHardCap, BudgetExceededError } = require('../lib/budget');
  const { getCostTracker } = require('../lib/cost-tracker');
  getCostTracker(dir); // init singleton voi test dir

  // Below cap passes
  let threw = false;
  try { enforceHardCap('hx', 0.5, dir); } catch (e) { threw = true; }
  assert('below cap does not throw', !threw);

  // Above cap throws
  let caught = null;
  try { enforceHardCap('hx', 5.0, dir); } catch (e) { caught = e; }
  assert('above cap throws BudgetExceededError', caught instanceof BudgetExceededError);
  assert('error has capType', caught && (caught.capType === 'task' || caught.capType === 'daily'));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
