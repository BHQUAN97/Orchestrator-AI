#!/usr/bin/env node
/**
 * Shadow Git — Auto-snapshot truoc khi AI ghi file
 *
 * Van de: AI ghi file qua file-manager.js → co the pha code.
 * Dev muon undo → khong co cach nao tro lai trang thai truoc.
 *
 * Giai phap: Truoc khi AI ghi file lan dau trong 1 session:
 *   1. git stash create → tao stash commit (KHONG thay doi working dir)
 *   2. git stash store → luu ref de khong bi GC
 *   3. Ghi log snapshot hash
 *   4. Dev co the rollback: git stash apply <hash>
 *
 * Cach dung:
 *   const shadow = new ShadowGit(projectDir);
 *   await shadow.ensureSnapshot('pre-ai-write');  // Chi tao 1 lan/session
 *   // ... AI ghi file ...
 *   shadow.getSnapshots();  // Xem lich su
 *   shadow.rollback(hash);  // Rollback neu can
 *
 * Design decisions:
 *   - Dung git stash create (khong phai git commit) → khong lam ban git log
 *   - Chi snapshot 1 lan/session → khong tao hang tram stash moi lan write
 *   - Silent fail → neu git khong co hoac loi, van cho AI ghi file
 *   - Ghi log ra file de dev co the xem lai
 */

const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Auto-snapshot dedupe cache (op hash → timestamp)
const _autoSnapshotCache = new Map();
const AUTO_SNAPSHOT_DEDUPE_MS = 10_000;

// Regex nhan dien risky ops
const RISKY_BASH_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /\bgit\s+push\s+.*-f\b/i,
  /\bgit\s+clean\s+-f/i,
  /\bgit\s+checkout\s+\./i,
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+DATABASE\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b.*(?!WHERE)/i,
];

class ShadowGit {
  constructor(projectDir, options = {}) {
    this.projectDir = projectDir;
    this.logFile = options.logFile || path.join(projectDir, '.sdd', 'shadow-git.log');
    this.labelsFile = options.labelsFile || path.join(projectDir, '.sdd', 'shadow-git-labels.json');
    this.maxSnapshots = options.maxSnapshots || 50;  // Giu toi da 50 snapshots trong log

    // Session state
    this.sessionSnapshot = null;  // Hash cua snapshot hien tai (1 lan/session)
    this.snapshots = [];          // Lich su trong session
    this.isGitRepo = this._checkGitRepo();
    this.enabled = this.isGitRepo && (options.enabled !== false);
  }

