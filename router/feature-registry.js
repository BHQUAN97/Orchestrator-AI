#!/usr/bin/env node
/**
 * Feature Registry — JSON store theo doi vong doi feature
 *
 * Muc dich: Decision Lock can biet feature dang mo hay da dong de quyet dinh
 * co unlock hay khong. TTL cung → lock het han giua chung feature.
 * TTL dong theo feature → lock ton tai cho den khi feature merge/revert.
 *
 * File: {projectDir}/.sdd/features.json
 * Entry: { id, name, startedAt, closedAt?, closedBy?, reason?, status: 'open'|'closed' }
 */

const fs = require('fs');
const path = require('path');

const BUFFER_AFTER_CLOSE_MS = 24 * 60 * 60 * 1000; // 24h buffer sau khi close

class FeatureRegistry {
  constructor(options = {}) {
    this.projectDir = options.projectDir || process.cwd();
    this.storeFile = options.storeFile || path.join(this.projectDir, '.sdd', 'features.json');
    this.features = this._load();
  }

  registerFeature({ id, name, startedAt }) {
    if (!id) throw new Error('registerFeature: id required');
    if (this.features.find(f => f.id === id)) {
      throw new Error(`Feature "${id}" already registered`);
    }
    const entry = {
      id,
      name: name || id,
      startedAt: startedAt || new Date().toISOString(),
      closedAt: null,
      closedBy: null,
      reason: null,
      status: 'open'
    };
    this.features.push(entry);
    this._save();
    return entry;
  }

  closeFeature(id, { closedAt, closedBy = 'system', reason = 'feature closed' } = {}) {
    const f = this.features.find(x => x.id === id);
    if (!f) return null;
    if (f.status === 'closed') return f;
    f.status = 'closed';
    f.closedAt = closedAt || new Date().toISOString();
    f.closedBy = closedBy;
    f.reason = reason;
    this._save();
    return f;
  }

  getFeature(id) {
    return this.features.find(f => f.id === id) || null;
  }

  isOpen(id) {
    const f = this.getFeature(id);
    return !!f && f.status === 'open';
  }

  listOpen() {
    return this.features.filter(f => f.status === 'open');
  }

  listAll() {
    return [...this.features];
  }

  /**
   * Tinh thoi diem feature "het hieu luc" cho lock purposes.
   * Open → null (khong expire theo feature)
   * Closed → closedAt + 24h buffer
   */
  getFeatureEndAt(id) {
    const f = this.getFeature(id);
    if (!f) return null;
    if (f.status === 'open') return null;
    return new Date(f.closedAt).getTime() + BUFFER_AFTER_CLOSE_MS;
  }

  _load() {
    try {
      if (fs.existsSync(this.storeFile)) {
        const raw = JSON.parse(fs.readFileSync(this.storeFile, 'utf-8'));
        if (Array.isArray(raw)) return raw;
        if (raw && Array.isArray(raw.features)) return raw.features;
      }
    } catch (e) {
      console.error(`⚠️  Feature registry corrupted: ${e.message}`);
    }
    return [];
  }

  _save() {
    const dir = path.dirname(this.storeFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.storeFile, JSON.stringify(this.features, null, 2), 'utf-8');
  }
}

module.exports = { FeatureRegistry, BUFFER_AFTER_CLOSE_MS };
