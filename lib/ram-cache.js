#!/usr/bin/env node
/**
 * RamCache — 2-tier cache: in-memory LRU + disk spill
 *
 * - Tier 1 (RAM): Map voi LRU eviction, estimate size = JSON.stringify().length
 * - Tier 2 (Disk): spill overflow vao %LOCALAPPDATA%\orcai\cache\ (Windows)
 *                  hoac ~/.cache/orcai/ (Unix)
 * - Key hash bang SHA-256 → filename an toan
 * - TTL + atime-based LRU cho disk tier
 *
 * API:
 *   get(key) → Promise<value | undefined>
 *   set(key, value, {ttl?}) → Promise<void>
 *   delete(key) → Promise<void>
 *   stats() → { ramEntries, ramBytes, diskEntries, diskBytes }
 *   clear() → Promise<void>
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function defaultCacheDir() {
  // Windows: %LOCALAPPDATA%\orcai\cache
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'orcai', 'cache');
  }
  // Unix / fallback
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return path.join(xdg, 'orcai');
  return path.join(os.homedir(), '.cache', 'orcai');
}

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function estimateSize(value) {
  // Uoc luong bytes — JSON string length * 2 (UTF-16 in-memory)
  try {
    return JSON.stringify(value).length * 2;
  } catch {
    return 1024;
  }
}

class RamCache {
  constructor(options = {}) {
    this.maxRamBytes = options.maxRamBytes || 100 * 1024 * 1024; // 100MB default
    this.cacheDir = options.cacheDir || defaultCacheDir();
    this.defaultTtl = options.ttl || 0; // 0 = khong het han
    this.enableDisk = options.enableDisk !== false;

    this.ram = new Map();   // key → { value, bytes, expiresAt, lastAccess }
    this.ramBytes = 0;

    if (this.enableDisk) {
      try { fs.mkdirSync(this.cacheDir, { recursive: true }); }
      catch { this.enableDisk = false; }
    }
  }

  _filePath(key) {
    return path.join(this.cacheDir, hashKey(key) + '.json');
  }

  /**
   * LRU eviction trong RAM — don khi vuot budget.
   * Entry bi evict khong tu dong spill sang disk (de tai day chi spill khi set explicit)
   * → don gian, traceable.
   */
  _evictIfNeeded() {
    if (this.ramBytes <= this.maxRamBytes) return;
    // Sort theo lastAccess tang dan → evict cu nhat
    const entries = [...this.ram.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    for (const [k, entry] of entries) {
      if (this.ramBytes <= this.maxRamBytes) break;
      // Spill sang disk truoc khi evict (neu chua het han + enableDisk)
      if (this.enableDisk && (!entry.expiresAt || entry.expiresAt > Date.now())) {
        // Fire-and-forget spill
        this._writeDisk(k, entry.value, entry.expiresAt).catch(() => {});
      }
      this.ram.delete(k);
      this.ramBytes -= entry.bytes;
    }
  }

  async _writeDisk(key, value, expiresAt) {
    if (!this.enableDisk) return;
    const file = this._filePath(key);
    const payload = {
      key,
      value,
      expiresAt: expiresAt || 0,
      createdAt: Date.now()
    };
    try {
      // Atomic write: temp → rename
      const tmp = file + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(payload), 'utf-8');
      await fsp.rename(tmp, file);
    } catch { /* ignore disk error */ }
  }

  async _readDisk(key) {
    if (!this.enableDisk) return undefined;
    const file = this._filePath(key);
    try {
      const raw = await fsp.readFile(file, 'utf-8');
      const payload = JSON.parse(raw);
      if (payload.expiresAt && payload.expiresAt < Date.now()) {
        // Het han — xoa
        fsp.unlink(file).catch(() => {});
        return undefined;
      }
      // Update atime cho LRU disk
      const now = new Date();
      fsp.utimes(file, now, now).catch(() => {});
      return payload.value;
    } catch {
      return undefined;
    }
  }

  async _deleteDisk(key) {
    if (!this.enableDisk) return;
    try { await fsp.unlink(this._filePath(key)); } catch {}
  }

  /**
   * get — check RAM first, roi disk. Neu disk hit → promote len RAM.
   */
  async get(key) {
    const entry = this.ram.get(key);
    if (entry) {
      if (entry.expiresAt && entry.expiresAt < Date.now()) {
        this.ram.delete(key);
        this.ramBytes -= entry.bytes;
        return undefined;
      }
      entry.lastAccess = Date.now();
      return entry.value;
    }

    // Disk lookup
    const diskVal = await this._readDisk(key);
    if (diskVal !== undefined) {
      // Promote len RAM
      this._putRam(key, diskVal, 0);
      return diskVal;
    }
    return undefined;
  }

  _putRam(key, value, ttlMs) {
    const bytes = estimateSize(value);
    const existing = this.ram.get(key);
    if (existing) this.ramBytes -= existing.bytes;

    const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : 0;
    this.ram.set(key, {
      value,
      bytes,
      expiresAt,
      lastAccess: Date.now()
    });
    this.ramBytes += bytes;
    this._evictIfNeeded();
  }

  async set(key, value, options = {}) {
    const ttl = options.ttl != null ? options.ttl : this.defaultTtl;
    this._putRam(key, value, ttl);
    // Khong spill ngay — chi spill khi evict. Neu caller muon persistent,
    // duoi mirror den disk luon (configurable)
    if (options.persist && this.enableDisk) {
      const expiresAt = ttl > 0 ? Date.now() + ttl : 0;
      await this._writeDisk(key, value, expiresAt);
    }
  }

  async delete(key) {
    const entry = this.ram.get(key);
    if (entry) {
      this.ram.delete(key);
      this.ramBytes -= entry.bytes;
    }
    await this._deleteDisk(key);
  }

  async clear() {
    this.ram.clear();
    this.ramBytes = 0;
    if (!this.enableDisk) return;
    try {
      const files = await fsp.readdir(this.cacheDir);
      await Promise.all(
        files
          .filter(f => f.endsWith('.json'))
          .map(f => fsp.unlink(path.join(this.cacheDir, f)).catch(() => {}))
      );
    } catch {}
  }

  stats() {
    let diskEntries = 0;
    let diskBytes = 0;
    if (this.enableDisk) {
      try {
        const files = fs.readdirSync(this.cacheDir).filter(f => f.endsWith('.json'));
        diskEntries = files.length;
        for (const f of files) {
          try {
            const st = fs.statSync(path.join(this.cacheDir, f));
            diskBytes += st.size;
          } catch {}
        }
      } catch {}
    }
    return {
      ramEntries: this.ram.size,
      ramBytes: this.ramBytes,
      maxRamBytes: this.maxRamBytes,
      diskEntries,
      diskBytes,
      cacheDir: this.cacheDir,
      enableDisk: this.enableDisk
    };
  }
}

module.exports = { RamCache, defaultCacheDir, hashKey };
