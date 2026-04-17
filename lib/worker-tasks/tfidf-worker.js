#!/usr/bin/env node
/**
 * TF-IDF Worker — Chay trong worker_threads de offload CPU-bound khoi main
 *
 * Message protocol:
 *   In:  { op: 'search', docs: [{id, text}], query, limit }
 *        { op: 'build',  docs: [{id, text}] }  // khong dung nhieu
 *   Out: search → [{ id, text, _score }, ...]  (top-K, score descending)
 *        build  → { index summary }
 *        error  → { __error: 'message' }
 *
 * Self-contained — khong require module ngoai Node built-in.
 */

const { parentPort } = require('node:worker_threads');

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'or', 'the', 'to', 'of', 'for', 'in', 'on', 'at', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'should', 'could', 'can',
  'that', 'this', 'these', 'those', 'it', 'its', 'from', 'by', 'as',
  'va', 'hoac', 'cua', 'la', 'co', 'khong', 'duoc', 'nay', 'cho', 've'
]);

function tokenize(text) {
  if (!text) return [];
  return String(text).toLowerCase()
    .replace(/[^\w\s\-.]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
}

function buildIndex(docs) {
  const index = { docs: [], df: {}, N: docs.length };
  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    const tf = {};
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
    for (const t of Object.keys(tf)) {
      index.df[t] = (index.df[t] || 0) + 1;
    }
    index.docs.push({
      id: doc.id,
      raw: doc,
      tf,
      length: tokens.length || 1
    });
  }
  return index;
}

function idf(index, token) {
  const df = index.df[token] || 0;
  if (df === 0) return 0;
  return Math.log((index.N + 1) / (df + 1)) + 1;
}

function search(index, query, limit = 5) {
  if (!query || !index || !index.docs.length) return [];
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];
  const qtf = {};
  for (const t of qTokens) qtf[t] = (qtf[t] || 0) + 1;

  const scored = [];
  for (const doc of index.docs) {
    let score = 0;
    for (const [tok, qc] of Object.entries(qtf)) {
      const dc = doc.tf[tok] || 0;
      if (dc === 0) continue;
      const w = idf(index, tok);
      score += (qc * w) * (dc * w);
    }
    if (score === 0) continue;
    const normalized = score / Math.sqrt(doc.length);
    scored.push({ doc: doc.raw, score: normalized });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => ({ ...s.doc, _score: Number(s.score.toFixed(3)) }));
}

parentPort.on('message', (msg) => {
  try {
    if (!msg || typeof msg !== 'object') {
      parentPort.postMessage({ __error: 'Invalid message' });
      return;
    }
    const op = msg.op || (msg.build ? 'build' : 'search');
    if (op === 'build') {
      const index = buildIndex(msg.docs || []);
      parentPort.postMessage({
        N: index.N,
        termCount: Object.keys(index.df).length
      });
      return;
    }
    // default: search
    const index = buildIndex(msg.docs || []);
    const results = search(index, msg.query || '', msg.limit || 5);
    parentPort.postMessage(results);
  } catch (err) {
    parentPort.postMessage({ __error: err && err.message ? err.message : String(err) });
  }
});
