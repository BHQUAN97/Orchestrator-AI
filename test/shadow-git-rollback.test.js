#!/usr/bin/env node
/**
 * Test shadow-git rollback + diff + maybeAutoSnapshot
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const { ShadowGit, maybeAutoSnapshot } = require('../tools/shadow-git');

let passed = 0;
let failed = 0;

function assert(name, cond, detail = '') {
  if (cond) { console.log(`  OK  ${name}`); passed++; }
  else { console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

function run(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

// Setup: tao git repo tam de test
function setupRepo() {
  const dir = path.join(os.tmpdir(), `shadow-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  run('git init', dir);
  run('git config user.email test@test.com', dir);
  run('git config user.name test', dir);
  run('git config commit.gpgsign false', dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'original content\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'file b original\n');
  run('git add -A', dir);
  run('git commit -m init', dir);
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

(async () => {
  console.log('=== Shadow Git Rollback Tests ===\n');

  // === Test 1: snapshot → modify → rollback → verify restored ===
  console.log('Test 1: snapshot -> modify -> rollback');
  {
    const dir = setupRepo();
    try {
      // Sua file de co working change
      fs.writeFileSync(path.join(dir, 'a.txt'), 'modified once\n');

      const shadow = new ShadowGit(dir);
      const hash = await shadow.ensureSnapshot('test-snap');
      assert('ensureSnapshot returns hash', hash && /^[0-9a-f]{40}$/.test(hash));

      // Sua them sau snapshot
      fs.writeFileSync(path.join(dir, 'a.txt'), 'modified TWICE after snap\n');
      assert('file has post-snapshot content',
        fs.readFileSync(path.join(dir, 'a.txt'), 'utf-8').includes('TWICE'));

      // Rollback
      const res = shadow.rollbackTo(hash);
      assert('rollback success', res.success, res.message);
      // Sau rollback, content phai la "modified once" (stash state)
      const after = fs.readFileSync(path.join(dir, 'a.txt'), 'utf-8');
      assert('file restored to snapshot state', after.includes('modified once'), `got: ${after}`);
    } finally {
      cleanup(dir);
    }
  }

  // === Test 2: diffSnapshot structured output ===
  console.log('\nTest 2: diffSnapshot structured output');
  {
    const dir = setupRepo();
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'snapshot version\n');
      const shadow = new ShadowGit(dir);
      const hash = await shadow.ensureSnapshot('diff-test');
      assert('snapshot created', Boolean(hash));

      // Thay doi file khac hoan toan
      fs.writeFileSync(path.join(dir, 'a.txt'), 'current version very different\n');

      const diff = shadow.diffSnapshot(hash, { against: 'current' });
      assert('diff is array', Array.isArray(diff));
      assert('diff has at least 1 entry', diff.length >= 1);
      const entry = diff.find(d => d.path === 'a.txt');
      assert('diff entry has path', entry && entry.path === 'a.txt');
      assert('diff entry has status', entry && ['added', 'modified', 'deleted'].includes(entry.status));
      assert('diff entry has hunks array', entry && Array.isArray(entry.hunks));
      assert('hunks non-empty', entry && entry.hunks.length >= 1);
    } finally {
      cleanup(dir);
    }
  }

  // === Test 3: dryRun does not modify ===
  console.log('\nTest 3: dryRun does not modify');
  {
    const dir = setupRepo();
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'snap state\n');
      const shadow = new ShadowGit(dir);
      const hash = await shadow.ensureSnapshot('dry-test');

      fs.writeFileSync(path.join(dir, 'a.txt'), 'current state kept\n');
      const beforeDry = fs.readFileSync(path.join(dir, 'a.txt'), 'utf-8');

      const plan = shadow.rollbackTo(hash, { dryRun: true });
      assert('dryRun returns success', plan.success);
      assert('dryRun flag set', plan.dryRun === true);
      assert('plannedChanges array', Array.isArray(plan.plannedChanges));

      const afterDry = fs.readFileSync(path.join(dir, 'a.txt'), 'utf-8');
      assert('file unchanged after dryRun', beforeDry === afterDry);
    } finally {
      cleanup(dir);
    }
  }

  // === Test 4: listSnapshots + labelSnapshot ===
  console.log('\nTest 4: listSnapshots + labelSnapshot');
  {
    const dir = setupRepo();
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
      const shadow = new ShadowGit(dir);
      const hash = await shadow.ensureSnapshot('list-test');

      const list = shadow.listSnapshots({ limit: 10 });
      assert('listSnapshots returns array', Array.isArray(list));
      assert('list contains our snapshot', list.some(s => s.id === hash));

      const labelRes = shadow.labelSnapshot(hash, 'my-test-label');
      assert('labelSnapshot success', labelRes.success);

      const list2 = shadow.listSnapshots({ limit: 10 });
      const found = list2.find(s => s.id === hash);
      assert('label persisted', found && found.label === 'my-test-label');
    } finally {
      cleanup(dir);
    }
  }

  // === Test 5: maybeAutoSnapshot triggers for risky op ===
  console.log('\nTest 5: maybeAutoSnapshot — risky op triggers');
  {
    const dir = setupRepo();
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'dirty state\n');
      const shadow = new ShadowGit(dir);

      const result = await maybeAutoSnapshot(
        { type: 'bash', command: 'rm -rf some/dir', summary: 'remove dir' },
        { shadowGit: shadow }
      );
      assert('risky op snapshotted', result.snapshotted === true, JSON.stringify(result));
      assert('triggeredBy has auto prefix', result.opType === 'destructive-bash');
      assert('label set', result.label && result.label.startsWith('before:'));
    } finally {
      cleanup(dir);
    }
  }

  // === Test 6: maybeAutoSnapshot skips for safe op ===
  console.log('\nTest 6: maybeAutoSnapshot — safe op skipped');
  {
    const dir = setupRepo();
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'dirty\n');
      const shadow = new ShadowGit(dir);

      const result = await maybeAutoSnapshot(
        { type: 'bash', command: 'ls -la', summary: 'list files' },
        { shadowGit: shadow }
      );
      assert('safe op skipped', result.snapshotted === false);
      assert('reason explains skip', result.reason === 'op not risky');
    } finally {
      cleanup(dir);
    }
  }

  // === Test 7: maybeAutoSnapshot dedupe within 10s ===
  console.log('\nTest 7: maybeAutoSnapshot — dedupe');
  {
    const dir = setupRepo();
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'dirty\n');
      const shadow = new ShadowGit(dir);

      const op = { type: 'bash', command: 'git reset --hard HEAD~1', summary: 'reset' };
      const r1 = await maybeAutoSnapshot(op, { shadowGit: shadow });
      const r2 = await maybeAutoSnapshot(op, { shadowGit: shadow });

      assert('first call snapshotted', r1.snapshotted === true);
      assert('second call deduped', r2.snapshotted === false && r2.reason === 'deduped');
    } finally {
      cleanup(dir);
    }
  }

  // === Summary ===
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Test crashed:', err);
  process.exit(1);
});