  /**
   * Dam bao co snapshot truoc khi AI ghi file
   * Chi tao 1 lan/session — goi nhieu lan van chi tao 1 snapshot
   *
   * @param {string} reason - Ly do tao snapshot (vd: 'pre-ai-write', 'pre-execute')
   * @returns {string|null} - Hash cua snapshot, hoac null neu khong can/khong the
   */
  async ensureSnapshot(reason = 'pre-ai-change', meta = {}) {
    // Da co snapshot trong session nay → skip
    if (this.sessionSnapshot) {
      return this.sessionSnapshot;
    }

    if (!this.enabled) return null;

    try {
      // Check xem co gi de snapshot khong
      const status = this._exec('git status --porcelain');
      if (!status.trim()) {
        // Working directory sach → khong can snapshot
        return null;
      }

      // Tao stash commit (KHONG thay doi working directory)
      // git stash create: tao commit object nhung KHONG luu vao stash list
      const hash = this._exec('git stash create').trim();

      if (!hash) {
        // Khong tao duoc stash (rare edge case)
        return null;
      }

      // Validate hash — phai la hex SHA, chan shell injection
      if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
        console.warn(`⚠️ Invalid stash hash: ${hash.slice(0, 20)}`);
        return null;
      }

      // Luu ref de khong bi garbage collected
      // Sanitize reason — strip ky tu nguy hiem cho shell
      const safeReason = reason.replace(/[^a-zA-Z0-9 _\-\.]/g, '').slice(0, 50);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const message = `shadow/${timestamp}: ${safeReason}`;
      this._exec(`git stash store -m "${message}" ${hash}`);

      // Ghi nhan
      this.sessionSnapshot = hash;
      const snapshot = {
        hash,
        reason,
        message,
        timestamp: new Date().toISOString(),
        changedFiles: this._getChangedFileCount(status),
        triggeredBy: meta.triggeredBy || 'manual',
        label: meta.label || null
      };
      this.snapshots.push(snapshot);

      // Luu label neu co
      if (meta.label) {
        this._saveLabel(hash, meta.label);
      }

      // Ghi log ra file
      this._appendLog(snapshot);

      console.log(`📸 Shadow snapshot: ${hash.slice(0, 8)} (${snapshot.changedFiles} files changed)`);
      return hash;
    } catch (err) {
      // Silent fail — khong block AI ghi file
      console.warn(`⚠️ Shadow snapshot failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Force tao snapshot moi (bo qua session lock)
   * Dung khi can checkpoint giua session (vd: truoc execute phase)
   */
  async forceSnapshot(reason = 'checkpoint') {
    if (!this.enabled) return null;

    // Reset session lock de tao snapshot moi
    const oldSnapshot = this.sessionSnapshot;
    this.sessionSnapshot = null;

    const hash = await this.ensureSnapshot(reason);

    // Neu fail, restore session lock cu
    if (!hash && oldSnapshot) {
      this.sessionSnapshot = oldSnapshot;
    }

    return hash;
  }

  /**
   * Rollback ve snapshot cu
   * Chu y: se ghi de working directory changes!
   *
   * @param {string} hash - Hash cua snapshot can rollback
   * @returns {Object} - { success, message }
   */
  rollback(hash) {
    if (!this.enabled) {
      return { success: false, message: 'Shadow Git not enabled (not a git repo)' };
    }

    if (!hash) {
      // Rollback ve snapshot gan nhat
      hash = this.sessionSnapshot || this.snapshots[this.snapshots.length - 1]?.hash;
    }

    if (!hash) {
      return { success: false, message: 'No snapshot to rollback to' };
    }

    // Validate hash — chan shell injection
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
      return { success: false, message: 'Invalid snapshot hash format' };
    }

    try {
      // Verify hash exists
      this._exec(`git cat-file -t ${hash}`);

      // Apply stash (khong xoa khoi stash list)
      this._exec(`git stash apply ${hash}`);

      this._appendLog({
        action: 'rollback',
        hash,
        timestamp: new Date().toISOString()
      });

      return { success: true, message: `Rolled back to ${hash.slice(0, 8)}` };
    } catch (err) {
      return { success: false, message: `Rollback failed: ${err.message}` };
    }
  }

  /**
   * Lay danh sach snapshots trong session
   */
  getSnapshots() {
    return [...this.snapshots];
  }

  /**
   * Lay snapshot history tu log file
   */
  getHistory(limit = 20) {
    try {
      if (!fs.existsSync(this.logFile)) return [];
      const content = fs.readFileSync(this.logFile, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      return lines.slice(-limit).map(line => {
        try { return JSON.parse(line); }
        catch { return { raw: line }; }
      });
    } catch {
      return [];
    }
  }

  /**
   * Don dep stash list — xoa snapshots cu hon N ngay
   */
  cleanup(maxAgeDays = 7) {
    if (!this.enabled) return { cleaned: 0 };

    try {
      // List all stashes
      const stashList = this._exec('git stash list --format=%gd:%s').trim();
      if (!stashList) return { cleaned: 0 };

      let cleaned = 0;
      const lines = stashList.split('\n');

      for (const line of lines) {
        // Chi xoa shadow stashes (co prefix "shadow/")
        if (!line.includes('shadow/')) continue;

        // Parse timestamp tu message
        const match = line.match(/shadow\/(\d{4}-\d{2}-\d{2})/);
        if (!match) continue;

        const stashDate = new Date(match[1]);
        const ageDays = (Date.now() - stashDate.getTime()) / (24 * 60 * 60 * 1000);

        if (ageDays > maxAgeDays) {
          const stashRef = line.split(':')[0]; // stash@{N}
          // Validate stash ref format — chan shell injection
          if (!/^stash@\{\d+\}$/.test(stashRef)) continue;
          try {
            this._exec(`git stash drop ${stashRef}`);
            cleaned++;
          } catch {
            // Stash index may have shifted, stop to avoid dropping wrong ones
            break;
          }
        }
      }

      return { cleaned };
    } catch {
      return { cleaned: 0 };
    }
  }

  /**
   * Liet ke snapshots tu git stash list (bao gom ca ngoai session)
   * @param {Object} opts - { limit, since }
   * @returns {Array<{id, createdAt, label, triggeredBy, filesChanged}>}
   */
  listSnapshots({ limit = 50, since } = {}) {
    if (!this.enabled) return [];

    try {
      // Format: hash|reflog-subject — quote format de tranh shell parsing ('|' tren Windows)
      const raw = this._exec('git stash list --format="%H|%gs"').trim();
      if (!raw) return [];

      const labels = this._loadLabels();
      const sinceMs = since ? new Date(since).getTime() : 0;
      const out = [];

      for (const line of raw.split('\n')) {
        const [hash, message = ''] = line.split('|');
        if (!hash || !/^[0-9a-f]{7,40}$/i.test(hash)) continue;
        if (!message.includes('shadow/')) continue;

        // Parse timestamp tu message shadow/YYYY-MM-DDTHH-MM-SS-sssZ: reason
        const tsMatch = message.match(/shadow\/([\dT\-Z]+):\s*(.+)/);
        const createdAt = tsMatch
          ? tsMatch[1].replace(/(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)/, '$1:$2:$3.$4')
          : null;
        const reason = tsMatch ? tsMatch[2].trim() : message;

        if (sinceMs && createdAt && new Date(createdAt).getTime() < sinceMs) continue;

        // Count file changed trong snapshot commit
        let filesChanged = 0;
        try {
          const diff = this._exec(`git stash show --name-only ${hash}`).trim();
          filesChanged = diff ? diff.split('\n').filter(Boolean).length : 0;
        } catch { /* ignore */ }

        // Tim triggeredBy tu session snapshots
        const sessionMatch = this.snapshots.find(s => s.hash === hash);

        out.push({
          id: hash,
          createdAt,
          label: labels[hash] || sessionMatch?.label || null,
          triggeredBy: sessionMatch?.triggeredBy || (reason.startsWith('auto:') ? reason : 'manual'),
          filesChanged,
          reason
        });

        if (out.length >= limit) break;
      }

      return out;
    } catch {
      return [];
    }
  }

  /**
   * Rollback ve snapshot — ho tro dryRun va partial files
   * @param {string} snapshotId
   * @param {Object} opts - { dryRun, files }
   * @returns {Object} - { success, message, plannedChanges? }
   */
  rollbackTo(snapshotId, { dryRun = false, files = null } = {}) {
    if (!this.enabled) {
      return { success: false, message: 'Shadow Git not enabled' };
    }
    if (!snapshotId || !/^[0-9a-f]{7,40}$/i.test(snapshotId)) {
      return { success: false, message: 'Invalid snapshot id' };
    }

    try {
      this._exec(`git cat-file -t ${snapshotId}`);

      // Build planned changes list bang diff
      const diffRaw = this._exec(`git diff --name-status ${snapshotId}`).trim();
      const allChanges = diffRaw
        ? diffRaw.split('\n').map(line => {
            const [status, ...rest] = line.split(/\s+/);
            return { path: rest.join(' '), status: this._mapGitStatus(status) };
          })
        : [];

      // Filter theo files allowlist neu co
      const plannedChanges = files
        ? allChanges.filter(c => files.includes(c.path))
        : allChanges;

      if (dryRun) {
        return {
          success: true,
          dryRun: true,
          snapshotId,
          plannedChanges,
          message: `Would restore ${plannedChanges.length} file(s)`
        };
      }

      // Apply: dung git checkout de ghi de working dir (tranh conflict cua stash apply)
      const targets = files && files.length > 0
        ? files.filter(f => !/["`$\\]/.test(f))
        : plannedChanges.map(c => c.path).filter(f => !/["`$\\]/.test(f));

      for (const f of targets) {
        try {
          this._exec(`git checkout ${snapshotId} -- "${f}"`);
        } catch {
          // File co the la 'deleted' trong snapshot → xoa tu working dir
          const full = path.join(this.projectDir, f);
          try { if (fs.existsSync(full)) fs.unlinkSync(full); } catch { /* ignore */ }
        }
      }

      this._appendLog({
        action: 'rollback',
        snapshotId,
        files: files || 'all',
        timestamp: new Date().toISOString()
      });

      return {
        success: true,
        snapshotId,
        restoredFiles: plannedChanges.map(c => c.path),
        message: `Rolled back ${plannedChanges.length} file(s) to ${snapshotId.slice(0, 8)}`
      };
    } catch (err) {
      return { success: false, message: `Rollback failed: ${err.message}` };
    }
  }

