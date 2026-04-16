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
const fs = require('fs');
const path = require('path');

class ShadowGit {
  constructor(projectDir, options = {}) {
    this.projectDir = projectDir;
    this.logFile = options.logFile || path.join(projectDir, '.sdd', 'shadow-git.log');
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
  async ensureSnapshot(reason = 'pre-ai-change') {
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
        changedFiles: this._getChangedFileCount(status)
      };
      this.snapshots.push(snapshot);

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
}

module.exports = { ShadowGit };
