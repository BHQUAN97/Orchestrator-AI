#!/usr/bin/env node
/**
 * Test AuditLog + DecisionLock audit integration
 * Chay: node test/audit-log.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;

function assert(name, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ FAIL: ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

function mkTmp(tag) {
  const dir = path.join(os.tmpdir(), `audit-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// === AuditLog core ===
console.log('=== AuditLog core ===\n');

const { AuditLog } = require('../router/audit-log');

// Test 1: Append + query round trip
console.log('Test 1: Append + query round trip');
const d1 = mkTmp('basic');
const log1 = new AuditLog({ projectDir: d1 });
const e1 = log1.append({ event: 'lock_created', actor: 'tech-lead', scope: 'api', decisionId: 'dec-1', details: { x: 1 } });
assert('Append returns entry with ISO timestamp', /^\d{4}-\d{2}-\d{2}T/.test(e1.timestamp));
assert('File created', fs.existsSync(path.join(d1, '.sdd', 'audit.log.jsonl')));

log1.append({ event: 'lock_validated_allowed', actor: 'fe-dev', scope: 'ui' });
log1.append({ event: 'lock_validated_blocked', actor: 'be-dev', scope: 'api', details: { blockingLockIds: ['dec-1'] } });

const all = log1.query({});
assert('Query returns 3 entries', all.length === 3, `got ${all.length}`);
assert('Query preserves order', all[0].event === 'lock_created' && all[2].event === 'lock_validated_blocked');

const blocked = log1.query({ event: 'lock_validated_blocked' });
assert('Filter by event', blocked.length === 1 && blocked[0].actor === 'be-dev');

const byActor = log1.query({ actor: 'fe-dev' });
assert('Filter by actor', byActor.length === 1 && byActor[0].scope === 'ui');

const byScope = log1.query({ scope: 'api' });
assert('Filter by scope', byScope.length === 2);

// Test 2: tail
console.log('\nTest 2: tail()');
const d2 = mkTmp('tail');
const log2 = new AuditLog({ projectDir: d2 });
for (let i = 0; i < 10; i++) {
  log2.append({ event: 'lock_created', actor: `a${i}`, scope: 's', decisionId: `dec-${i}` });
}
const last3 = log2.tail(3);
assert('Tail returns 3', last3.length === 3);
assert('Tail in chronological order (oldest → newest)', last3[0].actor === 'a7' && last3[2].actor === 'a9');
const last20 = log2.tail(20);
assert('Tail n > total returns all', last20.length === 10);

// Test 3: stats
console.log('\nTest 3: stats()');
const d3 = mkTmp('stats');
const log3 = new AuditLog({ projectDir: d3 });
log3.append({ event: 'lock_created', actor: 'x', scope: 's' });
log3.append({ event: 'lock_created', actor: 'x', scope: 's' });
log3.append({ event: 'lock_validated_blocked', actor: 'y', scope: 's' });
log3.append({ event: 'lock_unlocked', actor: 'x', scope: 's' });
const s = log3.stats();
assert('Total = 4', s.total === 4);
assert('lock_created count = 2', s.byEvent.lock_created === 2);
assert('lock_validated_blocked count = 1', s.byEvent.lock_validated_blocked === 1);
assert('lock_unlocked count = 1', s.byEvent.lock_unlocked === 1);

// Test 4: Time filter
console.log('\nTest 4: since/until filter');
const d4 = mkTmp('time');
const log4 = new AuditLog({ projectDir: d4 });
log4.append({ event: 'lock_created', actor: 'a', scope: 's', timestamp: '2025-01-01T00:00:00.000Z' });
log4.append({ event: 'lock_created', actor: 'b', scope: 's', timestamp: '2025-06-01T00:00:00.000Z' });
log4.append({ event: 'lock_created', actor: 'c', scope: 's', timestamp: '2025-12-01T00:00:00.000Z' });
const mid = log4.query({ since: '2025-03-01T00:00:00.000Z', until: '2025-09-01T00:00:00.000Z' });
assert('Time filter returns middle entry', mid.length === 1 && mid[0].actor === 'b');

// Test 5: Limit
console.log('\nTest 5: query limit');
const d5 = mkTmp('limit');
const log5 = new AuditLog({ projectDir: d5 });
for (let i = 0; i < 20; i++) log5.append({ event: 'lock_created', actor: `a${i}`, scope: 's' });
const limited = log5.query({ limit: 5 });
assert('Limit returns 5', limited.length === 5);
assert('Limit returns last 5 (newest tail)', limited[4].actor === 'a19');

// Test 6: Missing event throws
console.log('\nTest 6: Validation');
const d6 = mkTmp('valid');
const log6 = new AuditLog({ projectDir: d6 });
let threw = false;
try { log6.append({ actor: 'x' }); } catch { threw = true; }
assert('Missing event throws', threw);

// === DecisionLock integration ===
console.log('\n=== DecisionLock integration ===\n');

delete require.cache[require.resolve('../router/decision-lock')];
delete require.cache[require.resolve('../router/audit-log')];
const { DecisionLock } = require('../router/decision-lock');
const { AuditLog: AL2 } = require('../router/audit-log');

// Test 7: Lock flow emits events in order
console.log('Test 7: lock → validate blocked → unlock → validate allowed');
const dProj = mkTmp('flow');
const dl = new DecisionLock({ projectDir: dProj });

const locked = dl.lock({ decision: 'REST only, no GraphQL', scope: 'api', approvedBy: 'tech-lead', reason: 'consistency' });
const v1 = dl.validate('api', 'fe-dev');
assert('fe-dev blocked', v1.allowed === false);
dl.unlock(locked.id, { reason: 'requirement changed', unlockedBy: 'tech-lead' });
const v2 = dl.validate('api', 'fe-dev');
assert('fe-dev allowed after unlock', v2.allowed === true);

// Read the audit log and verify event order
const auditQ = new AL2({ projectDir: dProj });
const events = auditQ.query({});
const eventOrder = events.map(e => e.event);
console.log(`  event order: ${eventOrder.join(' → ')}`);
assert('4 events recorded', events.length === 4, `got ${events.length}`);
assert('1st = lock_created', events[0].event === 'lock_created');
assert('2nd = lock_validated_blocked', events[1].event === 'lock_validated_blocked');
assert('3rd = lock_unlocked', events[2].event === 'lock_unlocked');
assert('4th = lock_validated_allowed', events[3].event === 'lock_validated_allowed');

// Verify blocked event shape
const blockedEv = events[1];
assert('blocked: actor = fe-dev', blockedEv.actor === 'fe-dev');
assert('blocked: scope = api', blockedEv.scope === 'api');
assert('blocked: blockingLockIds includes lock id', Array.isArray(blockedEv.details.blockingLockIds) && blockedEv.details.blockingLockIds[0] === locked.id);

// Test 8: Tech-lead override emits warning
console.log('\nTest 8: Tech-lead override emits warning');
const dProj2 = mkTmp('override');
const dl2 = new DecisionLock({ projectDir: dProj2 });
dl2.lock({ decision: 'X', scope: 'db', approvedBy: 'tech-lead' });
dl2.validate('db', 'tech-lead');
const auditQ2 = new AL2({ projectDir: dProj2 });
const warnEvents = auditQ2.query({ event: 'lock_override_warning' });
assert('lock_override_warning emitted for tech-lead', warnEvents.length === 1);
const allowedEvents = auditQ2.query({ event: 'lock_validated_allowed' });
assert('lock_validated_allowed also emitted', allowedEvents.length === 1);
assert('allowed event reason = tech_lead_override', allowedEvents[0].details.reason === 'tech_lead_override');

// Test 9: Expired lock emits lock_expired
console.log('\nTest 9: TTL expiry emits lock_expired');
const dProj3 = mkTmp('expire');
const dl3 = new DecisionLock({ projectDir: dProj3 });
dl3.lock({ decision: 'temp', scope: 'tmp', approvedBy: 't', ttl: 30 });
const wait = Date.now() + 80;
while (Date.now() < wait) { /* busy wait */ }
dl3.validate('tmp', 'fe-dev'); // trigger expiry scan
const auditQ3 = new AL2({ projectDir: dProj3 });
const expiredEvents = auditQ3.query({ event: 'lock_expired' });
assert('lock_expired emitted when TTL passes', expiredEvents.length === 1);
assert('lock_expired actor = system', expiredEvents[0].actor === 'system');

