#!/usr/bin/env node
/**
 * Repo Cache — Cache RepoMapper output de orcai khoi dong nhanh
 *
 * RepoMapper.scan() ton ~300-800ms moi lan (quet toan project).
 * Cache ket qua trong .orcai/repo-cache.json voi TTL + invalidation:
 * - TTL: 1h mac dinh
 * - Invalidate: neu git HEAD thay doi
 * - Invalidate: neu key file (package.json) modified sau cache
 *
 * Huy cache: xoa .orcai/repo-cache.json hoac goi invalidate()
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { RepoMapper } = require('./repo-mapper');

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h

class RepoCache {
  constructor(options = {}) {
    this.projectDir = options.projectDir || process.cwd();
    this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
    this.cachePath = path.join(this.projectDir, '.orcai', 'repo-cache.json');
    this.mapper = new RepoMapper({ projectDir: this.projectDir });
  }

  async getSummary() {
    const cached = this._load();
    if (cached && !this._isStale(cached)) {
      return cached.summary;
    }

    // Cache miss or stale → rescan
    const { summary } = await this.mapper.scan();
    this._save({
      summary,
      cachedAt: Date.now(),
      gitHead: this._getGitHead(),
      pkgMtime: this._getPackageMtime()
    });
    return summary;
  }

  invalidate() {
    try { fs.unlinkSync(this.cachePath); } catch {}
  }

  _load() {
    try {
      if (!fs.existsSync(this.cachePath)) return null;
      return JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  _save(data) {
    try {
      const dir = path.dirname(this.cachePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // silent
    }
  }

  _isStale(cached) {
    if (!cached.cachedAt) return true;
    const age = Date.now() - cached.cachedAt;
    if (age > this.ttlMs) return true;

    // Invalidate on git HEAD change
    const head = this._getGitHead();
    if (head && cached.gitHead && head !== cached.gitHead) return true;

    // Invalidate on package.json change
    const mtime = this._getPackageMtime();
    if (mtime && cached.pkgMtime && mtime > cached.pkgMtime) return true;

    return false;
  }

  _getGitHead() {
    try {
      return execSync('git rev-parse HEAD', {
        cwd: this.projectDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000
      }).trim();
    } catch {
      return null;
    }
  }

  _getPackageMtime() {
    try {
      const pkgPath = path.join(this.projectDir, 'package.json');
      if (fs.existsSync(pkgPath)) return fs.statSync(pkgPath).mtimeMs;
    } catch {}
    return null;
  }
}

module.exports = { RepoCache };
