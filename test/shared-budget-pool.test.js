#!/usr/bin/env node
/**
 * Test shared budget pool — inter-agent coordination
 *
 * Cases:
 *  1. 3 agents reserve $0.50 moi, pool cap $1 → 2 granted, 3rd denied
 *  2. Commit voi actual < reserved → refund ve pool
 *  3. Release reservation → tra budget
 *  4. Singleton: getSharedPool(sameDir) tra cung instance
 *  5. Agent register/unregister events
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
  const dir = path.join(os.tmpdir(), `pool-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(dir, '.orcai'), { recursive: true });
  return dir;
}

function writeBudget(dir, cfg) {
  fs.writeFileSync(path.join(dir, '.orcai', 'budget.json'), JSON.stringify(cfg, null, 2));
}

function freshModule() {
  delete require.cache[require.resolve('../lib/cost-tracker')];
  return require('../lib/cost-tracker');
}

// === Test 1: 3 agents reserve $0.50, cap $1 → 2 granted ===
console.log('=== Test 1: reservation cap enforcement ===');
{
  const dir = mkTempProject();
  writeBudget(dir, { dailyCapUSD: 1, perTaskCapUSD: 1, warnPercent: 80, enforceCap: true });

  const { getSharedPool, _resetSharedPools } = freshModule();
  _resetSharedPools();
  const pool = getSharedPool(dir);

  const events = { granted: [], denied: [], registered: [] };
  pool.on('reservation-granted', (e) => events.granted.push(e));
  pool.on('reservation-denied', (e) => events.denied.push(e));
  pool.on('agent-registered', (e) => events.registered.push(e));

  pool.registerAgent('a1');
  pool.registerAgent('a2');
  pool.registerAgent('a3');
  assert('3 agents registered', events.registered.length === 3);
  assert('activeCount = 3', pool.getActiveAgents().length === 3);

  const r1 = pool.reserveBudget('a1', 0.50);
  const r2 = pool.reserveBudget('a2', 0.50);
  const r3 = pool.reserveBudget('a3', 0.50);

  assert('1st reservation granted', r1.granted === true, JSON.stringify(r1));
  assert('2nd reservation granted', r2.granted === true, JSON.stringify(r2));
  assert('3rd reservation DENIED', r3.granted === false, JSON.stringify(r3));
  assert('denial cites daily cap', r3.capType === 'daily');
  assert('granted events = 2', events.granted.length === 2);
  assert('denied events = 1', events.denied.length === 1);
  assert('reservedTotal = 1.0', Math.abs(pool.getReservedTotal() - 1.0) < 1e-9);

  pool.flush();
}

// === Test 2: commit actual < reserved → pool shows actual spent, refund released ===
console.log('\n=== Test 2: commit with refund ===');
{
  const dir = mkTempProject();
  writeBudget(dir, { dailyCapUSD: 2, perTaskCapUSD: 2, warnPercent: 80, enforceCap: true });
  const { getSharedPool, _resetSharedPools } = freshModule();
  _resetSharedPools();
  const pool = getSharedPool(dir);

  pool.registerAgent('b1');
  const res = pool.reserveBudget('b1', 0.50);
  assert('reservation granted', res.granted === true);
  assert('reserved 0.50', Math.abs(pool.getReservedTotal() - 0.50) < 1e-9);

  const commit = pool.commitReservation(res.reservationId, 0.30);
  assert('commit ok', commit.committed === true);
  assert('actualUSD = 0.30', Math.abs(commit.actualUSD - 0.30) < 1e-9);
  assert('refundUSD = 0.20', Math.abs(commit.refundUSD - 0.20) < 1e-9);
  assert('reservedTotal released to 0', Math.abs(pool.getReservedTotal()) < 1e-9);
  assert('daily total = 0.30', Math.abs(pool.getDailyTotal() - 0.30) < 1e-9);

  // Sau khi refund, agent khac co the reserve phan da refund
  pool.registerAgent('b2');
  const res2 = pool.reserveBudget('b2', 1.60);
  assert('after refund, larger reservation fits', res2.granted === true, JSON.stringify(res2));

  pool.flush();
}

// === Test 3: release reservation returns budget ===
console.log('\n=== Test 3: release reservation ===');
{
  const dir = mkTempProject();
  writeBudget(dir, { dailyCapUSD: 1, perTaskCapUSD: 1, warnPercent: 80, enforceCap: true });
  const { getSharedPool, _resetSharedPools } = freshModule();
  _resetSharedPools();
  const pool = getSharedPool(dir);

  pool.registerAgent('c1');
  const res = pool.reserveBudget('c1', 0.80);
  assert('reservation granted', res.granted === true);

  // Agent c2 try reserve 0.50 → denied (0.80 reserved + 0.50 > 1.0)
  pool.registerAgent('c2');
  const r2a = pool.reserveBudget('c2', 0.50);
  assert('2nd reservation denied before release', r2a.granted === false);

  // Release c1 → c2 can reserve
  const rel = pool.releaseReservation(res.reservationId);
  assert('release ok', rel.released === true);
  assert('reservedTotal back to 0', Math.abs(pool.getReservedTotal()) < 1e-9);

  const r2b = pool.reserveBudget('c2', 0.50);
  assert('2nd reservation granted after release', r2b.granted === true);

  // Release non-existent → false
  const relBad = pool.releaseReservation('res-does-not-exist');
  assert('release unknown id returns false', relBad.released === false);

  pool.flush();
}

// === Test 4: singleton — same dir returns same instance ===
console.log('\n=== Test 4: singleton per projectDir ===');
{
  const dir = mkTempProject();
  writeBudget(dir, { dailyCapUSD: 10, perTaskCapUSD: 10, warnPercent: 80, enforceCap: true });
  const { getSharedPool, _resetSharedPools } = freshModule();
  _resetSharedPools();

  const poolA = getSharedPool(dir);
  const poolB = getSharedPool(dir);
  assert('same dir → same instance', poolA === poolB);

  // State shared: register tren A, thay duoc tren B
  poolA.registerAgent('shared-1');
  assert('state shared across refs', poolB.getActiveAgents().includes('shared-1'));

  // Different dir → different instance
  const dir2 = mkTempProject();
  writeBudget(dir2, { dailyCapUSD: 10, perTaskCapUSD: 10, warnPercent: 80, enforceCap: true });
  const poolC = getSharedPool(dir2);
  assert('different dir → different instance', poolC !== poolA);

  poolA.flush();
  poolC.flush();
}

// === Test 5: unregister cleans up orphan reservations ===
console.log('\n=== Test 5: unregister releases orphan reservations ===');
{
  const dir = mkTempProject();
  writeBudget(dir, { dailyCapUSD: 5, perTaskCapUSD: 5, warnPercent: 80, enforceCap: true });
  const { getSharedPool, _resetSharedPools } = freshModule();
  _resetSharedPools();
  const pool = getSharedPool(dir);

  pool.registerAgent('ghost');
  pool.reserveBudget('ghost', 1.0);
  pool.reserveBudget('ghost', 1.0);
  assert('2 reservations held', Math.abs(pool.getReservedTotal() - 2.0) < 1e-9);

  pool.unregisterAgent('ghost');
  assert('unregister released reservations', Math.abs(pool.getReservedTotal()) < 1e-9);
  assert('agent removed', !pool.getActiveAgents().includes('ghost'));

  pool.flush();
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
