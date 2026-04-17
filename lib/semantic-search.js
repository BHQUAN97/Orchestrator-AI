#!/usr/bin/env node
/**
 * Semantic Search — TF-IDF ranking cho memory/knowledge retrieval
 *
 * Khong can vector DB / embeddings ben ngoai. Dung TF-IDF voi:
 *   - Term frequency per document
 *   - Inverse document frequency across corpus
 *   - Cosine-like similarity
 *
 * Tot hon keyword-overlap cua memory.js truoc:
 *   - Co trong so cho tu hiem (common words bi giam)
 *   - Normalize theo do dai document
 *   - Xu ly n-gram ngan (2-3 chars) cho code symbols
 *
 * Neu co @xenova/transformers (optional) → dung embeddings that su.
 * Neu khong → fallback TF-IDF.
 */

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

/**
 * Build TF-IDF index tu corpus
 * @param {Array<{id, text}>} docs
 */
function buildIndex(docs) {
  const index = {
    docs: [],        // { id, tokens, tf, length }
    df: {},          // token → document frequency
    N: docs.length
  };

  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    const tf = {};
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;

    // Update DF
    for (const t of Object.keys(tf)) {
      index.df[t] = (index.df[t] || 0) + 1;
    }

    index.docs.push({
      id: doc.id,
      raw: doc,
      tokens,
      tf,
      length: tokens.length || 1
    });
  }

  return index;
}

/**
 * Compute IDF for a token
 */
function idf(index, token) {
  const df = index.df[token] || 0;
  if (df === 0) return 0;
  return Math.log((index.N + 1) / (df + 1)) + 1;
}

/**
 * Search query against index. Returns top-K docs with scores.
 */
function search(index, query, limit = 5) {
  if (!query || !index?.docs?.length) return [];
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];

  // Query TF
  const qtf = {};
  for (const t of queryTokens) qtf[t] = (qtf[t] || 0) + 1;

  // Score each doc
  const scored = [];
  for (const doc of index.docs) {
    let score = 0;
    for (const [token, qCount] of Object.entries(qtf)) {
      const dCount = doc.tf[token] || 0;
      if (dCount === 0) continue;
      const idfVal = idf(index, token);
      // tf-idf contribution from both sides
      score += (qCount * idfVal) * (dCount * idfVal);
    }
    if (score === 0) continue;
    // Normalize by doc length
    const normalized = score / Math.sqrt(doc.length);
    scored.push({ doc: doc.raw, score: normalized });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => ({ ...s.doc, _score: Number(s.score.toFixed(3)) }));
}

/**
 * Convenience — search corpus directly (rebuilds index each call)
 * For small corpora (<1000 docs) this is fine.
 */
function searchCorpus(docs, query, limit = 5) {
  const index = buildIndex(docs);
  return search(index, query, limit);
}

module.exports = { buildIndex, search, searchCorpus, tokenize, idf };
