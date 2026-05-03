#!/usr/bin/env node
/**
 * RagPromptBuilder — RAG-aware system prompt
 *
 * Ap dung RAG (stack profile + embedding examples + decision hints) trong 2 truong hop:
 *
 * 1. LOCAL model — cutoff kien thuc cu (Qwen 2.5 Coder = Sep 2024), de drift.
 *    Chen stack profile + few-shot examples de model sinh code match convention.
 *
 * 2. STAGE-based (cloud model) — role = scanner/planner/reviewer/debugger/docs.
 *    Cac "thinking stage" can decision hints + project context. Execute stage
 *    (builder/fe-dev/be-dev) SKIP RAG vi chi code gen, RAG them noise.
 *
 * 3. PATTERNS-ONLY (cloud execute stage) — Hermes Brain upgrade.
 *    Cloud models o execute stage nhan established_pattern lessons thay vi full RAG.
 *    Proven patterns la nhung pattern da duoc chung minh qua nhieu lan dung thanh cong.
 *    Skip noisy examples / stack profile — chi inject nuggets co gia tri cao.
 *
 * Trade-off: RAG them ~1-3K token/call. Hieu qua cho weak model (+10-15%),
 * net-negative cho strong model o execute stage (tru patterns da proven).
 */

const fs = require('fs');
const path = require('path');

const LOCAL_MODEL_RE = /^(local-|qwen2?\.?5-coder)/i;
const MIN_SIMILARITY = 0.55;
const DEFAULT_HINTS_PATH = '.orcai/knowledge/graphs/_decision-hints.md';
const MAX_HINTS_CHARS = 3000;
// Stage roles huong loi tu RAG — "thinking" stages. Execute stages bypass.
const RAG_STAGE_ROLES = new Set(['scanner', 'planner', 'reviewer', 'debugger', 'docs']);

class RagPromptBuilder {
  constructor(options = {}) {
    this.projectDir = options.projectDir || process.cwd();
    this.embeddings = options.embeddings || null;
    this.contextManager = options.contextManager || null;
    this.maxExamples = options.maxExamples || 3;
    this.maxProfileChars = options.maxProfileChars || 2000;
    this.minSimilarity = options.minSimilarity || MIN_SIMILARITY;

    // Graph-derived decision hints (Round 3 extension).
    // `hintsPath=null` disables injection; missing file degrades silently.
    this.hintsPath = options.hintsPath === undefined
      ? path.join(this.projectDir, DEFAULT_HINTS_PATH)
      : options.hintsPath;
    this.maxHintsChars = options.maxHintsChars || MAX_HINTS_CHARS;
    this._hintsCache = undefined; // undefined = not loaded, string = cached (possibly '')

    // Metrics — cho agent-loop expose ra ngoai
    // rag_applied_local: RAG do local model (backwards-compat counter)
    // rag_applied_stage: RAG do stage role (scanner/planner/...)
    // rag_applied: tong (giu lai cho backward-compat)
    // rag_applied_patterns: dem so lan patterns_only mode inject duoc it nhat 1 pattern
    this.metrics = {
      rag_applied: 0,
      rag_applied_local: 0,
      rag_applied_stage: 0,
      rag_applied_patterns: 0,
      rag_skipped_cloud: 0,
      rag_fallback_profile_only: 0,
      rag_fallback_none: 0,
      rag_hints_injected: 0
    };

    // Warn once flags
    this._warnedEmbeddings = false;
    this._warnedProfile = false;
    this._warnedHints = false;
  }

  /**
   * Check pattern: "local-*" hoac "qwen2.5-coder-*"
   */
  isLocalModel(modelId) {
    if (!modelId || typeof modelId !== 'string') return false;
    return LOCAL_MODEL_RE.test(modelId);
  }

  /**
   * Check xem role co thuoc "thinking stage" khong (huong loi RAG)
   */
  isStageRole(agentRole) {
    return typeof agentRole === 'string' && RAG_STAGE_ROLES.has(agentRole);
  }

  /**
   * Quyet dinh RAG mode:
   *   'full'          — local model hoac thinking stage: stack profile + examples + patterns
   *   'patterns_only' — cloud execute stage co embed index: chi inject established_patterns
   *   'none'          — skip hoan toan
   *
   * @param {{ modelId?: string, agentRole?: string }} opts
   * @returns {'full'|'patterns_only'|'none'}
   */
  getRagMode({ modelId, agentRole } = {}) {
    const isLocal = this.isLocalModel(modelId);
    const isStageRole = this.isStageRole(agentRole);
    const hasEmbeddings = this.embeddings != null;

    if (isLocal || isStageRole) return 'full';      // full RAG: stack profile + examples + patterns
    if (hasEmbeddings) return 'patterns_only';      // cloud execute: only established_patterns
    return 'none';
  }

