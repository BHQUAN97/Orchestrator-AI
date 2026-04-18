#!/usr/bin/env node
/**
 * Session Continuity Test
 *
 * Chay: node test/session-continuity.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result
        .then(() => { passed++; console.log(`PASS ${name}`); })
        .catch(e => { failed++; failures.push({ name, error: e.message }); console.log(`FAIL ${name}: ${e.message}`); });
    }
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orcai-sess-'));
}

function mkGitRepo() {
  const dir = mkTmp();
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir, stdio: 'ignore' });
  } catch {
    // git khong co → test fallback (gitHead returns null)
  }
  return dir;
}

(async () => {
  console.log('=== SessionContinuity Test ===\n');

  const { SessionContinuity, gitHead, gitDivergence } = require('../lib/session-continuity');

  // --- Basic start + snapshot + load ---
  test('startSession → saveSnapshot → loadPreviousSession returns same state', () => {
    const dir = mkTmp();
    try {
      const sc = new SessionContinuity({ projectDir: dir });
      const id = sc.startSession({ prompt: 'Build login form' });
      assert(id, 'sessionId missing');

      sc.saveSnapshot({
        sessionId: id,
        state: {
          turn: 3,
          activeDecisions: [{ scope: 'auth', decision: 'use JWT' }],
          openTasks: ['write tests', 'add oauth'],
          inFlightFiles: [{ path: 'src/login.js', lastEditAt: Date.now() }],
          lastTraceId: 'trc-xyz',
          nextStep: 'run tests',
          errorsSeen: ['TypeError in login.js:42'],
          modelsUsed: ['sonnet-4', 'opus-4']
        }
      });

      const prev = sc.loadPreviousSession({ maxAgeHours: 48 });
      assert(prev, 'loadPreviousSession returned null');
      assert(prev.session.id === id);
      assert(prev.session.turn === 3);
      assert(prev.session.openTasks.length === 2);
      assert(prev.session.activeDecisions[0].decision === 'use JWT');
      assert(prev.session.inFlightFiles[0].path === 'src/login.js');
      assert(prev.session.nextStep === 'run tests');
      assert(prev.session.modelsUsed.includes('opus-4'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- isFresh true when git head matches ---
  test('isFresh=true when gitHead matches current HEAD', () => {
    const dir = mkGitRepo();
    try {
      const head = gitHead(dir);
      if (!head) {
        console.log('  (skip: git not available)');
        return;
      }
      const sc = new SessionContinuity({ projectDir: dir });
      const id = sc.startSession({ prompt: 'test' });
      sc.saveSnapshot({ sessionId: id, state: { turn: 1 } });

      const prev = sc.loadPreviousSession({ maxAgeHours: 48 });
      assert(prev, 'prev null');
      assert(prev.isFresh === true, `expected fresh, got ${prev.isFresh}`);
      assert(prev.gitDivergence.commitsAhead === 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- isFresh false after new commit ---
  test('isFresh=false + divergence after new commit', () => {
    const dir = mkGitRepo();
    try {
      const head0 = gitHead(dir);
      if (!head0) {
        console.log('  (skip: git not available)');
        return;
      }
      const sc = new SessionContinuity({ projectDir: dir });
      const id = sc.startSession({ prompt: 'test' });
      sc.saveSnapshot({ sessionId: id, state: { turn: 1 } });

      // Commit moi
      fs.writeFileSync(path.join(dir, 'b.txt'), 'world');
      execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-q', '-m', 'second'], { cwd: dir, stdio: 'ignore' });

      const prev = sc.loadPreviousSession({ maxAgeHours: 48 });
      assert(prev, 'prev null');
      assert(prev.isFresh === false, 'should not be fresh');
      assert(prev.gitDivergence.commitsAhead === 1, `ahead=${prev.gitDivergence.commitsAhead}`);
      assert(prev.gitDivergence.filesChanged.includes('b.txt'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- maxAgeHours filter ---
  test('maxAgeHours filter excludes old snapshots', () => {
    const dir = mkTmp();
    try {
      const sc = new SessionContinuity({ projectDir: dir });
      const id = sc.startSession({ prompt: 'old' });
      sc.saveSnapshot({ sessionId: id, state: { turn: 1 } });

      // Manually age the snapshot
      const file = path.join(dir, '.orcai', 'sessions', `${id}.json`);
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      data.startedAt = Date.now() - 72 * 3600 * 1000;
      data.updatedAt = Date.now() - 72 * 3600 * 1000;
      fs.writeFileSync(file, JSON.stringify(data));

      const prev = sc.loadPreviousSession({ maxAgeHours: 48 });
      assert(prev === null, 'old snapshot should be excluded');

      const prevWide = sc.loadPreviousSession({ maxAgeHours: 100 });
      assert(prevWide && prevWide.session.id === id);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Atomic write: simulate crash (leftover tmp) ---
  test('atomic write — torn tmp does not corrupt dest', () => {
    const dir = mkTmp();
    try {
      const sc = new SessionContinuity({ projectDir: dir });
      const id = sc.startSession({ prompt: 'atomic' });
      sc.saveSnapshot({ sessionId: id, state: { turn: 1, nextStep: 'keep' } });

      const destFile = path.join(dir, '.orcai', 'sessions', `${id}.json`);
      const beforeStat = fs.statSync(destFile);
      const beforeData = fs.readFileSync(destFile, 'utf-8');

      // Simulate a partial/crashed write — write tmp but never rename
      const tmp = destFile + '.tmp.crash';
      fs.writeFileSync(tmp, '{"broken": tr');
      // Dest must still be intact
      const afterData = fs.readFileSync(destFile, 'utf-8');
      assert(afterData === beforeData, 'dest changed despite tmp write');
      const parsed = JSON.parse(afterData);
      assert(parsed.nextStep === 'keep');

      // Cleanup crash tmp
      try { fs.unlinkSync(tmp); } catch {}

      // A new legit save still works
      sc.saveSnapshot({ sessionId: id, state: { turn: 2, nextStep: 'updated' } });
      const final = JSON.parse(fs.readFileSync(destFile, 'utf-8'));
      assert(final.turn === 2);
      assert(final.nextStep === 'updated');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- listRecentSessions ordering ---
  test('listRecentSessions returns sorted by startedAt desc', () => {
    const dir = mkTmp();
    try {
      const sc = new SessionContinuity({ projectDir: dir });
      const id1 = sc.startSession({ prompt: 'first' });
      // Manually backdate id1
      const f1 = path.join(dir, '.orcai', 'sessions', `${id1}.json`);
      const d1 = JSON.parse(fs.readFileSync(f1, 'utf-8'));
      d1.startedAt = Date.now() - 3600 * 1000;
      fs.writeFileSync(f1, JSON.stringify(d1));

      const id2 = sc.startSession({ prompt: 'second' });
      const id3 = sc.startSession({ prompt: 'third' });

      const list = sc.listRecentSessions({ limit: 10 });
      assert(list.length === 3, `got ${list.length}`);
      // Newest first — id3 or id2 first (both newer than id1)
      assert(list[list.length - 1].id === id1, 'oldest should be last');
      assert(list[0].prompt === 'third' || list[0].prompt === 'second');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- closeSession ---
  test('closeSession writes final + appends index', () => {
    const dir = mkTmp();
    try {
      const sc = new SessionContinuity({ projectDir: dir });
      const id = sc.startSession({ prompt: 'close test' });
      sc.closeSession(id, { status: 'completed', summary: 'done' });

      const file = path.join(dir, '.orcai', 'sessions', `${id}.json`);
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      assert(data.status === 'completed');
      assert(data.endedAt != null);
      assert(data.finalSummary === 'done');

      const indexPath = path.join(dir, '.orcai', 'sessions', 'index.jsonl');
      const lines = fs.readFileSync(indexPath, 'utf-8').split('\n').filter(Boolean);
      assert(lines.length >= 2, `expected start+close entries, got ${lines.length}`);
      const parsed = lines.map(l => JSON.parse(l));
      assert(parsed.some(e => e.event === 'close' && e.id === id));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- bridgeSummary with mock ---
  await test('bridgeSummary calls hermes.push at N-turn boundary', async () => {
    const dir = mkTmp();
    try {
      let pushed = null;
      const fakeBridge = { push: (payload) => { pushed = payload; return Promise.resolve(true); } };

      const sc = new SessionContinuity({ projectDir: dir, hermesBridge: fakeBridge });
      const id = sc.startSession({ prompt: 'bridge test' });

      // turn = 5 → should NOT fire (default everyTurns=10)
      sc.saveSnapshot({ sessionId: id, state: { turn: 5, openTasks: ['a'] } });
      let r = await sc.bridgeSummary({ sessionId: id });
      assert(r === null, 'should be null at turn=5');
      assert(pushed === null);

      // turn = 10 → fires
      sc.saveSnapshot({ sessionId: id, state: { turn: 10, nextStep: 'deploy' } });
      r = await sc.bridgeSummary({ sessionId: id });
      assert(r, 'expected truthy result');
      assert(pushed, 'push not called');
      assert(pushed.sessionId === id);
      assert(pushed.turn === 10);
      assert(pushed.nextStep === 'deploy');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('bridgeSummary returns null when bridge missing or throws', async () => {
    const dir = mkTmp();
    try {
      const sc1 = new SessionContinuity({ projectDir: dir });
      const id1 = sc1.startSession({ prompt: 'no bridge' });
      sc1.saveSnapshot({ sessionId: id1, state: { turn: 10 } });
      const r1 = await sc1.bridgeSummary({ sessionId: id1 });
      assert(r1 === null, 'should be null without bridge');

      const failBridge = { push: () => Promise.reject(new Error('boom')) };
      const sc2 = new SessionContinuity({ projectDir: dir, hermesBridge: failBridge });
      const id2 = sc2.startSession({ prompt: 'bad bridge' });
      sc2.saveSnapshot({ sessionId: id2, state: { turn: 10 } });
      const r2 = await sc2.bridgeSummary({ sessionId: id2 });
      assert(r2 === null, 'should be null on bridge failure');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- attachToConversation wrapper ---
  await test('attachToConversation wrapper auto-snapshots at interval', async () => {
    const dir = mkTmp();
    try {
      const sc = new SessionContinuity({ projectDir: dir });
      const id = sc.startSession({ prompt: 'wrapper' });
      const handle = sc.attachToConversation({}, {
        sessionId: id,
        snapshotEveryTurns: 2,
        bridgeEveryTurns: 100,
        collector: (p) => ({ nextStep: p.next })
      });

      await handle.onTurn({ next: 'step1' });
      await handle.onTurn({ next: 'step2' });
      await handle.onTurn({ next: 'step3' });

      const file = path.join(dir, '.orcai', 'sessions', `${id}.json`);
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      assert(data.turn === 3, `turn=${data.turn}`);
      // Snapshot on turn=2 wrote nextStep=step2
      assert(data.nextStep === 'step2' || data.nextStep === 'step3', `nextStep=${data.nextStep}`);

      handle.onEnd({ status: 'completed', summary: 'ok' });
      const closed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      assert(closed.status === 'completed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- gitHead / gitDivergence non-git dir ---
  test('gitHead returns null on non-git dir', () => {
    const dir = mkTmp();
    try {
      assert(gitHead(dir) === null);
      const d = gitDivergence('deadbeef', dir);
      assert(d.commitsAhead === 0);
      assert(d.commitsBehind === 0);
      assert(Array.isArray(d.filesChanged));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await new Promise(r => setTimeout(r, 50));

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  - ${f.name}: ${f.error}`));
    process.exit(1);
  }
})();
