#!/usr/bin/env node
/**
 * Test cho cac hardening fix (commit 3d6ee9d, 115cd6e):
 *  - DecisionLock: TTL configurable qua env, auto-expire, validate logic
 *  - Auth gateway: production startup guard (process spawn test)
 *  - Rate limit: LRU evict khi vuot cap (qua API smoke neu co)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let passed = 0;
let failed = 0;

function assert(name, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ FAIL: ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

// === DecisionLock TTL configurable ===
console.log('=== DecisionLock TTL ===\n');

// Tao test dir tam — tranh chung file lock production
const testDir = path.join(require('os').tmpdir(), `dl-test-${Date.now()}`);
fs.mkdirSync(testDir, { recursive: true });

// Test 1: Default TTL = 4h khi khong set env
console.log('Test 1: Default TTL');
delete process.env.DECISION_LOCK_TTL_HOURS;
delete require.cache[require.resolve('../router/decision-lock')];
const { DecisionLock: DL1 } = require('../router/decision-lock');
const dl1 = new DL1({ projectDir: testDir });
const e1 = dl1.lock({ decision: 'test', scope: 'api', approvedBy: 't' });
assert('Default TTL = 4h (14400000ms)', e1.ttl === 4 * 60 * 60 * 1000, `got ${e1.ttl}`);

// Test 2: TTL configurable qua env
console.log('\nTest 2: Env override');
process.env.DECISION_LOCK_TTL_HOURS = '2';
delete require.cache[require.resolve('../router/decision-lock')];
const { DecisionLock: DL2 } = require('../router/decision-lock');
const dl2 = new DL2({ projectDir: path.join(testDir, '2h') });
const e2 = dl2.lock({ decision: 'x', scope: 'db', approvedBy: 't' });
assert('TTL = 2h khi env set 2', e2.ttl === 2 * 60 * 60 * 1000, `got ${e2.ttl}`);

// Test 3: Fractional TTL (0.5h = 30 min)
console.log('\nTest 3: Fractional hours');
process.env.DECISION_LOCK_TTL_HOURS = '0.5';
delete require.cache[require.resolve('../router/decision-lock')];
const { DecisionLock: DL3 } = require('../router/decision-lock');
const dl3 = new DL3({ projectDir: path.join(testDir, '30min') });
const e3 = dl3.lock({ decision: 'y', scope: 'auth', approvedBy: 't' });
assert('TTL = 30min', e3.ttl === 30 * 60 * 1000, `got ${e3.ttl}`);

// Test 4: Invalid env → fallback default 4h
console.log('\nTest 4: Invalid env fallback');
process.env.DECISION_LOCK_TTL_HOURS = 'not-a-number';
delete require.cache[require.resolve('../router/decision-lock')];
const { DecisionLock: DL4 } = require('../router/decision-lock');
const dl4 = new DL4({ projectDir: path.join(testDir, 'invalid') });
const e4 = dl4.lock({ decision: 'z', scope: 'ui', approvedBy: 't' });
assert('Invalid env → default 4h', e4.ttl === 4 * 60 * 60 * 1000, `got ${e4.ttl}`);

// Test 5: Auto-expire khi qua TTL
console.log('\nTest 5: Auto-expire');
delete process.env.DECISION_LOCK_TTL_HOURS;
delete require.cache[require.resolve('../router/decision-lock')];
const { DecisionLock: DL5 } = require('../router/decision-lock');
const dl5 = new DL5({ projectDir: path.join(testDir, 'expire') });
// Lock voi TTL 50ms — qua nhanh, du de test
const eShort = dl5.lock({ decision: 'temp', scope: 'temp', approvedBy: 't', ttl: 50 });
assert('Lock active ngay sau khi tao', dl5.isLocked('temp'));
// Cho 100ms cho lock expire
const wait = Date.now() + 100;
while (Date.now() < wait) { /* busy wait — du nhanh trong test */ }
const stillLocked = dl5.isLocked('temp');
assert('Auto-unlocked sau TTL', !stillLocked);

// Test 6: validate() block khi locked
console.log('\nTest 6: validate() blocking');
const dl6 = new DL5({ projectDir: path.join(testDir, 'validate') });
dl6.lock({ decision: 'REST API', scope: 'api', approvedBy: 'tech-lead' });
const v1 = dl6.validate('api', 'fe-dev');
assert('Block fe-dev khi scope locked', !v1.allowed && Array.isArray(v1.blockedBy));
const v2 = dl6.validate('api', 'tech-lead');
assert('Tech-lead duoc warning chu khong block', v2.allowed === true && !!v2.warning);
const v3 = dl6.validate('unrelated-scope', 'fe-dev');
assert('Scope khac → allow', v3.allowed === true);

// === Auth gateway production guard ===
console.log('\n=== Auth Production Guard ===\n');

const authPath = path.join(__dirname, '..', 'gateway', 'auth-server.js');

// Test 7: Production + default creds → exit(1)
console.log('Test 7: Prod guard refuses defaults');
const r1 = spawnSync(process.execPath, [authPath], {
  env: { ...process.env, NODE_ENV: 'production', AUTH_USERNAME: 'admin', AUTH_PASSWORD: 'admin', JWT_SECRET: 'orcai-dev-secret-change-me' },
  encoding: 'utf8',
  timeout: 3000
});
assert('Exit code = 1 khi production + defaults', r1.status === 1, `got ${r1.status}`);
assert('Stderr nhac AUTH_PASSWORD', /AUTH_PASSWORD/i.test(r1.stderr || ''), r1.stderr?.slice(0, 100));

// Test 8: Production + secrets safe → server start (timeout 1s, kill)
console.log('\nTest 8: Prod guard accepts safe secrets');
const r2 = spawnSync(process.execPath, [authPath], {
  env: { ...process.env, NODE_ENV: 'production', AUTH_USERNAME: 'realuser', AUTH_PASSWORD: 'realpassword-32chars-or-more-here', JWT_SECRET: 'real-jwt-secret-min-32-chars-here-x' },
  encoding: 'utf8',
  timeout: 1500
});
// Server start xong se in "Listening on :3100", spawnSync se timeout (kill) → status null
const stdoutOk = /Listening on :3100/.test(r2.stdout || '');
const exitNotPrematurely = r2.status !== 1;
assert('Server start binh thuong khi secrets safe', stdoutOk && exitNotPrematurely, `status=${r2.status} stdout="${(r2.stdout || '').slice(0, 80)}"`);

// === Cleanup ===
try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }

// === Summary ===
console.log('\n' + '='.repeat(50));
console.log(`HARDENING TESTS: ${passed + failed} total — ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));
process.exit(failed === 0 ? 0 : 1);