  /**
   * Quyet dinh co apply RAG khong — ket hop ca 3 chien luoc:
   * - Local model: ALWAYS apply (backwards-compat)
   * - Stage role: apply ngay ca cloud model
   * - Embed index available: apply cho TAT CA models/roles → context isolated theo topic
   *
   * Giu backward-compat: tra ve { apply: boolean, reason } nhu truoc.
   * Noi bo delegate sang getRagMode() de thong nhat logic.
   *
   * @returns {{ apply: boolean, reason: 'local'|'stage'|'embed'|'patterns'|null }}
   */
  shouldApplyRag({ modelId, agentRole } = {}) {
    if (this.isLocalModel(modelId)) return { apply: true, reason: 'local' };
    if (this.isStageRole(agentRole)) return { apply: true, reason: 'stage' };
    // Neu co embedding index → luon apply de pre-select files lien quan (bat ke model nao)
    if (this.embeddings) return { apply: true, reason: 'embed' };
    return { apply: false, reason: null };
  }

  /**
   * Lay established_pattern entries tu memory file.
   * Dung keyword-overlap don gian (khong can vector DB).
   * Gracefully return [] neu file khong ton tai hoac loi.
   *
   * @param {string} query — task description de score relevance
   * @param {{ limit?: number, projectDir?: string }} opts
   * @returns {Promise<Array>}
   */
  async getEstablishedPatterns(query, { limit = 3, projectDir = null } = {}) {
    try {
      const memoryPath = path.join(
        projectDir || this.projectDir,
        '.orcai', 'memory', 'lessons.jsonl'
      );
      if (!fs.existsSync(memoryPath)) return [];

      const raw = fs.readFileSync(memoryPath, 'utf8').trim();
      if (!raw) return [];

      const lines = raw.split('\n').filter(Boolean);
      const entries = lines
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);

      // Chi lay established_pattern grade
      const patterns = entries.filter(e => e.grade === 'established_pattern');
      if (patterns.length === 0) return [];

      // Simple relevance: keyword overlap voi query (semantic search khong co o day)
      const queryWords = new Set(
        (query || '').toLowerCase().split(/\s+/).filter(w => w.length > 3)
      );

      const scored = patterns.map(e => {
        const text = `${e.summary || ''} ${(e.keywords || []).join(' ')}`.toLowerCase();
        const overlap = [...queryWords].filter(w => text.includes(w)).length;
        return { ...e, _match: overlap };
      });

      // Include all khi corpus nho hoac khong co match nao
      const hasAnyMatch = scored.some(e => e._match > 0);
      const filtered = (hasAnyMatch && patterns.length > 3)
        ? scored.filter(e => e._match > 0)
        : scored;

      filtered.sort((a, b) => b._match - a._match);
      return filtered.slice(0, limit);
    } catch {
      return [];
    }
  }

  /**
   * Build system prompt co RAG context.
   * @param {{basePrompt: string, userMessage: string, modelId: string, agentRole?: string}} args
   * @returns {Promise<string>}
   */
  async build({ basePrompt = '', userMessage = '', modelId = '', agentRole = '' } = {}) {
    const ragMode = this.getRagMode({ modelId, agentRole });

    // --- patterns_only path (cloud execute stage) ---
    if (ragMode === 'patterns_only') {
      const patterns = await this.getEstablishedPatterns(userMessage, { limit: 3 });
      if (patterns.length > 0) {
        const patternBlock = patterns
          .map(p => `• [PROVEN PATTERN] ${p.summary}`)
          .join('\n');
        this.metrics.rag_applied_patterns = (this.metrics.rag_applied_patterns || 0) + 1;
        return (basePrompt ? basePrompt + '\n\n' : '') +
          '## Proven Patterns (from past experience)\n' + patternBlock + '\n';
      }
      // Khong co patterns → skip, ghi counter nhu truoc
      this.metrics.rag_skipped_cloud++;
      return basePrompt;
    }

    // --- none path ---
    if (ragMode === 'none') {
      this.metrics.rag_skipped_cloud++;
      return basePrompt;
    }

    // --- full path (local model hoac thinking stage) ---
    // Determine reason cho _bumpAppliedBy (backward-compat)
    const decision = this.shouldApplyRag({ modelId, agentRole });

    // Fetch stack profile
    let profile = null;
    try {
      profile = this.contextManager?.getStackProfile?.(this.projectDir) || null;
    } catch {
      profile = null;
    }
    if (profile && profile.length > this.maxProfileChars) {
      profile = profile.slice(0, this.maxProfileChars) + '\n... [truncated]';
    }

    // Fetch examples qua embedding search
    let examples = [];
    let embeddingsFailed = false;
    if (this.embeddings && userMessage) {
      try {
        const hits = await this._searchExamples(userMessage);
        examples = (hits || [])
          .filter(h => typeof h.score === 'number' && h.score >= this.minSimilarity)
          .slice(0, this.maxExamples);
      } catch (err) {
        embeddingsFailed = true;
        if (!this._warnedEmbeddings) {
          this._warnedEmbeddings = true;
          console.warn(`[rag] embeddings search failed: ${err.message}`);
        }
      }
    } else if (!this.embeddings) {
      embeddingsFailed = true;
    }

    // Ca 2 fail → return base
    if (!profile && (embeddingsFailed || examples.length === 0)) {
      this.metrics.rag_fallback_none++;
      if (!this._warnedProfile) {
        this._warnedProfile = true;
        console.warn('[rag] no stack profile + no examples → basePrompt unchanged');
      }
      return basePrompt;
    }

    // Co profile nhung khong co examples → profile-only
    if (profile && examples.length === 0) {
      this.metrics.rag_fallback_profile_only++;
      this._bumpAppliedBy(decision.reason);
      return this._composeProfileOnly(basePrompt, profile);
    }

    // Full RAG path
    this._bumpAppliedBy(decision.reason);

    // Append established_patterns vao cuoi full RAG (neu co, de khong lam hong examples)
    const extraPatterns = await this.getEstablishedPatterns(userMessage, { limit: 2 });

    return this._composeFull(basePrompt, profile || '(stack profile unavailable)', examples, extraPatterns);
  }

  /**
   * Helper: tang counter applied voi reason (local vs stage)
   */
  _bumpAppliedBy(reason) {
    this.metrics.rag_applied++;
    if (reason === 'local') this.metrics.rag_applied_local++;
    else if (reason === 'stage') this.metrics.rag_applied_stage++;
    else if (reason === 'embed') this.metrics.rag_applied_embed = (this.metrics.rag_applied_embed || 0) + 1;
  }

  /**
   * Goi embedding store — uu tien .search() (per spec), fallback .query()
   */
  async _searchExamples(query) {
    const emb = this.embeddings;
    if (typeof emb.search === 'function') {
      return await emb.search({ query, topK: this.maxExamples });
    }
    if (typeof emb.query === 'function') {
      return await emb.query({ text: query, top_k: this.maxExamples });
    }
    throw new Error('embeddings missing search/query method');
  }

  /**
   * Load decision-hints file (once). Returns '' on miss/disable.
   */
  _getHints() {
    if (this._hintsCache !== undefined) return this._hintsCache;
    if (!this.hintsPath) { this._hintsCache = ''; return ''; }
    try {
      let txt = fs.readFileSync(this.hintsPath, 'utf8');
      // Strip YAML frontmatter to save tokens — hint content is below it
      txt = txt.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
      if (txt.length > this.maxHintsChars) {
        txt = txt.slice(0, this.maxHintsChars) + '\n... [truncated]';
      }
      this._hintsCache = txt;
    } catch (err) {
      if (!this._warnedHints) {
        this._warnedHints = true;
        console.warn(`[rag] decision-hints load failed: ${err.message}`);
      }
      this._hintsCache = '';
    }
    return this._hintsCache;
  }

  _hintsSection() {
    const h = this._getHints();
    if (!h) return null;
    this.metrics.rag_hints_injected++;
    return ['## DECISION HINTS', h].join('\n');
  }

  _composeProfileOnly(basePrompt, profile) {
    const parts = [basePrompt || '', ''];
    const hints = this._hintsSection();
    if (hints) parts.push(hints, '');
    parts.push(
      '## USER STACK PROFILE', profile, '',
      '## INSTRUCTIONS',
      '- Use the exact framework versions and patterns from the stack profile',
      '- Prefer conventions above over "modern best practice" from training data',
      '- When decision hints apply, follow them verbatim'
    );
    return parts.join('\n').trim();
  }

  /**
   * Compose full RAG context string.
   * @param {string} basePrompt
   * @param {string} profile
   * @param {Array} examples
   * @param {Array} [extraPatterns] — established_patterns de append sau examples
   */
  _composeFull(basePrompt, profile, examples, extraPatterns = []) {
    const formatted = examples.map((ex, i) => {
      const score = (typeof ex.score === 'number' ? ex.score : 0).toFixed(2);
      const code = (ex.text || '').trim();
      return `## Example ${i + 1} (similarity ${score})\n\`\`\`\n${code}\n\`\`\``;
    }).join('\n\n');

    const parts = [basePrompt || '', ''];
    const hints = this._hintsSection();
    if (hints) parts.push(hints, '');
    parts.push(
      '## USER STACK PROFILE', profile, '',
      '## RELEVANT EXAMPLES FROM CODEBASE', formatted, '',
      '## INSTRUCTIONS',
      '- Match the style and conventions shown above',
      '- Use the exact framework versions and patterns from the stack profile',
      '- Prefer reusing patterns from the examples over inventing new ones',
      '- When decision hints apply, follow them verbatim'
    );

    // Append established_patterns neu co (khong trung voi examples)
    if (extraPatterns.length > 0) {
      const patternBlock = extraPatterns
        .map(p => `• [PROVEN PATTERN] ${p.summary}`)
        .join('\n');
      parts.push('', '## Proven Patterns (from past experience)', patternBlock);
    }

    return parts.join('\n').trim();
  }

  /**
   * Snapshot metrics
   */
  getMetrics() {
    return { ...this.metrics };
  }

  resetMetrics() {
    for (const k of Object.keys(this.metrics)) this.metrics[k] = 0;
  }

  /**
   * Reset hint cache. Rarely needed — useful if hints file hot-swapped mid-run.
   */
  reloadHints() {
    this._hintsCache = undefined;
    this._warnedHints = false;
  }
}

module.exports = { RagPromptBuilder, LOCAL_MODEL_RE };