// Test 10: Inject shared AuditLog instance
console.log('\nTest 10: Inject shared AuditLog');
const dProj4 = mkTmp('shared');
const sharedAudit = new AL2({ projectDir: dProj4 });
const dl4 = new DecisionLock({ projectDir: dProj4, auditLog: sharedAudit });
dl4.lock({ decision: 'Y', scope: 'auth', approvedBy: 'tech-lead' });
assert('Shared audit logs event', sharedAudit.query({}).length === 1);
assert('DecisionLock._auditLog === injected instance', dl4._auditLog === sharedAudit);

// Test 11: Audit failure does not break DecisionLock
console.log('\nTest 11: Audit resilience');
const dProj5 = mkTmp('resilient');
// Inject a broken audit log
const brokenAudit = { append: () => { throw new Error('disk full'); } };
const dl5 = new DecisionLock({ projectDir: dProj5, auditLog: brokenAudit });
let lockThrew = false;
try { dl5.lock({ decision: 'Z', scope: 's', approvedBy: 't' }); }
catch (e) { lockThrew = true; }
assert('Lock still works when audit throws', !lockThrew);
assert('Decision persisted despite audit failure', dl5.isLocked('s'));

// === Example JSONL line ===
console.log('\n=== Sample lock_validated_blocked line ===\n');
const sample = events.find(e => e.event === 'lock_validated_blocked');
console.log(JSON.stringify(sample));

// === Cleanup ===
for (const d of [d1, d2, d3, d4, d5, d6, dProj, dProj2, dProj3, dProj4, dProj5]) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

// === Summary ===
console.log('\n' + '='.repeat(50));
console.log(`AUDIT LOG TESTS: ${passed + failed} total — ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));
process.exit(failed === 0 ? 0 : 1);
