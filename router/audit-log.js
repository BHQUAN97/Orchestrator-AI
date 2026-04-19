#!/usr/bin/env node
/**
 * Audit Log — append-only JSONL cho Decision Lock events
 *
 * Muc dich: Moi lan agent bi chan khi co doi API/schema, ghi lai vao audit trail
 * de sau nay demo / debug / chung minh "agent bi chan" la observable.
 *
 * Format: 1 JSON per line tai {projectDir}/.sdd/audit.log.jsonl
 * Events: lock_created, lock_validated_allowed, lock_validated_blocked,
 *         lock_unlocked, lock_expired, lock_override_warning
 */

const fs = require('fs');
const path = require('path');

const VALID_EVENTS = new Set([
  'lock_created',
  'lock_validated_allowed',
  'lock_validated_blocked',
  'lock_unlocked',
  'lock_unlock_refused',
  'lock_expired',
  'lock_override_warning'
]);

class AuditLog {
  constructor(options = {}) {
    this.projectDir = options.projectDir || process.cwd();
    this.logFile = options.logFile || path.join(this.projectDir, '.sdd', 'audit.log.jsonl');
    this._ensureDir();
  }

  /**
   * Append 1 event vao JSONL (sync — caller chiu block nho, doi lai durability)
   */
  append({ event, actor, scope, decisionId, details, timestamp } = {}) {
    if (!event) throw new Error('AuditLog.append: event is required');

    const entry = {
      timestamp: timestamp || new Date().toISOString(),
      event,
      actor: actor || null,
      scope: scope || null,
      decisionId: decisionId || null,
      details: details || {}
    };

    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(this.logFile, line, 'utf-8');
    return entry;
  }

  /**
   * Query entries voi filter
   * Strategy: khi limit nho → doc nguoc tu EOF (tiet kiem khi log to)
   * Khi khong co limit hoac limit lon → doc full file
   */
  query({ event, actor, scope, since, until, limit } = {}) {
    if (!fs.existsSync(this.logFile)) return [];

    const matches = (e) => {
      if (event && e.event !== event) return false;
      if (actor && e.actor !== actor) return false;
      if (scope && e.scope !== scope) return false;
      if (since && new Date(e.timestamp) < new Date(since)) return false;
      if (until && new Date(e.timestamp) > new Date(until)) return false;
      return true;
    };

    // Small-limit fast path — doc nguoc tu EOF
    if (limit && limit <= 500) {
      const recent = this._readTail(limit * 10); // buffer rong de co du sau filter
      const filtered = recent.filter(matches);
      // _readTail tra chronological order (oldest → newest in recent window)
      return filtered.slice(-limit);
    }

    // Full read
    const all = this._readAll();
    const filtered = all.filter(matches);
    if (limit) return filtered.slice(-limit);
    return filtered;
  }

  /**
   * Last N entries (chronological — oldest → newest)
   */
  tail(n = 20) {
    if (!fs.existsSync(this.logFile)) return [];
    return this._readTail(n);
  }

  /**
   * Count per event type
   */
  stats() {
    const counts = {};
    let total = 0;
    if (!fs.existsSync(this.logFile)) return { total: 0, byEvent: counts };

    const all = this._readAll();
    for (const e of all) {
      counts[e.event] = (counts[e.event] || 0) + 1;
      total++;
    }
    return { total, byEvent: counts };
  }

  // === Private ===

  _ensureDir() {
    const dir = path.dirname(this.logFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _readAll() {
    const raw = fs.readFileSync(this.logFile, 'utf-8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
    }
    return out;
  }

  /**
   * Read backwards from EOF — return last N in chronological order
   * Uses chunked reads to avoid loading entire file for large logs
   */
  _readTail(n) {
    const CHUNK = 64 * 1024;
    const fd = fs.openSync(this.logFile, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size === 0) return [];

      let pos = size;
      let buffer = '';
      const lines = [];

      while (pos > 0 && lines.length <= n) {
        const readSize = Math.min(CHUNK, pos);
        pos -= readSize;
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, pos);
        buffer = buf.toString('utf-8') + buffer;

        // Extract complete lines except possibly the first (may be partial)
        const parts = buffer.split('\n');
        // If not at file start, the first part may be partial — keep it
        if (pos > 0) {
          buffer = parts.shift();
        } else {
          buffer = '';
        }
        // Add non-empty parts to lines (reverse push — we will reverse at end)
        for (let i = parts.length - 1; i >= 0; i--) {
          const ln = parts[i].trim();
          if (!ln) continue;
          lines.push(ln);
          if (lines.length > n) break;
        }
      }

      // lines is in reverse chronological order, we want chronological
      const out = [];
      for (let i = Math.min(lines.length, n) - 1; i >= 0; i--) {
        try { out.push(JSON.parse(lines[i])); } catch { /* skip */ }
      }
      return out;
    } finally {
      fs.closeSync(fd);
    }
  }
}

module.exports = { AuditLog, VALID_EVENTS };
