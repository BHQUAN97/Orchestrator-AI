#!/usr/bin/env node
/**
 * Test dynamic Decision Lock TTL tied to feature lifecycle
 *
 * Cases:
 *  1. Lock with featureId → persists past TTL while feature open
 *  2. closeFeatureAndUnlock → lock unlocked, audit has "feature closed" entry
 *  3. Lock without featureId → still honors standard TTL
 *  4. Feature closed → lock active for 24h buffer, then expires
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
  const dir = path.join(os.tmpdir(), `lock-ttl-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(dir, '.sdd'), { recursive: true });
  return dir;
}

function fresh() {
  delete require.cache[require.resolve('../router/decision-lock')];
  delete require.cache[require.resolve('../router/feature-registry')];
  delete require.cache[require.resolve('../router/audit-log')];
  return {
    DecisionLock: require('../router/decision-lock').DecisionLock,
    FeatureRegistry: require('../router/feature-registry').FeatureRegistry
  };
}

// === Test 1: featureId keeps lock alive past TTL ===
console.log('=== Test 1: featureId overrides TTL while feature open ===');
{
  const dir = mkTempProject();
  const { DecisionLock, FeatureRegistry } = fresh();
  const registry = new FeatureRegistry({ projectDir: dir });
  registry.registerFeature({ id: 'feat-1', name: 'auth rework' });

  const lock = new DecisionLock({ projectDir: dir, featureRegistry: registry });
  const entry = lock.lock({
    decision: 'OAuth2 flow dung PKCE',
    scope: 'auth',
    approvedBy: 'tech-lead',
    featureId: 'feat-1',
    ttl: 100 // 100ms — short TTL
  });
  assert('lock has featureId', entry.featureId === 'feat-1');
  assert('lock initially locked', lock.isLocked('auth'));

  // Gia lap TTL het han bang cach backdate lockedAt
  entry.lockedAt = new Date(Date.now() - 10 * 1000).toISOString();
  lock._save();

  // Feature van mo → KHONG expire du TTL da het
  assert('still locked past TTL (feature open)', lock.isLocked('auth'));
  const active = lock.getActive();
  assert('active decisions include feat-1 lock', active.some(d => d.featureId === 'feat-1'));
}

// === Test 2: close feature → unlock + audit entry ===
console.log('\n=== Test 2: closeFeatureAndUnlock cascades ===');
{
  const dir = mkTempProject();
  const { DecisionLock, FeatureRegistry } = fresh();
  const registry = new FeatureRegistry({ projectDir: dir });
  registry.registerFeature({ id: 'feat-2', name: 'checkout redesign' });

  const lock = new DecisionLock({ projectDir: dir, featureRegistry: registry });
  lock.lock({ decision: 'REST API, not GraphQL', scope: 'api', approvedBy: 'tech-lead', featureId: 'feat-2' });
  lock.lock({ decision: 'Stripe checkout', scope: 'payment', approvedBy: 'tech-lead', featureId: 'feat-2' });
  // Unrelated lock — khong theo feat-2
  lock.lock({ decision: 'TailwindCSS', scope: 'ui', approvedBy: 'tech-lead' });

  assert('all 3 active', lock.getActive().length === 3);

  const result = lock.closeFeatureAndUnlock('feat-2', { reason: 'merged to main', closedBy: 'user' });
  assert('feature marked closed', result.feature.status === 'closed');
  assert('2 decisions unlocked', result.unlocked.length === 2);
  assert('only unrelated lock remains active', lock.getActive().length === 1);
  assert('remaining active is ui scope', lock.getActive()[0].scope === 'ui');

  // Audit log co entry "feature closed"
  const auditFile = path.join(dir, '.sdd', 'audit.log.jsonl');
  assert('audit log file exists', fs.existsSync(auditFile));
  const auditLines = fs.readFileSync(auditFile, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  const featureCloseEntries = auditLines.filter(e =>
    e.event === 'lock_unlocked' &&
    e.details && e.details.reason === 'merged to main'
  );
  assert('audit log has 2 feature-close unlock entries', featureCloseEntries.length === 2,
    `got ${featureCloseEntries.length}, audit entries: ${JSON.stringify(auditLines.map(a => a.event))}`);
}

// === Test 3: no featureId → standard TTL behavior ===
console.log('\n=== Test 3: no featureId honors standard TTL ===');
{
  const dir = mkTempProject();
  const { DecisionLock } = fresh();
  const lock = new DecisionLock({ projectDir: dir });

  const entry = lock.lock({
    decision: 'Use PostgreSQL',
    scope: 'database',
    approvedBy: 'tech-lead',
    ttl: 100 // 100ms
  });
  assert('lock initially active', lock.isLocked('database'));

  // Backdate to force TTL expiry
  entry.lockedAt = new Date(Date.now() - 10 * 1000).toISOString();
  lock._save();

  // Trigger cleanExpired qua isLocked
  assert('expired after TTL (no featureId)', !lock.isLocked('database'));
  const history = lock.getHistory();
  const expired = history.find(d => d.id === entry.id);
  assert('unlocked with TTL reason', expired.unlockReason === 'auto: TTL expired', `got: ${expired.unlockReason}`);
}

// === Test 4: feature closed → lock active for 24h buffer, then expires ===
console.log('\n=== Test 4: closed feature + 24h buffer ===');
{
  const dir = mkTempProject();
  const { DecisionLock, FeatureRegistry } = fresh();
  const registry = new FeatureRegistry({ projectDir: dir });
  registry.registerFeature({ id: 'feat-4', name: 'old feature' });

  const lock = new DecisionLock({ projectDir: dir, featureRegistry: registry });
  const entry = lock.lock({
    decision: 'Redis cache',
    scope: 'cache',
    approvedBy: 'tech-lead',
    featureId: 'feat-4'
  });

  // Close feature — KHONG dung closeFeatureAndUnlock (ta muon test buffer behavior)
  registry.closeFeature('feat-4', { reason: 'merged', closedBy: 'ci' });

  // Closed 1h ago → still within 24h buffer → lock active
  const feat = registry.getFeature('feat-4');
  feat.closedAt = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  registry._save();
  assert('lock still active within buffer', lock.isLocked('cache'));

  // Closed 30h ago → past 24h buffer → expire
  feat.closedAt = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
  registry._save();
  assert('lock expired past buffer', !lock.isLocked('cache'));

  const history = lock.getHistory();
  const expired = history.find(d => d.id === entry.id);
  assert('unlock reason mentions feature closed',
    /feature closed/i.test(expired.unlockReason),
    `got: ${expired.unlockReason}`);
}

// === Test 5: feature registry persistence round-trip ===
console.log('\n=== Test 5: feature registry persist/reload ===');
{
  const dir = mkTempProject();
  const { FeatureRegistry } = fresh();
  const reg1 = new FeatureRegistry({ projectDir: dir });
  reg1.registerFeature({ id: 'f-a', name: 'alpha' });
  reg1.registerFeature({ id: 'f-b', name: 'beta' });
  reg1.closeFeature('f-b', { reason: 'shipped' });

  const reg2 = new FeatureRegistry({ projectDir: dir });
  assert('2 features persisted', reg2.listAll().length === 2);
  assert('f-a still open', reg2.isOpen('f-a') === true);
  assert('f-b closed', reg2.isOpen('f-b') === false);
  assert('listOpen returns only open', reg2.listOpen().length === 1);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
