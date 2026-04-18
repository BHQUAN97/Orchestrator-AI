#!/usr/bin/env node
/**
 * Trace Store — Persistent, query-friendly storage cho pipeline traces
 *
 * Cau truc:
 *   {projectDir}/.orcai/traces/
 *     ├── index.jsonl          — append-only summary index (fast list/query)
 *     └── {traceId}.json       — full trace detail
 *
 * Index entry shape: { id, startedAt, endedAt, status, taskSummary, totalCost, totalTokens }
 * Trace detail shape: { id, startedAt, endedAt, status, task, steps, totalCost, totalTokens, result }
 *
 * VAN DE:
 *   PipelineTracer luu in-memory + optional dump ra file rieng le → khong query duoc.
 *   Muon "list 10 traces gan day failed" → phai scan toan bo thu muc, parse tung file.
 *
 * GIAI PHAP:
 *   Index JSONL append-only → doc nhanh, filter O(n) nhung n nho (summary only).
 *   Detail file rieng → chi load khi user mo xem.
 */

const fs = require('fs');
const path = require('path');

const VALID_STATUS = new Set(['running', 'completed', 'failed', 'aborted']);

class TraceStore {
  constructor({ projectDir } = {}) {
    if (!projectDir) throw new Error('TraceStore requires projectDir');
    this.projectDir = projectDir;
    this.baseDir = path.join(projectDir, '.orcai', 'traces');
    this.indexPath = path.join(this.baseDir, 'index.jsonl');
    this._ensureDir();
  }

  _ensureDir() {
    try {
      if (!fs.existsSync(this.baseDir)) {
        fs.mkdirSync(this.baseDir, { recursive: true });
      }
    } catch (e) {
      // Silent — caller can check via _error
      this._error = e.message;
    }
  }

  /**
   * Normalize trace to canonical schema — tolerant cua input variants
   * (PipelineTracer summary vs direct save).
   */
  _normalize(trace) {
    const id = trace.id || trace.traceId;
    if (!id) throw new Error('trace.id required');

    const startedAt = trace.startedAt || trace.startTime || Date.now();
    const endedAt = trace.endedAt ?? trace.endTime ?? null;

    let status = trace.status || 'running';
    // Legacy mapping: PipelineTracer uses 'done' → 'completed'
    if (status === 'done') status = 'completed';
    if (!VALID_STATUS.has(status)) status = 'running';

    const steps = Array.isArray(trace.steps)
      ? trace.steps.map(s => ({
          agent: s.agent || s.agentRole || s.label || s.name || null,
          model: s.model || null,
          tool: s.tool || s.name || null,
          input: s.input ?? s.meta ?? null,
          output: s.output ?? s.result ?? null,
          cost: typeof s.cost === 'number' ? s.cost : 0,
          tokens: typeof s.tokens === 'number'
            ? s.tokens
            : (s.result?.tokens || 0),
          durationMs: s.durationMs ?? s.elapsed_ms ?? null,
          startedAt: s.startedAt ?? s.startTime ?? null,
          endedAt: s.endedAt ?? s.endTime ?? null,
          status: s.status || null,
          error: s.error || null
        }))
      : [];

    const totalCost = typeof trace.totalCost === 'number'
      ? trace.totalCost
      : steps.reduce((a, s) => a + (s.cost || 0), 0);

    const totalTokens = typeof trace.totalTokens === 'number'
      ? trace.totalTokens
      : steps.reduce((a, s) => a + (s.tokens || 0), 0);

    return {
      id,
      startedAt,
      endedAt,
      status,
      task: trace.task || trace.operation || trace.metadata?.prompt || '',
      steps,
      totalCost,
      totalTokens,
      result: trace.result ?? null
    };
  }

  _summaryOf(trace) {
    const taskSummary = typeof trace.task === 'string'
      ? trace.task.slice(0, 200)
      : JSON.stringify(trace.task || {}).slice(0, 200);
    return {
      id: trace.id,
      startedAt: trace.startedAt,
      endedAt: trace.endedAt,
      status: trace.status,
      taskSummary,
      totalCost: trace.totalCost,
      totalTokens: trace.totalTokens,
      steps: trace.steps.length
    };
  }

  /**
   * Luu trace xuong disk + append index entry
   */
  save(trace) {
    const norm = this._normalize(trace);
    const filePath = path.join(this.baseDir, `${norm.id}.json`);

    fs.writeFileSync(filePath, JSON.stringify(norm, null, 2), 'utf-8');

    // Index: neu trace da co entry (update) → ghi them entry moi nhat, consumer lay entry cuoi cho ID
    const summary = this._summaryOf(norm);
    fs.appendFileSync(this.indexPath, JSON.stringify(summary) + '\n', 'utf-8');

    return { id: norm.id, path: filePath };
  }

  /**
   * Lay full trace JSON
   */
  get(traceId) {
    const filePath = path.join(this.baseDir, `${traceId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * Xoa trace (file + entry in index)
   * Index rewrite: filter bo entries matching id
   */
  delete(traceId) {
    const filePath = path.join(this.baseDir, `${traceId}.json`);
    let removedFile = false;
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      removedFile = true;
    }
    this._rewriteIndex(entries => entries.filter(e => e.id !== traceId));
    return { id: traceId, removedFile };
  }

  /**
   * List traces matching filter.
   * @param {Object} opts - { since, until, status, limit }
   * @returns {Array<summary>} newest-first
   */
  list({ since, until, status, limit } = {}) {
    const entries = this._readIndex();
    // Deduplicate by id — keep most recent entry (later append wins)
    const byId = new Map();
    for (const e of entries) {
      byId.set(e.id, e);
    }
    let summaries = Array.from(byId.values());

    if (since) summaries = summaries.filter(e => e.startedAt >= since);
    if (until) summaries = summaries.filter(e => e.startedAt <= until);
    if (status) summaries = summaries.filter(e => e.status === status);

    // Newest first
    summaries.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

    if (typeof limit === 'number' && limit > 0) {
      summaries = summaries.slice(0, limit);
    }
    return summaries;
  }

  /**
   * Xoa bot trace cu — giu lai N moi nhat
   */
  prune(maxCount) {
    if (!Number.isInteger(maxCount) || maxCount < 0) {
      throw new Error('prune(maxCount) requires non-negative integer');
    }
    const all = this.list({});
    if (all.length <= maxCount) return { removed: 0, kept: all.length };

    const keep = new Set(all.slice(0, maxCount).map(e => e.id));
    const toRemove = all.slice(maxCount);
    for (const e of toRemove) {
      const f = path.join(this.baseDir, `${e.id}.json`);
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
    }
    this._rewriteIndex(entries => entries.filter(x => keep.has(x.id)));
    return { removed: toRemove.length, kept: keep.size };
  }

  // === Private helpers ===

  _readIndex() {
    if (!fs.existsSync(this.indexPath)) return [];
    const raw = fs.readFileSync(this.indexPath, 'utf-8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    return out;
  }

  _rewriteIndex(transform) {
    const entries = this._readIndex();
    const next = transform(entries);
    const body = next.map(e => JSON.stringify(e)).join('\n') + (next.length ? '\n' : '');
    // Atomic-ish: write tmp then rename
    const tmp = this.indexPath + '.tmp';
    fs.writeFileSync(tmp, body, 'utf-8');
    fs.renameSync(tmp, this.indexPath);
  }
}

module.exports = { TraceStore };
