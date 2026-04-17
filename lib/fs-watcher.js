#!/usr/bin/env node
/**
 * FsWatcher — File system watcher dung fs.watch native
 *
 * - Recursive: true (ho tro tren Windows va macOS)
 * - Debounce 200ms de gop burst events (save trigger nhieu events)
 * - Ignore pattern: node_modules, .git, __pycache__, *.log, ...
 * - Event: 'change' (path), 'rename' (path), 'error' (err)
 *
 * Usage:
 *   const w = new FsWatcher({ paths: [projectDir], ignore: [...] });
 *   w.on('change', p => console.log('changed', p));
 *   w.close();
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '.orcai',
  'coverage',
  '*.log',
  '*.tmp',
  '.DS_Store'
];

function matchesPattern(name, pattern) {
  // Glob-lite: ho tro * o dau/cuoi
  if (pattern.includes('*')) {
    // Chuyen * sang regex
    const re = new RegExp(
      '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      'i'
    );
    return re.test(name);
  }
  return name === pattern;
}

class FsWatcher extends EventEmitter {
  constructor({ paths = [], ignore } = {}) {
    super();
    this.paths = Array.isArray(paths) ? paths : [paths];
    this.ignorePatterns = ignore || DEFAULT_IGNORE;
    this.watchers = [];
    this.debounceMs = 200;
    this.pendingEvents = new Map(); // path → { event, timer }
    this.closed = false;

    for (const p of this.paths) {
      this._watchPath(p);
    }
  }

  _isIgnored(fullOrRelPath) {
    if (!fullOrRelPath) return false;
    // Check tat ca segment cua path voi pattern
    const parts = String(fullOrRelPath).split(/[\\/]/);
    for (const part of parts) {
      for (const pat of this.ignorePatterns) {
        if (matchesPattern(part, pat)) return true;
      }
    }
    return false;
  }

  _watchPath(targetPath) {
    try {
      const stat = fs.statSync(targetPath);
      if (!stat.isDirectory()) {
        // Watch single file
        const w = fs.watch(targetPath, (event, fname) => {
          this._handleEvent(targetPath, event, fname || path.basename(targetPath));
        });
        w.on('error', (err) => this.emit('error', err));
        this.watchers.push(w);
        return;
      }

      // Watch directory recursive (Windows + macOS support recursive)
      const opts = { recursive: true };
      const w = fs.watch(targetPath, opts, (event, fname) => {
        if (!fname) return;
        const rel = fname;
        if (this._isIgnored(rel)) return;
        const full = path.join(targetPath, rel);
        this._handleEvent(full, event, rel);
      });
      w.on('error', (err) => this.emit('error', err));
      this.watchers.push(w);
    } catch (err) {
      this.emit('error', err);
    }
  }

  _handleEvent(fullPath, event, relName) {
    // Debounce theo path
    const existing = this.pendingEvents.get(fullPath);
    if (existing && existing.timer) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.pendingEvents.delete(fullPath);
      if (this.closed) return;
      // event la 'change' hoac 'rename'
      this.emit(event, fullPath);
      this.emit('all', { event, path: fullPath });
    }, this.debounceMs);

    this.pendingEvents.set(fullPath, { event, timer });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pendingEvents) {
      if (p.timer) clearTimeout(p.timer);
    }
    this.pendingEvents.clear();
    for (const w of this.watchers) {
      try { w.close(); } catch {}
    }
    this.watchers = [];
    this.emit('close');
  }
}

// Graceful shutdown
const _activeWatchers = new Set();
const _origInit = FsWatcher.prototype._watchPath;
// Track via wrapper
const _origClose = FsWatcher.prototype.close;
FsWatcher.prototype.close = function () {
  _activeWatchers.delete(this);
  return _origClose.call(this);
};

const _origCtor = FsWatcher.prototype.constructor;
// Simpler: patch constructor via Proxy not needed — track in ctor directly
const _OrigFsWatcher = FsWatcher;
function TrackedFsWatcher(opts) {
  const inst = new _OrigFsWatcher(opts);
  _activeWatchers.add(inst);
  return inst;
}
TrackedFsWatcher.prototype = _OrigFsWatcher.prototype;

process.on('exit', () => {
  for (const w of _activeWatchers) {
    try { w.close(); } catch {}
  }
});

module.exports = { FsWatcher, DEFAULT_IGNORE };