  /**
   * Diff structured giua snapshot va current (hoac snapshot khac)
   * @param {string} snapshotId
   * @param {Object} opts - { against: 'current' | otherSnapshotId }
   * @returns {Array<{path, status, hunks}>}
   */
  diffSnapshot(snapshotId, { against = 'current' } = {}) {
    if (!this.enabled) return [];
    if (!/^[0-9a-f]{7,40}$/i.test(snapshotId)) return [];

    const target = against === 'current' ? '' : against;
    if (target && !/^[0-9a-f]{7,40}$/i.test(target)) return [];

    try {
      // Lay danh sach files va status
      const nameStatusCmd = target
        ? `git diff --name-status ${snapshotId} ${target}`
        : `git diff --name-status ${snapshotId}`;
      const nameStatus = this._exec(nameStatusCmd).trim();
      if (!nameStatus) return [];

      const results = [];
      for (const line of nameStatus.split('\n')) {
        const [statusRaw, ...rest] = line.split(/\s+/);
        const filePath = rest.join(' ');
        const status = this._mapGitStatus(statusRaw);

        // Lay hunks cho file nay
        let hunks = [];
        try {
          const diffCmd = target
            ? `git diff --unified=3 ${snapshotId} ${target} -- "${filePath}"`
            : `git diff --unified=3 ${snapshotId} -- "${filePath}"`;
          const diffOut = this._exec(diffCmd);
          hunks = this._parseHunks(diffOut);
        } catch { /* ignore */ }

        results.push({ path: filePath, status, hunks });
      }
      return results;
    } catch {
      return [];
    }
  }

