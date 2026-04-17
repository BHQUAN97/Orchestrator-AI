#!/usr/bin/env node
/**
 * Worktree — Git worktree isolation cho agent
 *
 * Giong `isolation: "worktree"` cua Claude Code:
 * 1. Tao git worktree tai tmp path, branch moi (orcai/<timestamp>)
 * 2. Agent chay trong worktree → changes khong dung main branch
 * 3. Sau khi xong → user decide merge/discard
 * 4. Cleanup tu dong neu khong co thay doi (clean worktree)
 *
 * Yeu cau: project phai la git repo, co commit toi thieu 1 lan.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

class WorktreeSession {
  constructor(projectDir) {
    this.projectDir = projectDir;
    this.branch = null;
    this.worktreePath = null;
    this.created = false;
  }

  /**
   * Tao worktree moi
   * @param {string} baseBranch - branch de tao ra (default: current HEAD)
   * @returns {{ path, branch }} - info worktree
   */
  create(baseBranch) {
    this._assertGitRepo();

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const short = Math.random().toString(36).slice(2, 8);
    this.branch = `orcai/${ts}-${short}`;

    // Put worktree in OS tmp to keep projectDir clean
    const projectName = path.basename(this.projectDir);
    this.worktreePath = path.join(os.tmpdir(), `orcai-worktree-${projectName}-${short}`);

    const base = baseBranch || 'HEAD';

    try {
      execSync(`git worktree add -b "${this.branch}" "${this.worktreePath}" ${base}`, {
        cwd: this.projectDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
        timeout: 30000
      });
      this.created = true;
      return { path: this.worktreePath, branch: this.branch };
    } catch (e) {
      throw new Error(`Failed to create worktree: ${e.message}`);
    }
  }

  /**
   * Check neu worktree co changes (uncommitted hoac commits)
   */
  hasChanges() {
    if (!this.created) return false;
    try {
      const status = execSync('git status --porcelain', {
        cwd: this.worktreePath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000
      }).trim();
      if (status) return true;
      // Check commits ahead of base
      try {
        const ahead = execSync(`git rev-list --count HEAD ^${this._baseBranch()}`, {
          cwd: this.worktreePath,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5000
        }).trim();
        return parseInt(ahead, 10) > 0;
      } catch { return false; }
    } catch { return false; }
  }

  /**
   * Cleanup — remove worktree + optionally delete branch
   * @param {Object} opts - { force: ghi de ngay ca co changes, deleteBranch: true }
   */
  cleanup(opts = {}) {
    if (!this.created) return { removed: false };
    const hadChanges = this.hasChanges();
    if (hadChanges && !opts.force) {
      return { removed: false, reason: 'Has uncommitted changes or commits. Pass { force: true } to discard.' };
    }

    try {
      execSync(`git worktree remove --force "${this.worktreePath}"`, {
        cwd: this.projectDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000
      });
    } catch (e) {
      return { removed: false, reason: `worktree remove failed: ${e.message}` };
    }

    if (opts.deleteBranch && this.branch) {
      try {
        execSync(`git branch -D "${this.branch}"`, {
          cwd: this.projectDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 5000
        });
      } catch { /* ignore */ }
    }

    this.created = false;
    return { removed: true, hadChanges };
  }

  _assertGitRepo() {
    try {
      execSync('git rev-parse --is-inside-work-tree', {
        cwd: this.projectDir,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8',
        timeout: 3000
      });
    } catch {
      throw new Error('Not a git repository. Worktree requires git.');
    }
  }

  _baseBranch() {
    try {
      // Dung main neu co, fallback master, cuoi cung HEAD^
      for (const candidate of ['main', 'master']) {
        try {
          execSync(`git rev-parse --verify ${candidate}`, {
            cwd: this.projectDir,
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 2000
          });
          return candidate;
        } catch { /* try next */ }
      }
    } catch {}
    return 'HEAD~1';
  }
}

module.exports = { WorktreeSession };
