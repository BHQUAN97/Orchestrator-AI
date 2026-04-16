/**
 * Context Cache — Cache prompt prefix de tai su dung across calls
 * Giam input tokens bang cach cache: constitution, agent persona, spec
 *
 * Cach dung:
 *   const cache = new ContextCache();
 *   const cached = cache.get('constitution', filePath);
 *   if (!cached) cache.set('constitution', filePath, content);
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class ContextCache {
  constructor(options = {}) {
    this.maxSize = options.maxSizeMB || 50;
    this.ttl = options.ttlMinutes || 30;
    this.cacheDir = options.cacheDir || path.join(__dirname, '..', 'data', 'cache');
    // In-memory LRU
    this.entries = new Map();
    this.stats = { hits: 0, misses: 0, bytes_saved: 0 };
  }

  // Hash noi dung file de detect thay doi
  _hash(content) {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  // Lay tu cache
  get(layer, filePath) {
    const key = `${layer}:${filePath}`;
    const entry = this.entries.get(key);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check TTL
    const age = (Date.now() - entry.timestamp) / 1000 / 60;
    if (age > this.ttl) {
      this.entries.delete(key);
      this.stats.misses++;
      return null;
    }

    // Check file thay doi chua
    try {
      const currentContent = fs.readFileSync(filePath, 'utf-8');
      const currentHash = this._hash(currentContent);
      if (currentHash !== entry.hash) {
        // File da thay doi → invalidate
        this.entries.delete(key);
        this.stats.misses++;
        return null;
      }
    } catch {
      // File khong doc duoc → tra cache cu
    }

    this.stats.hits++;
    this.stats.bytes_saved += entry.content.length;
    return entry.content;
  }

  // Luu vao cache
  set(layer, filePath, content) {
    const key = `${layer}:${filePath}`;
    const hash = this._hash(content);

    this.entries.set(key, {
      layer,
      filePath,
      content,
      hash,
      timestamp: Date.now(),
      size: content.length
    });

    // Evict neu qua max size
    this._evictIfNeeded();
  }

  // Lay tat ca cached content cho 1 layer
  getLayer(layer) {
    const results = [];
    for (const [key, entry] of this.entries) {
      if (entry.layer === layer) {
        const age = (Date.now() - entry.timestamp) / 1000 / 60;
        if (age <= this.ttl) {
          results.push(entry);
        }
      }
    }
    return results;
  }

  // Build cached prompt prefix tu cac layers
  buildPrefix(projectDir, featureName = null) {
    const layers = [];

    // Layer 1: Constitution (it thay doi)
    const constitutionPath = path.join(projectDir, '.sdd', 'constitution.md');
    if (fs.existsSync(constitutionPath)) {
      let content = this.get('constitution', constitutionPath);
      if (!content) {
        content = fs.readFileSync(constitutionPath, 'utf-8');
        this.set('constitution', constitutionPath, content);
      }
      layers.push({ role: 'constitution', content });
    }

    // Layer 2: CLAUDE.md (project context)
    const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
      let content = this.get('project_context', claudeMdPath);
      if (!content) {
        content = fs.readFileSync(claudeMdPath, 'utf-8');
        this.set('project_context', claudeMdPath, content);
      }
      layers.push({ role: 'project_context', content });
    }

    // Layer 3: Feature spec (neu co)
    if (featureName) {
      const specPath = path.join(projectDir, '.sdd', 'features', featureName, 'spec.md');
      if (fs.existsSync(specPath)) {
        let content = this.get('spec', specPath);
        if (!content) {
          content = fs.readFileSync(specPath, 'utf-8');
          this.set('spec', specPath, content);
        }
        layers.push({ role: 'spec', content });
      }

      const planPath = path.join(projectDir, '.sdd', 'features', featureName, 'plan.md');
      if (fs.existsSync(planPath)) {
        let content = this.get('plan', planPath);
        if (!content) {
          content = fs.readFileSync(planPath, 'utf-8');
          this.set('plan', planPath, content);
        }
        layers.push({ role: 'plan', content });
      }
    }

    return layers;
  }

  // Thong ke
  getStats() {
    const totalSize = Array.from(this.entries.values())
      .reduce((sum, e) => sum + e.size, 0);

    return {
      entries: this.entries.size,
      totalSizeKB: Math.round(totalSize / 1024),
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: this.stats.hits + this.stats.misses > 0
        ? Math.round(this.stats.hits / (this.stats.hits + this.stats.misses) * 100)
        : 0,
      bytesSavedKB: Math.round(this.stats.bytes_saved / 1024)
    };
  }

  // Xoa entries cu nhat khi vuot max size
  _evictIfNeeded() {
    const maxBytes = this.maxSize * 1024 * 1024;
    let totalSize = Array.from(this.entries.values())
      .reduce((sum, e) => sum + e.size, 0);

    if (totalSize <= maxBytes) return;

    // Sap xep theo timestamp (cu nhat truoc)
    const sorted = Array.from(this.entries.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);

    for (const [key, entry] of sorted) {
      if (totalSize <= maxBytes) break;
      totalSize -= entry.size;
      this.entries.delete(key);
    }
  }

  // Invalidate tat ca cache cho 1 project
  invalidateProject(projectDir) {
    for (const [key, entry] of this.entries) {
      if (entry.filePath.startsWith(projectDir)) {
        this.entries.delete(key);
      }
    }
  }
}

module.exports = { ContextCache };