  /**
   * Gan label cho snapshot
   */
  labelSnapshot(snapshotId, label) {
    if (!snapshotId || !/^[0-9a-f]{7,40}$/i.test(snapshotId)) {
      return { success: false, message: 'Invalid snapshot id' };
    }
    const safeLabel = String(label || '').slice(0, 200);
    this._saveLabel(snapshotId, safeLabel);

    // Cap nhat session snapshots neu match
    const sessionSnap = this.snapshots.find(s => s.hash === snapshotId);
    if (sessionSnap) sessionSnap.label = safeLabel;

    return { success: true, snapshotId, label: safeLabel };
  }

  // === Private ===

  _checkGitRepo() {
    try {
      this._exec('git rev-parse --is-inside-work-tree');
      return true;
    } catch {
      return false;
    }
  }

  _exec(command) {
    return execSync(command, {
      cwd: this.projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000  // 10s timeout cho git commands
    });
  }

  _getChangedFileCount(statusOutput) {
    return statusOutput.trim().split('\n').filter(Boolean).length;
  }

  _appendLog(entry) {
    try {
      const dir = path.dirname(this.logFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Append JSONL format
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n', 'utf-8');

      // Trim log neu qua dai
      this._trimLog();
    } catch {
      // Silent fail — log is optional
    }
  }

  _trimLog() {
    try {
      const content = fs.readFileSync(this.logFile, 'utf-8');
      const lines = content.trim().split('\n');
      if (lines.length > this.maxSnapshots * 2) {
        // Giu 50 dong cuoi
        const trimmed = lines.slice(-this.maxSnapshots).join('\n') + '\n';
        fs.writeFileSync(this.logFile, trimmed, 'utf-8');
      }
    } catch {
      // Ignore
    }
  }

  _loadLabels() {
    try {
      if (!fs.existsSync(this.labelsFile)) return {};
      return JSON.parse(fs.readFileSync(this.labelsFile, 'utf-8')) || {};
    } catch {
      return {};
    }
  }

  _saveLabel(hash, label) {
    try {
      const dir = path.dirname(this.labelsFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const labels = this._loadLabels();
      labels[hash] = label;
      fs.writeFileSync(this.labelsFile, JSON.stringify(labels, null, 2), 'utf-8');
    } catch { /* ignore */ }
  }

  _mapGitStatus(code) {
    const c = (code || '').charAt(0).toUpperCase();
    if (c === 'A') return 'added';
    if (c === 'D') return 'deleted';
    if (c === 'M' || c === 'T') return 'modified';
    if (c === 'R') return 'renamed';
    if (c === 'C') return 'copied';
    return 'modified';
  }

  _parseHunks(diffText) {
    if (!diffText) return [];
    const hunks = [];
    const lines = diffText.split('\n');
    let current = null;

    for (const line of lines) {
      if (line.startsWith('@@')) {
        if (current) hunks.push(current);
        const header = line;
        const m = header.match(/@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
        current = {
          header,
          oldStart: m ? Number(m[1]) : 0,
          oldLines: m && m[2] ? Number(m[2]) : 1,
          newStart: m ? Number(m[3]) : 0,
          newLines: m && m[4] ? Number(m[4]) : 1,
          lines: []
        };
      } else if (current && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
        // Skip file headers like +++/---
        if (line.startsWith('+++') || line.startsWith('---')) continue;
        current.lines.push(line);
      }
    }
    if (current) hunks.push(current);
    return hunks;
  }
}

/**
 * Tu dong snapshot truoc khi chay op rui ro
 * Idempotent — cung 1 op trong 10s khong snapshot lai
 *
 * @param {Object} op - { type, command, files, summary }
 * @param {Object} context - { shadowGit, projectDir }
 * @returns {Promise<{snapshotted, hash, reason}>}
 */
async function maybeAutoSnapshot(op = {}, context = {}) {
  const shadow = context.shadowGit
    || (context.projectDir ? new ShadowGit(context.projectDir) : null);
  if (!shadow || !shadow.enabled) {
    return { snapshotted: false, reason: 'shadow-git not available' };
  }

  const risky = _assessRisk(op);
  if (!risky.isRisky) {
    return { snapshotted: false, reason: 'op not risky' };
  }

  // Dedupe — hash cua op de tranh snapshot trung lap trong 10s
  const opKey = crypto
    .createHash('sha1')
    .update(JSON.stringify({ t: op.type, c: op.command, f: op.files }))
    .digest('hex');

  const now = Date.now();
  const last = _autoSnapshotCache.get(opKey);
  if (last && now - last < AUTO_SNAPSHOT_DEDUPE_MS) {
    return { snapshotted: false, reason: 'deduped', opKey };
  }
  _autoSnapshotCache.set(opKey, now);

  // Cleanup cache cu (tranh memory leak)
  if (_autoSnapshotCache.size > 200) {
    for (const [k, t] of _autoSnapshotCache) {
      if (now - t > AUTO_SNAPSHOT_DEDUPE_MS * 10) _autoSnapshotCache.delete(k);
    }
  }

  const summary = op.summary || risky.opType;
  const reason = `auto-${risky.opType}`;
  const label = `before: ${summary}`.slice(0, 120);

  // Force snapshot (bypass session lock de moi risky op deu co checkpoint)
  const oldLock = shadow.sessionSnapshot;
  shadow.sessionSnapshot = null;
  const hash = await shadow.ensureSnapshot(reason, {
    triggeredBy: `auto:${risky.opType}`,
    label
  });
  if (!hash && oldLock) shadow.sessionSnapshot = oldLock;

  return {
    snapshotted: Boolean(hash),
    hash,
    opType: risky.opType,
    label,
    opKey
  };
}

/**
 * Danh gia do rui ro cua op
 * @returns {{isRisky: boolean, opType: string}}
 */
function _assessRisk(op) {
  const { type, command, files } = op || {};

  // Destructive bash
  if (type === 'bash' || type === 'exec' || command) {
    const cmd = String(command || '');
    for (const re of RISKY_BASH_PATTERNS) {
      if (re.test(cmd)) return { isRisky: true, opType: 'destructive-bash' };
    }
  }

  // Mass edit (>10 files)
  if (Array.isArray(files) && files.length > 10) {
    return { isRisky: true, opType: 'mass-edit' };
  }

  // File delete
  if (type === 'file-delete' || type === 'delete') {
    return { isRisky: true, opType: 'file-delete' };
  }

  // Migration
  if (type === 'migration' || type === 'db-migrate' ||
      (command && /\b(migrate|migration)\b/i.test(command))) {
    return { isRisky: true, opType: 'migration' };
  }

  return { isRisky: false, opType: null };
}

module.exports = { ShadowGit, maybeAutoSnapshot };
