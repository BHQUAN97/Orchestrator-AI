#!/usr/bin/env node
/**
 * Shadow Git API handlers — wrap ShadowGit methods thanh { ok, data } / { ok, error }
 * Khong tao HTTP route o day. Parent (api-server) se wire.
 */
const { ShadowGit } = require('../tools/shadow-git');

// Cache instances theo projectDir de tranh tao lai + giu session state
const _instances = new Map();

function _getShadow(projectDir) {
  if (!projectDir) throw new Error('projectDir required');
  if (!_instances.has(projectDir)) {
    _instances.set(projectDir, new ShadowGit(projectDir));
  }
  return _instances.get(projectDir);
}

function _ok(data) { return { ok: true, data }; }
function _err(error) { return { ok: false, error: String(error && error.message || error) }; }

/**
 * List snapshots
 * @param {Object} query - { projectDir, limit, since }
 */
async function listSnapshots(query = {}) {
  try {
    const shadow = _getShadow(query.projectDir);
    const data = shadow.listSnapshots({
      limit: query.limit,
      since: query.since
    });
    return _ok(data);
  } catch (err) {
    return _err(err);
  }
}

/**
 * Get diff of snapshot vs current / other snapshot
 * @param {string} id
 * @param {Object} query - { projectDir, against }
 */
async function getSnapshotDiff(id, query = {}) {
  try {
    const shadow = _getShadow(query.projectDir);
    const data = shadow.diffSnapshot(id, { against: query.against || 'current' });
    return _ok(data);
  } catch (err) {
    return _err(err);
  }
}

/**
 * Rollback to snapshot
 * @param {string} id
 * @param {Object} opts - { projectDir, dryRun, files }
 */
async function rollback(id, opts = {}) {
  try {
    const shadow = _getShadow(opts.projectDir);
    const result = shadow.rollbackTo(id, {
      dryRun: Boolean(opts.dryRun),
      files: Array.isArray(opts.files) ? opts.files : null
    });
    if (!result.success) return _err(result.message);
    return _ok(result);
  } catch (err) {
    return _err(err);
  }
}

/**
 * Label snapshot
 * @param {string} id
 * @param {string} label
 * @param {Object} opts - { projectDir }
 */
async function labelSnapshot(id, label, opts = {}) {
  try {
    const shadow = _getShadow(opts.projectDir);
    const result = shadow.labelSnapshot(id, label);
    if (!result.success) return _err(result.message);
    return _ok(result);
  } catch (err) {
    return _err(err);
  }
}

/**
 * Prune old snapshots — giu lai keepCount snapshot moi nhat
 * @param {number} keepCount
 * @param {Object} opts - { projectDir }
 */
async function pruneSnapshots(keepCount = 20, opts = {}) {
  try {
    const shadow = _getShadow(opts.projectDir);
    if (!shadow.enabled) return _err('shadow-git not enabled');

    // Lay tat ca stash refs cua shadow
    const list = shadow.listSnapshots({ limit: 1000 });
    const toDrop = list.slice(keepCount);
    let dropped = 0;
    const errors = [];

    // Drop tu cuoi len dau de tranh shift index
    for (const snap of toDrop.reverse()) {
      try {
        // Tim stash ref tuong ung
        const { execSync } = require('child_process');
        const raw = execSync('git stash list --format="%gd|%H"', {
          cwd: shadow.projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        const match = raw.split('\n').find(l => l.endsWith('|' + snap.id));
        if (!match) continue;
        const ref = match.split('|')[0];
        if (!/^stash@\{\d+\}$/.test(ref)) continue;
        execSync(`git stash drop ${ref}`, {
          cwd: shadow.projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']
        });
        dropped++;
      } catch (e) {
        errors.push(String(e.message));
        break; // Stash index shifted, dung
      }
    }

    return _ok({ dropped, kept: Math.min(keepCount, list.length), errors });
  } catch (err) {
    return _err(err);
  }
}

module.exports = {
  listSnapshots,
  getSnapshotDiff,
  rollback,
  labelSnapshot,
  pruneSnapshots
};
