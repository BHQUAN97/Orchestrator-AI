#!/usr/bin/env node
/**
 * Memory — Tich luy kinh nghiem giua cac session
 *
 * Store: .orcai/memory/lessons.jsonl — append-only JSONL
 * Entry structure:
 *   { ts, type, prompt_summary, keywords[], outcome, summary, files_changed, iterations }
 *
 * type:
 *   'lesson' — tu dong ghi khi task_complete thanh cong
 *   'gotcha' — ghi khi task fail, de rut kinh nghiem
 *   'manual' — user hoac agent chu dong save
 *   'fact' — project fact (database schema, API contract...)
 *
 * Retrieval: keyword-based scoring (don gian, khong can vector DB).
 * Khi agent chuan bi lam task moi → search top-K relevant entries → inject vao system prompt.
 */

const fs = require('fs');
const path = require('path');
const { searchCorpus } = require('./semantic-search');

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'or', 'the', 'to', 'of', 'for', 'in', 'on', 'at', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'should', 'could', 'can', 'may',
  'that', 'this', 'these', 'those', 'which', 'what', 'who', 'when', 'where',
  'why', 'how', 'all', 'some', 'any', 'no', 'not', 'very', 'just',
  'va', 'hoac', 'trong', 'cho', 've', 'de', 'cua', 'la', 'co', 'khong',
  'duoc', 'nay', 'do', 'the', 'nay'
]);

function extractKeywords(text, maxKeywords = 15) {
  if (!text) return [];
  const tokens = String(text).toLowerCase()
    .replace(/[^\w\s\-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));

  // Frequency map
  const freq = {};
  for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([w]) => w);
}

class MemoryStore {
  constructor(projectDir, options = {}) {
    this.projectDir = projectDir;
    this.memoryDir = path.join(projectDir, '.orcai', 'memory');
    this.lessonsFile = path.join(this.memoryDir, 'lessons.jsonl');
    this.maxEntries = options.maxEntries || 500;
    this.enabled = options.enabled !== false;

    if (this.enabled) {
      try { fs.mkdirSync(this.memoryDir, { recursive: true }); } catch { this.enabled = false; }
    }
  }

  /**
   * Append entry. Returns the entry with generated id.
   */
  append(entry) {
    if (!this.enabled) return null;
    const record = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: new Date().toISOString(),
      type: entry.type || 'manual',
      keywords: entry.keywords || extractKeywords((entry.prompt_summary || '') + ' ' + (entry.summary || '')),
      ...entry
    };

    try {
      fs.appendFileSync(this.lessonsFile, JSON.stringify(record) + '\n');
      this._trim();
      return record;
    } catch {
      return null;
    }
  }

  /**
   * Read all entries (uses sync read; OK vi file nho ~500 entries max)
   */
  readAll() {
    if (!this.enabled || !fs.existsSync(this.lessonsFile)) return [];
    try {
      const raw = fs.readFileSync(this.lessonsFile, 'utf-8');
      const lines = raw.split('\n').filter(Boolean);
      const entries = [];
      for (const line of lines) {
        try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
      return entries;
    } catch {
      return [];
    }
  }

  /**
   * Search memory. Uses TF-IDF (semantic-search.js) — tot hon keyword overlap:
   *   - Trong so tu hiem (IDF)
   *   - Normalize theo do dai document
   *   - Fallback keyword overlap neu TF-IDF khong khop gi
   */
  search(query, limit = 5) {
    if (!query) return [];
    const entries = this.readAll();
    if (!entries.length) return [];

    // Build corpus: combine summary + prompt_summary + keywords
    const docs = entries.map(e => ({
      id: e.id,
      text: [
        e.prompt_summary || '',
        e.summary || '',
        (e.keywords || []).join(' ')
      ].join(' '),
      entry: e
    }));

    const results = searchCorpus(docs, query, limit);
    if (results.length) {
      return results.map(r => ({ ...r.entry, _score: r._score }));
    }

    // Fallback: keyword overlap (neu TF-IDF khong tim thay gi)
    const queryKws = new Set(extractKeywords(query));
    if (queryKws.size === 0) return [];
    const scored = [];
    for (const e of entries) {
      const entryKws = new Set(e.keywords || []);
      if (entryKws.size === 0) continue;
      let matched = 0;
      for (const kw of queryKws) if (entryKws.has(kw)) matched++;
      if (matched === 0) continue;
      const score = matched / Math.sqrt(queryKws.size * entryKws.size);
      scored.push({ entry: e, score });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => ({ ...s.entry, _score: Number(s.score.toFixed(3)) }));
  }

  list({ limit = 20, type } = {}) {
    let entries = this.readAll();
    if (type) entries = entries.filter(e => e.type === type);
    return entries.slice(-limit).reverse();
  }

  getStats() {
    const entries = this.readAll();
    const byType = {};
    for (const e of entries) byType[e.type] = (byType[e.type] || 0) + 1;
    return { total: entries.length, byType, path: this.lessonsFile };
  }

  /**
   * Tu dong trim neu vuot maxEntries — giu entries moi nhat
   */
  _trim() {
    try {
      const entries = this.readAll();
      if (entries.length <= this.maxEntries) return;
      const kept = entries.slice(-this.maxEntries);
      fs.writeFileSync(this.lessonsFile, kept.map(e => JSON.stringify(e)).join('\n') + '\n');
    } catch { /* ignore */ }
  }

  clear() {
    try { fs.unlinkSync(this.lessonsFile); } catch {}
  }
}

/**
 * Format memory entries de inject vao system prompt
 */
function formatMemoryContext(entries, maxLen = 2000) {
  if (!entries?.length) return '';
  const lines = ['=== Relevant past experience ==='];
  for (const e of entries) {
    const prefix = e.type === 'gotcha' ? '⚠' : e.type === 'fact' ? 'ℹ' : '✓';
    const summary = (e.summary || e.prompt_summary || '').slice(0, 200).replace(/\n/g, ' ');
    lines.push(`${prefix} [${e.type}] ${summary}`);
  }
  lines.push('=== End past experience ===');
  const text = lines.join('\n');
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}

module.exports = { MemoryStore, extractKeywords, formatMemoryContext };
